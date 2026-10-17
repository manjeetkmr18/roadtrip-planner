import { addDays, daysBetween, haversineMeters, parseForecastText, type LatLng, type WeatherAlert, type WeatherObservation } from '../core/index.js';
import { fetchJson, nowIso, ProviderError, TtlCache } from './infra.js';

/**
 * Weather from free sources, best first:
 *  - Canada: Environment and Climate Change Canada, MSC GeoMet OGC API (city forecasts + alerts)
 *  - United States: National Weather Service API (gridpoint forecasts + active alerts)
 *  - Anywhere, up to ~9 days ahead: MET Norway Locationforecast (the yr.no forecast, CC BY 4.0)
 *  - Further ahead: NASA POWER 25-year climate averages for the month ("typical weather"),
 *    labelled as kind "climate" so it's never mistaken for a forecast.
 */

const MSC = 'https://api.weather.gc.ca';
const NWS = 'https://api.weather.gov';
const MET = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
const POWER = 'https://power.larc.nasa.gov/api/temporal/climatology/point';

/** National services forecast ~6 days ahead, MET Norway ~9. */
const NATIONAL_DAYS = 6;
const MET_DAYS = 9;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface MetSeries {
  time: string;
  data: {
    instant: { details: { air_temperature?: number; wind_speed?: number; wind_speed_of_gust?: number; fog_area_fraction?: number } };
    next_1_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number; probability_of_precipitation?: number } };
    next_6_hours?: {
      summary?: { symbol_code?: string };
      details?: { precipitation_amount?: number; probability_of_precipitation?: number; air_temperature_max?: number; air_temperature_min?: number };
    };
  };
}

const SYMBOL_WORDS: [RegExp, string][] = [
  [/thunder/, 'thunderstorms'],
  [/heavysnow/, 'heavy snow'],
  [/sleet/, 'sleet'],
  [/snow/, 'snow'],
  [/heavyrain/, 'heavy rain'],
  [/lightrain/, 'light rain'],
  [/rain/, 'rain'],
  [/fog/, 'fog'],
  [/partlycloudy/, 'partly cloudy'],
  [/cloudy/, 'cloudy'],
  [/fair/, 'mostly sunny'],
  [/clearsky/, 'sunny'],
];
const symbolWord = (code: string) => SYMBOL_WORDS.find(([re]) => re.test(code))?.[1] ?? code.replace(/_.*/, '');

