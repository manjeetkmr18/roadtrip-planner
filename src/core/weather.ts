import type { DayWeatherReview, WeatherObservation, WeatherRating } from './types.js';

/**
 * Turns forecasts for the places a day passes through into a plain rating and
 * concrete suggestions. Ratings describe the forecast only; we never say a road is safe.
 */

const ORDER: Record<WeatherRating, number> = { unknown: -1, favourable: 0, mixed: 1, poor: 2 };

export interface ObservationAssessment {
  rating: WeatherRating;
  /** Conditions worth mentioning, e.g. "Rain likely (80%)". */
  conditions: string[];
  /** Full reasons with the place, e.g. "Rain likely (80%) — Ottawa, ON (forecast for Ottawa)". */
  reasons: string[];
}

/** Short place for headlines: drops "(forecast for …)" and shortens "en route (A → B)". */
export function shortPlace(place: string): string {
  if (place.startsWith('en route')) return 'en route';
  return place.replace(/ \(forecast for .*\)$/, '');
}

/** "A", "A and b", "A, b and c". */
function joinConditions(items: string[]): string {
  const [first, ...rest] = items;
  const tail = rest.map((x) => x.charAt(0).toLowerCase() + x.slice(1));
  if (!tail.length) return first;
  return `${[first, ...tail.slice(0, -1)].join(', ')} and ${tail[tail.length - 1]}`;
}

export function assessObservation(o: WeatherObservation): ObservationAssessment {
  if (o.kind !== 'forecast') return { rating: 'unknown', conditions: [], reasons: [] };
  const conditions: string[] = [];
  let rating: WeatherRating = 'favourable';
  const bump = (r: WeatherRating, why: string) => {
    conditions.push(why);
    if (ORDER[r] > ORDER[rating]) rating = r;
  };
  const pop = o.precipChancePct ?? 0;

  for (const a of o.alerts) {
    if (a.severity === 'warning') bump('poor', `${a.title} in effect (${a.issuedBy})`);
    else if (a.severity === 'watch' || a.severity === 'advisory') bump('mixed', `${a.title} (${a.issuedBy})`);
  }
  if (o.snow && pop >= 60) bump('poor', `Snow likely (${pop}% chance)`);
  else if (o.snow) bump('mixed', 'Possible snow');
  if (o.thunder && pop >= 70) bump('poor', 'Thunderstorms likely');
  else if (o.thunder) bump('mixed', 'Risk of thunderstorms');
  if (!o.snow && pop >= 70) bump('mixed', `Rain likely (${pop}%)`);
  else if (!o.snow && pop >= 40) bump('mixed', `${pop}% chance of rain`);
  const gust = o.gustKmh ?? o.windKmh ?? 0;
  if (gust >= 70) bump('poor', `Gusts near ${gust} km/h`);
  else if (gust >= 50) bump('mixed', `Gusty wind (${gust} km/h)`);
  if (o.fog) bump('mixed', 'Fog');
  if (o.highC != null && o.highC >= 33) bump('mixed', `Hot: high of ${o.highC}°C`);
  if (o.lowC != null && o.lowC <= -15) bump('mixed', `Very cold: low of ${o.lowC}°C`);
  if (o.lowC != null && o.lowC <= 0 && pop >= 50 && !o.snow) bump('mixed', 'Freezing temperatures with precipitation');
  return { rating, conditions, reasons: conditions.map((c) => `${c} — ${o.place}`) };
}

