import { z } from 'zod';
import { DEFAULT_VISIT_MINUTES, distanceToRoute, fractionAlong, type LatLng, type Pace, type Stop } from '../core/index.js';
import type { CandidatePlace } from '../providers/google.js';
import type { Llm } from '../providers/llm.js';
import { nowIso, type ProviderContext } from '../providers/infra.js';

const QUERY_TAG: Record<string, string> = {
  'scenic nature park': 'Nature',
  'top tourist attractions': 'Famous',
  museum: 'Museum',
  'historic site': 'History',
  'famous local restaurant': 'Food',
  beach: 'Beach',
  'hiking trail': 'Hiking',
  'scenic viewpoint': 'Viewpoint',
  'family attraction': 'Family',
  'landmark architecture': 'Architecture',
  'shopping district': 'Shopping',
  'live music venue': 'Nightlife',
};

/** Short labels for a stop: the interest it matched, plus "Fuel stop" for gas stations. */
export function stopTags(query: string, types: string[]): string[] {
  const tags = [QUERY_TAG[query] ?? query.replace(/^\w/, (c) => c.toUpperCase())];
  if (types.includes('gas_station')) tags.push('Fuel stop');
  return tags;
}

/** Map user interests to place search queries (at most `max`). */
export function interestQueries(interests: string[], max = 2): string[] {
  const map: Record<string, string> = {
    nature: 'scenic nature park',
    'famous attractions': 'top tourist attractions',
    attractions: 'top tourist attractions',
    museums: 'museum',
    history: 'historic site',
    'food discovery': 'famous local restaurant',
    food: 'famous local restaurant',
    beaches: 'beach',
    hiking: 'hiking trail',
    photography: 'scenic viewpoint',
    'scenic routes': 'scenic viewpoint',
    family: 'family attraction',
    'family activities': 'family attraction',
    architecture: 'landmark architecture',
    shopping: 'shopping district',
    nightlife: 'live music venue',
  };
  const qs = [...new Set(interests.map((i) => map[i.toLowerCase()] ?? i.toLowerCase()))];
  return (qs.length ? qs : ['top tourist attractions']).slice(0, max);
}

export interface RankedCandidate {
  place: CandidatePlace;
  score: number;
  routeFraction: number;
  detourMinutes: number;
}

/** Deterministic ranking: popularity (rating × review volume), minus detour. */
export function rankCandidates(cands: CandidatePlace[], dayLine: LatLng[] | null, maxDetourMinutes = 90): RankedCandidate[] {
  const seen = new Set<string>();
  const out: RankedCandidate[] = [];
  for (const c of cands) {
    const nameKey = c.name.trim().toLowerCase();
    if (seen.has(c.id) || seen.has(nameKey)) continue;
    seen.add(c.id);
    seen.add(nameKey);
    if ((c.ratingCount ?? 0) < 20 && !c.sample) continue; // too obscure to recommend
    const offRouteM = dayLine ? distanceToRoute(dayLine, c.location) : 0;
    const detourMinutes = dayLine ? Math.round(((2 * offRouteM) / 1000 / 60) * 60) : 0; // there and back at ~60 km/h
    const popularity = (c.rating ?? 4) * Math.log10((c.ratingCount ?? 10) + 10);
    out.push({
      place: c,
      score: Math.round((popularity - detourMinutes / 15) * 100) / 100,
      routeFraction: dayLine ? fractionAlong(dayLine, c.location) : 0.5,
      detourMinutes,
    });
  }
  return out.filter((r) => r.detourMinutes <= maxDetourMinutes).sort((a, b) => b.score - a.score);
}

export function toStop(r: RankedCandidate, freeDay: boolean): Stop {
  const c = r.place;
  return {
    id: c.id,
    name: c.name,
    kind: 'attraction',
    location: c.location,
    placeId: c.sample ? undefined : c.id,
    description: [c.address, c.types.slice(0, 2).map((t) => t.replace(/_/g, ' ')).join(', ')].filter(Boolean).join(' · ') || undefined,
    rating: c.rating,
    ratingCount: c.ratingCount,
    visitMinutes: DEFAULT_VISIT_MINUTES.attraction,
    openingHours: c.openingHours,
    routeFraction: freeDay ? undefined : Math.round(r.routeFraction * 1000) / 1000,
    detourMinutes: freeDay ? 0 : r.detourMinutes,
    mapsUrl: c.mapsUrl,
    tags: stopTags(c.query, c.types),
    source: c.sample ? { name: 'Sample placeholder', retrievedAt: nowIso() } : { name: 'Google Places', url: c.mapsUrl, retrievedAt: nowIso() },
  };
}

export interface DayChoiceInput {
  day: number;
  date: string;
  from: string;
  to: string;
  drivingHours: number;
  budget: number;
  /** Stops the traveller added that this day passes through. */
  via?: string[];
  weatherHeadline?: string;
  /** Local sunset time at the day's end place (creator mode). */
  sunset?: string;
  candidates: RankedCandidate[];
}

export interface DayChoice {
  ids: string[];
  narrative: string;
  title: string;
  creatorTip?: string;
  byModel: boolean;
}