/** MET Norway hourly/6-hourly series → one day's observation (local day by longitude, daytime 8–20 h). */
export function metDay(series: MetSeries[], date: string, lng: number, place: string): WeatherObservation | undefined {
  const offset = Math.round(lng / 15);
  const local = series.map((t) => {
    const d = new Date(Date.parse(t.time) + offset * 3_600_000);
    return { t, date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
  });
  const day = local.filter((x) => x.date === date);
  if (!day.length) return undefined;
  const daytime = day.filter((x) => x.hour >= 8 && x.hour <= 20);
  const use = daytime.length ? daytime : day;
  const temps = day.map((x) => x.t.data.instant.details.air_temperature).filter((v): v is number => v != null);
  const six = day.map((x) => x.t.data.next_6_hours?.details).filter(Boolean);
  temps.push(...six.flatMap((d) => [d!.air_temperature_max, d!.air_temperature_min]).filter((v): v is number => v != null));
  const symbols = use.map((x) => x.t.data.next_1_hours?.summary?.symbol_code ?? x.t.data.next_6_hours?.summary?.symbol_code).filter((v): v is string => !!v);
  const pops = use.map((x) => x.t.data.next_1_hours?.details?.probability_of_precipitation ?? x.t.data.next_6_hours?.details?.probability_of_precipitation).filter((v): v is number => v != null);
  const wind = use.map((x) => x.t.data.instant.details.wind_speed ?? 0);
  const gust = use.map((x) => x.t.data.instant.details.wind_speed_of_gust ?? 0);
  const fog = use.some((x) => (x.t.data.instant.details.fog_area_fraction ?? 0) >= 50) || symbols.some((s) => s.startsWith('fog'));
  // The most significant condition of the daytime, then the most common one.
  const ranked = [...new Set(symbols.map(symbolWord))];
  // Only rain, snow, storms and fog count as the day's "worst" condition; cloud is just the backdrop.
  const worst = SYMBOL_WORDS.slice(0, 8).map(([, w]) => w).find((w) => ranked.includes(w));
  const common = ranked.sort((a, b) => symbols.filter((s) => symbolWord(s) === b).length - symbols.filter((s) => symbolWord(s) === a).length)[0];
  const summary = worst && worst !== common ? `${cap(common)}, ${worst} at times` : cap(worst ?? common ?? 'No details');
  const anyWet = symbols.some((s) => /rain|snow|sleet|thunder/.test(s));
  return {
    date,
    place,
    kind: 'forecast',
    summary,
    highC: temps.length ? Math.round(Math.max(...temps)) : null,
    lowC: temps.length ? Math.round(Math.min(...temps)) : null,
    precipChancePct: pops.length ? Math.round(Math.max(...pops)) : anyWet ? 60 : 0,
    snow: symbols.some((s) => /snow|sleet/.test(s)),
    thunder: symbols.some((s) => s.includes('thunder')),
    fog,
    windKmh: Math.round(Math.max(0, ...wind) * 3.6),
    gustKmh: Math.max(...gust) > 0 ? Math.round(Math.max(...gust) * 3.6) : null,
    alerts: [],
    source: { name: 'MET Norway (yr.no), CC BY 4.0', url: 'https://www.yr.no', retrievedAt: nowIso() },
  };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** NASA POWER monthly normals → "typical weather" for a date. */
export function climateDay(v: { T2M?: number; T2M_RANGE?: number; PRECTOTCORR?: number; FROST_DAYS?: number }, date: string, place: string): WeatherObservation {
  const m = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10));
  const when = `${day <= 10 ? 'early' : day <= 20 ? 'mid' : 'late'} ${MONTH_NAMES[m]}`;
  const high = v.T2M != null && v.T2M_RANGE != null ? Math.round(v.T2M + v.T2M_RANGE / 2) : null;
  const low = v.T2M != null && v.T2M_RANGE != null ? Math.round(v.T2M - v.T2M_RANGE / 2) : null;
  const daysInMonth = new Date(Date.UTC(2001, m + 1, 0)).getUTCDate();
  const frostShare = v.FROST_DAYS != null ? v.FROST_DAYS / daysInMonth : low != null && low <= 0 ? 0.6 : 0;
  const mm = v.PRECTOTCORR ?? 0;
  const parts = [`highs about ${high}°, lows about ${low}°`];
  if (frostShare >= 0.5) parts.push('frost most nights');
  else if (frostShare >= 0.15) parts.push('frost some nights');
  parts.push(mm >= 4 ? 'often wet' : mm >= 2 ? 'showers on some days' : 'mostly dry');
  if (low != null && low <= 0 && mm >= 1) parts.push('snow is possible');
  return {
    date,
    place,
    kind: 'climate',
    summary: `${cap(parts.join(', '))} (typical for ${when})`,
    highC: high,
    lowC: low,
    precipChancePct: null,
    snow: low != null && low <= 0 && mm >= 1,
    alerts: [],
    source: { name: 'NASA POWER 25-year climate averages', url: 'https://power.larc.nasa.gov', retrievedAt: nowIso() },
  };
}

interface MscForecast {
  period: { textForecastName: { en: string }; value: { en: string } };
  textSummary?: { en: string };
  abbreviatedForecast?: { textSummary?: { en: string } };
  temperatures?: { temperature?: { class: { en: string }; value: { en: number } }[] };
  winds?: { periods?: { speed?: { value: { en: number } }; gust?: { value: { en: number } } }[] };
}
interface MscCity {
  geometry: { coordinates: [number, number] };
  properties: {
    name: { en: string };
    url?: { en: string };
    forecastGroup?: { timestamp?: { en: string }; forecasts?: MscForecast[] };
  };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function localIssueDate(isoUtc: string, lng: number): string {
  const offsetHours = Math.round(lng / 15); // ≈ local solar offset, good enough for date mapping
  return new Date(Date.parse(isoUtc) + offsetHours * 3_600_000).toISOString().slice(0, 10);
}

function dateForWeekday(issueDate: string, weekday: string): string | undefined {
  const target = WEEKDAYS.indexOf(weekday.toLowerCase());
  if (target < 0) return undefined;
  for (let i = 0; i < 8; i++) {
    const d = addDays(issueDate, i);
    if (new Date(`${d}T12:00:00Z`).getUTCDay() === target) return d;
  }
  return undefined;
}

function alertSeverity(text: string): WeatherAlert['severity'] {
  const t = text.toLowerCase();
  if (t.includes('warning')) return 'warning';
  if (t.includes('watch')) return 'watch';
  if (t.includes('advisory')) return 'advisory';
  if (t.includes('statement')) return 'statement';
  return 'other';
}

export class WeatherProvider {
  private cityCache = new TtlCache<MscCity[]>(30 * 60_000);
  private nwsCache = new TtlCache<unknown>(30 * 60_000);
  /** Points the US service said it doesn't cover (outside the US), so they aren't asked again. */
  private nwsNotCovered = new Set<string>();
  private metCache = new TtlCache<MetSeries[]>(30 * 60_000);
  private climateCache = new TtlCache<Record<string, Record<string, number>>>(7 * 24 * 3_600_000);