export function reviewDay(args: {
  date: string;
  observations: WeatherObservation[];
  hasOutdoorStops: boolean;
  drivingHours: number;
}): DayWeatherReview {
  const { observations } = args;
  const assessed = observations.map(assessObservation);
  const forecasts = observations.filter((o) => o.kind === 'forecast');

  if (forecasts.length === 0) {
    const climate = observations.find((o) => o.kind === 'climate');
    return {
      date: args.date,
      rating: 'unknown',
      headline: climate
        ? `Outside the forecast window — typical for this time of year: ${climate.summary ?? 'see details'}. We'll switch to the real forecast when it's available.`
        : 'No forecast available yet. Refresh closer to departure.',
      observations,
      suggestions: ['Refresh the plan 72 hours and 24 hours before this day to get the actual forecast.'],
    };
  }

  let rating: WeatherRating = 'favourable';
  // Group conditions by place so the headline names each place once: "Rain likely (80%) and fog — Ottawa, ON".
  const byPlace = new Map<string, string[]>();
  for (let i = 0; i < assessed.length; i++) {
    const a = assessed[i];
    if (ORDER[a.rating] > ORDER[rating]) rating = a.rating;
    if (!a.conditions.length) continue;
    const place = shortPlace(observations[i].place);
    const list = byPlace.get(place) ?? [];
    for (const c of a.conditions) if (!list.includes(c)) list.push(c);
    byPlace.set(place, list);
  }
  const reasons = [...byPlace].map(([place, conds]) => `${joinConditions(conds.slice(0, 3))} — ${place}`);

  const suggestions: string[] = [];
  const any = (f: (o: WeatherObservation) => boolean) => forecasts.some(f);
  if (any((o) => !!o.snow)) {
    suggestions.push('Snow in the forecast: allow extra driving time, check road conditions before leaving, and consider a buffer night.');
  }
  if (any((o) => !!o.fog)) suggestions.push('Fog is forecast: a later start can help it lift before the highway stretches.');
  if (any((o) => (o.precipChancePct ?? 0) >= 60) && args.hasOutdoorStops) {
    suggestions.push('Rain is likely: consider moving outdoor stops to a drier day or swapping in indoor attractions.');
  }
  if (any((o) => (o.highC ?? -99) >= 33)) suggestions.push('Hot day: plan indoor stops for mid-afternoon and carry water.');
  if (any((o) => (o.gustKmh ?? o.windKmh ?? 0) >= 50)) suggestions.push('Strong gusts: take extra care on open highway and bridges.');
  if (rating === 'poor' && args.drivingHours >= 5) {
    suggestions.push('Long driving day with poor weather: consider leaving earlier or splitting this leg.');
  }
  if (forecasts.some((o) => o.alerts.length)) {
    suggestions.push('Official alerts are active along this day’s route; follow instructions from the issuing authority.');
  }

  const headline =
    rating === 'favourable'
      ? 'Favourable (per forecast): no significant weather expected along this day’s route.'
      : rating === 'mixed'
        ? `Mixed (per forecast): ${reasons.slice(0, 2).join('; ')}.`
        : `Poor (per forecast): ${reasons.slice(0, 2).join('; ')}.`;

  return { date: args.date, rating, headline, observations, suggestions: [...new Set(suggestions)] };
}

/** Trip-level hint: which day is best for outdoor plans. */
export function bestOutdoorDay(reviews: DayWeatherReview[]): string | undefined {
  const ranked = reviews.filter((r) => r.rating !== 'unknown').sort((a, b) => ORDER[a.rating] - ORDER[b.rating]);
  return ranked[0]?.date;
}

/** Extract hints from a free-text forecast (Environment Canada and NWS both publish text). */
export function parseForecastText(text: string): {
  precipChancePct: number | null;
  snow: boolean;
  thunder: boolean;
  fog: boolean;
  gustKmh: number | null;
} {
  const t = text.toLowerCase();
  const pct = t.match(/(\d{1,3})\s*(?:percent|%)\s*chance/) ?? t.match(/chance of [a-z ]+?is (\d{1,3})%/);
  const gust = t.match(/gust(?:ing|s)?\s*(?:to|up to|as high as)?\s*(\d{2,3})\s*(km\/h|mph)?/);
  let gustKmh: number | null = null;
  if (gust) gustKmh = gust[2] === 'mph' ? Math.round(Number(gust[1]) * 1.609) : Number(gust[1]);
  let precip: number | null = pct ? Number(pct[1]) : null;
  if (precip == null) {
    if (/\b(rain|showers|snow|flurries|drizzle)\b/.test(t) && !/chance|risk|possib/.test(t)) precip = 80;
    else if (/slight chance/.test(t)) precip = 20;
    else if (/\bchance of\b|possib|risk of/.test(t)) precip = 40;
  }
  return {
    precipChancePct: precip,
    snow: /\b(snow|flurries|blizzard|ice pellets|freezing rain|sleet)\b/.test(t),
    thunder: /thunder/.test(t),
    fog: /\bfog\b/.test(t),
    gustKmh,
  };
}