/** Template title used when the model is off: "On to Ottawa" or "A day in Ottawa". */
export function templateTitle(d: Pick<DayChoiceInput, 'from' | 'to' | 'drivingHours'>): string {
  const town = (s: string) => s.replace(/^near /, '').split(',')[0];
  return d.drivingHours > 0 ? `On to ${town(d.to)}` : `A day in ${town(d.to)}`;
}

const LlmChoice = z.object({
  days: z.array(
    z.object({
      day: z.number(),
      stopIds: z.array(z.string()),
      narrative: z.string().max(600),
      title: z.string().max(60).optional(),
      creatorTip: z.string().max(300).optional(),
    }),
  ),
});

/** Candidates sent to the model per day. Days have at most a few stops, so the top 8 are plenty. */
const LLM_CANDIDATES_PER_DAY = 8;

const SYSTEM = `You arrange road-trip days for a planning app. Rules:
- Choose stops ONLY from the candidate list given for that day, by id. Never invent places.
- Respect each day's stop budget (maximum number of stops). Fewer is fine.
- Prefer variety (not several near-identical stops) and the traveller's interests.
- Prefer stops that are open and suit the weather headline when one is given.
- Narrative: 1–2 plain sentences per day. Mention only the chosen stops, the "via" places and the start/end places given.
  Do not state prices, distances, times, opening hours, or safety claims; the app shows those from data.
- Title: a short name for each day (2–4 words) from its places or scenery, e.g. "Lake Superior shore". No dates or numbers.
- If creatorMode is true, add creatorTip: one sentence naming the best chosen stop for photos or video and when to film it
  (use the given sunset time), ending with "Park before filming." Otherwise omit creatorTip.
- Reply with JSON only, matching: {"days":[{"day":1,"title":"...","stopIds":["..."],"narrative":"...","creatorTip":"..."}]}`;

/** Ask the model to choose and describe stops; fall back to the deterministic ranking if anything is off. */
export async function chooseStops(
  days: DayChoiceInput[],
  ctx: { interests: string[]; pace: Pace; llm: Llm; provider: ProviderContext; creatorMode?: boolean },
): Promise<Map<number, DayChoice>> {
  const fallback = new Map<number, DayChoice>();
  for (const d of days) {
    const chosen = d.candidates.slice(0, d.budget);
    const ids = chosen.map((c) => c.place.id);
    // Name stops in the order they're driven past.
    const names = [...chosen].sort((a, b) => a.routeFraction - b.routeFraction).map((c) => c.place.name);
    const via = d.via?.length ? ` via ${d.via.join(' and ')}` : '';
    const narrative =
      d.drivingHours > 0
        ? `Drive from ${d.from} to ${d.to}${via}${names.length ? `, with stops at ${names.join(', ')}` : ''}.`
        : `A day around ${d.to}${names.length ? `: ${names.join(', ')}` : ' to explore at your own pace'}.`;
    fallback.set(d.day, { ids, narrative, title: templateTitle(d), byModel: false });
  }
  if (!ctx.llm.enabled) {
    ctx.provider.note('Day descriptions are template text (Bedrock not configured).');
    return fallback;
  }

  const payload = {
    interests: ctx.interests,
    pace: ctx.pace,
    creatorMode: !!ctx.creatorMode,
    days: days.map((d) => ({
      day: d.day,
      date: d.date,
      from: d.from,
      to: d.to,
      drivingHours: Math.round(d.drivingHours * 10) / 10,
      stopBudget: d.budget,
      via: d.via,
      weather: d.weatherHeadline,
      sunset: ctx.creatorMode ? d.sunset : undefined,
      candidates: d.candidates.slice(0, LLM_CANDIDATES_PER_DAY).map((c) => ({
        id: c.place.id,
        name: c.place.name,
        types: c.place.types.slice(0, 3),
        rating: c.place.rating,
        reviews: c.place.ratingCount,
        detourMin: c.detourMinutes,
        positionAlongDay: Math.round(c.routeFraction * 100) / 100,
      })),
    })),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await ctx.llm.complete({ system: SYSTEM, prompt: JSON.stringify(payload), maxTokens: 1500, fast: true }, ctx.provider);
      const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      const parsed = LlmChoice.parse(JSON.parse(json));
      const out = new Map(fallback);
      for (const d of parsed.days) {
        const input = days.find((x) => x.day === d.day);
        if (!input) continue;
        const allowed = new Set(input.candidates.map((c) => c.place.id));
        const ids = [...new Set(d.stopIds)].filter((id) => allowed.has(id)).slice(0, input.budget);
        out.set(d.day, {
          ids,
          narrative: d.narrative.trim(),
          title: d.title?.trim() || templateTitle(input),
          creatorTip: ctx.creatorMode ? d.creatorTip?.trim() || undefined : undefined,
          byModel: true,
        });
      }
      return out;
    } catch (e) {
      if (attempt === 1) ctx.provider.note(`AI arrangement failed, used ranking instead: ${(e as Error).message.slice(0, 100)}`);
    }
  }
  return fallback;
}