  constructor(private readonly nwsUserAgent: string) {}

  /**
   * Weather for one place and date: the national forecast (with official alerts) where there is
   * one, else MET Norway's worldwide forecast, else typical weather for the time of year.
   */
  async observe(p: LatLng, date: string, placeLabel: string): Promise<WeatherObservation> {
    const ahead = daysBetween(new Date().toISOString().slice(0, 10), date);
    if (ahead < 0) return { date, place: placeLabel, kind: 'unavailable', summary: 'This date has passed', alerts: [] };
    if (ahead <= NATIONAL_DAYS) {
      // South of ~49°N (and in Alaska) ask the US service first: it answers "not covered" for Canadian
      // points, whereas Environment Canada would happily match a US place to a Canadian city nearby
      // (Buffalo → Fort Erie) and miss the US alerts.
      const usFirst = p.lat < 49.1 || p.lng < -129;
      const msc = () => this.fromMsc(p, date, placeLabel);
      const nws = () => this.fromNws(p, date, placeLabel);
      for (const source of usFirst ? [nws, msc] : [msc, nws]) {
        try {
          const o = await source();
          if (o?.kind === 'forecast') return o;
        } catch {
          /* try the next source */
        }
      }
    }
    if (ahead <= MET_DAYS) {
      try {
        const o = await this.fromMet(p, date, placeLabel);
        if (o) return o;
      } catch {
        /* fall back to typical weather */
      }
    }
    try {
      return await this.typical(p, date, placeLabel);
    } catch {
      return { date, place: placeLabel, kind: 'unavailable', summary: 'No forecast yet; refresh closer to the date', alerts: [] };
    }
  }

  private async fromMet(p: LatLng, date: string, placeLabel: string): Promise<WeatherObservation | undefined> {
    const lat = p.lat.toFixed(3);
    const lng = p.lng.toFixed(3);
    const series = await this.metCache.get(`${lat},${lng}`, async () => {
      const res = await fetchJson<{ properties: { timeseries: MetSeries[] } }>('MET Norway', `${MET}?lat=${lat}&lon=${lng}`, {
        headers: { 'User-Agent': this.nwsUserAgent },
        timeoutMs: 10_000,
      });
      return res.properties?.timeseries ?? [];
    });
    return metDay(series, date, p.lng, placeLabel);
  }

  private async typical(p: LatLng, date: string, placeLabel: string): Promise<WeatherObservation> {
    const lat = p.lat.toFixed(1);
    const lng = p.lng.toFixed(1);
    const params = await this.climateCache.get(`${lat},${lng}`, async () => {
      const res = await fetchJson<{ properties: { parameter: Record<string, Record<string, number>> } }>(
        'NASA POWER',
        `${POWER}?parameters=T2M,T2M_RANGE,PRECTOTCORR,FROST_DAYS&community=AG&latitude=${lat}&longitude=${lng}&format=JSON`,
        { timeoutMs: 12_000 },
      );
      return res.properties.parameter;
    });
    const m = MONTHS[Number(date.slice(5, 7)) - 1];
    const pick = (k: string) => (params[k]?.[m] != null && params[k][m] > -900 ? params[k][m] : undefined);
    return climateDay({ T2M: pick('T2M'), T2M_RANGE: pick('T2M_RANGE'), PRECTOTCORR: pick('PRECTOTCORR'), FROST_DAYS: pick('FROST_DAYS') }, date, placeLabel);
  }

