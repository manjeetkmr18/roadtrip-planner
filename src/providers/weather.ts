import { addDays, daysBetween, haversineMeters, parseForecastText, type LatLng, type WeatherAlert, type WeatherObservation } from '../core/index.js';
import { fetchJson, nowIso, TtlCache } from './infra.js';

/**
 * Weather from official, free sources:
 *  - Canada: Environment and Climate Change Canada, MSC GeoMet OGC API (city forecasts + alerts)
 *  - United States: National Weather Service API (gridpoint forecasts + active alerts)
 * Forecasts cover ~6–7 days; later dates are returned as kind "unavailable" so the review
 * can say so plainly and ask for a refresh closer to departure.
 */

const MSC = 'https://api.weather.gc.ca';
const NWS = 'https://api.weather.gov';

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

  constructor(private readonly nwsUserAgent: string) {}

  /** Forecast for one place and date, from whichever national service covers it. */
  async observe(p: LatLng, date: string, placeLabel: string): Promise<WeatherObservation> {
    const ahead = daysBetween(new Date().toISOString().slice(0, 10), date);
    if (ahead > 6 || ahead < 0) {
      return { date, place: placeLabel, kind: 'unavailable', summary: 'Outside the forecast window', alerts: [] };
    }
    try {
      const msc = await this.fromMsc(p, date, placeLabel);
      if (msc) return msc;
    } catch {
      /* fall through to NWS */
    }
    try {
      const nws = await this.fromNws(p, date, placeLabel);
      if (nws) return nws;
    } catch {
      /* unavailable */
    }
    return { date, place: placeLabel, kind: 'unavailable', summary: 'No forecast source covers this location', alerts: [] };
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
    const point = await this.nwsFetch<{ properties: { forecast: string } }>(`${NWS}/points/${lat},${lng}`);
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