  private async nearestCity(p: LatLng): Promise<MscCity | undefined> {
    const pad = 0.8;
    const key = `${p.lat.toFixed(1)},${p.lng.toFixed(1)}`;
    const cities = await this.cityCache.get(key, async () => {
      const url = `${MSC}/collections/citypageweather-realtime/items?f=json&lang=en&limit=20&bbox=${p.lng - pad},${p.lat - pad},${p.lng + pad},${p.lat + pad}`;
      const res = await fetchJson<{ features: MscCity[] }>('Environment Canada', url);
      return res.features ?? [];
    });
    let best: MscCity | undefined;
    let bestD = Infinity;
    for (const c of cities) {
      const d = haversineMeters(p, { lat: c.geometry.coordinates[1], lng: c.geometry.coordinates[0] });
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return bestD <= 80_000 ? best : undefined;
  }

  private async mscAlerts(p: LatLng): Promise<WeatherAlert[]> {
    const pad = 0.25;
    const url = `${MSC}/collections/weather-alerts/items?f=json&limit=20&bbox=${p.lng - pad},${p.lat - pad},${p.lng + pad},${p.lat + pad}`;
    const res = await fetchJson<{ features: { properties: Record<string, string> }[] }>('Environment Canada alerts', url);
    const seen = new Set<string>();
    const out: WeatherAlert[] = [];
    for (const f of res.features ?? []) {
      const pr = f.properties;
      const title = pr.alert_name_en ?? pr.alert_short_name_en ?? 'Weather alert';
      if (seen.has(title)) continue;
      seen.add(title);
      out.push({
        title: title.charAt(0).toUpperCase() + title.slice(1),
        severity: alertSeverity(pr.alert_type ?? title),
        issuedBy: 'Environment and Climate Change Canada',
        updatedAt: pr.publication_datetime,
        url: 'https://weather.gc.ca/warnings/index_e.html',
      });
    }
    return out;
  }

  private async fromMsc(p: LatLng, date: string, placeLabel: string): Promise<WeatherObservation | undefined> {
    if (p.lat < 41.6) return undefined;
    const city = await this.nearestCity(p);
    if (!city?.properties.forecastGroup?.forecasts?.length) return undefined;
    const fg = city.properties.forecastGroup;
    const issue = localIssueDate(fg.timestamp?.en ?? nowIso(), p.lng);
    const forDate: MscForecast[] = [];
    for (const f of fg.forecasts ?? []) {
      const name = f.period.textForecastName.en.toLowerCase();
      const d = name === 'today' || name === 'tonight' ? issue : dateForWeekday(issue, f.period.value.en.split(' ')[0]);
      if (d === date) forDate.push(f);
    }
    if (!forDate.length) return { date, place: placeLabel, kind: 'unavailable', summary: 'Not yet in the forecast', alerts: [] };

    // Driving happens in daylight: rate the day from the daytime period, keep the night for the low.
    const dayPeriod = forDate.find((f) => !/night/i.test(f.period.textForecastName.en)) ?? forDate[0];
    const text = dayPeriod.textSummary?.en ?? '';
    const nightText = forDate.filter((f) => f !== dayPeriod).map((f) => f.textSummary?.en ?? '').join(' ');
    const hints = parseForecastText(text);
    const nightSnow = !hints.snow && parseForecastText(nightText).snow;
    const temps = forDate.flatMap((f) => f.temperatures?.temperature ?? []);
    const high = temps.find((t) => t.class.en === 'high')?.value.en ?? null;
    const low = temps.find((t) => t.class.en === 'low')?.value.en ?? null;
    const gusts = [dayPeriod].flatMap((f) => f.winds?.periods ?? []).map((w) => Math.max(w.gust?.value.en ?? 0, w.speed?.value.en ?? 0));
    const alerts = date === issue || daysBetween(issue, date) <= 1 ? await this.mscAlerts(p).catch(() => []) : [];
    return {
      date,
      place: `${placeLabel} (forecast for ${city.properties.name.en})`,
      kind: 'forecast',
      summary: `${dayPeriod.abbreviatedForecast?.textSummary?.en ?? text.slice(0, 120)}${nightSnow ? '; possible snow overnight' : ''}`,
      highC: high,
      lowC: low,
      precipChancePct: hints.precipChancePct,
      snow: hints.snow,
      thunder: hints.thunder,
      fog: hints.fog,
      windKmh: gusts.length ? Math.max(...gusts) : null,
      gustKmh: hints.gustKmh ?? (gusts.length ? Math.max(...gusts) : null),
      alerts,
      source: { name: 'Environment and Climate Change Canada (MSC GeoMet)', url: city.properties.url?.en, retrievedAt: nowIso() },
    };
  }

  private nwsFetch<T>(url: string): Promise<T> {
    return this.nwsCache.get(url, () =>
      fetchJson<T>('National Weather Service', url, { headers: { 'User-Agent': this.nwsUserAgent, Accept: 'application/geo+json' } }),
    ) as Promise<T>;
  }

  private async fromNws(p: LatLng, date: string, placeLabel: string): Promise<WeatherObservation | undefined> {
    const lat = p.lat.toFixed(4);
    const lng = p.lng.toFixed(4);
    const cell = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
    if (this.nwsNotCovered.has(cell)) return undefined;
    let point: { properties: { forecast: string } };
    try {
      point = await this.nwsFetch<{ properties: { forecast: string } }>(`${NWS}/points/${lat},${lng}`);
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) {
        if (this.nwsNotCovered.size > 5000) this.nwsNotCovered.clear();
        this.nwsNotCovered.add(cell);
        return undefined;
      }
      throw e;
    }
    const fc = await this.nwsFetch<{
      properties: {
        periods: {
          startTime: string;
          isDaytime: boolean;
          temperature: number;
          temperatureUnit: string;
          probabilityOfPrecipitation?: { value: number | null };
          windSpeed: string;
          shortForecast: string;
          detailedForecast: string;
        }[];
      };
    }>(point.properties.forecast);
    const periods = fc.properties.periods.filter((x) => x.startTime.slice(0, 10) === date);
    if (!periods.length) return { date, place: placeLabel, kind: 'unavailable', summary: 'Not yet in the forecast', alerts: [] };
    const toC = (t: number, unit: string) => (unit === 'F' ? Math.round(((t - 32) * 5) / 9) : t);
    const day = periods.find((x) => x.isDaytime) ?? periods[0];
    const night = periods.find((x) => !x.isDaytime);
    // Rate the day from the daytime period (when people drive); the night only sets the low.
    const hints = parseForecastText(day.detailedForecast);
    const nightSnow = !hints.snow && !!night && parseForecastText(night.detailedForecast).snow;
    const winds = [day].map((x) => Math.max(...(x.windSpeed.match(/\d+/g) ?? ['0']).map(Number)) * 1.609);
    const pop = day.probabilityOfPrecipitation?.value ?? 0;

    let alerts: WeatherAlert[] = [];
    if (daysBetween(new Date().toISOString().slice(0, 10), date) <= 1) {
      const a = await this.nwsFetch<{ features: { properties: { event: string; senderName: string; sent: string; areaDesc: string; '@id'?: string } }[] }>(
        `${NWS}/alerts/active?point=${lat},${lng}`,
      ).catch(() => ({ features: [] }));
      alerts = a.features.map((f) => ({
        title: f.properties.event,
        severity: alertSeverity(f.properties.event),
        area: f.properties.areaDesc,
        issuedBy: f.properties.senderName ?? 'National Weather Service',
        updatedAt: f.properties.sent,
        url: f.properties['@id'],
      }));
    }
    return {
      date,
      place: placeLabel,
      kind: 'forecast',
      summary: `${day.shortForecast}${nightSnow ? '; possible snow overnight' : ''}`,
      highC: day.isDaytime ? toC(day.temperature, day.temperatureUnit) : null,
      lowC: night ? toC(night.temperature, night.temperatureUnit) : null,
      precipChancePct: pop || hints.precipChancePct,
      snow: hints.snow,
      thunder: hints.thunder,
      fog: hints.fog,
      windKmh: Math.round(Math.max(...winds)),
      gustKmh: hints.gustKmh,
      alerts,
      source: { name: 'US National Weather Service', url: `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lng}`, retrievedAt: nowIso() },
    };
  }
}
