import type { EnergyPriceRange, FuelType } from '../core/index.js';
import { fetchJson, nowIso, ProviderContext, TtlCache } from './infra.js';

// ---------------- Fuel and charging prices ----------------

/**
 * Defaults used when no fuel-price key is configured. They are rough planning
 * figures, labelled as such in the cost report; set OILPRICEAPI_KEY (Canada, by province)
 * and EIA_API_KEY (US, weekly) for current prices.
 */
const DEFAULTS = {
  CA: { gasoline: 1.55, diesel: 1.7, electricity: { low: 0.12, typical: 0.3, high: 0.6 } },
  US: { gasoline: 3.3 / 3.785, diesel: 3.9 / 3.785, electricity: { low: 0.1, typical: 0.25, high: 0.5 } },
} as const;

const PROVINCES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'ON', 'PE', 'QC', 'SK']);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export class FuelPriceProvider {
  private cache = new TtlCache<number | undefined>(6 * 60 * 60_000);
  constructor(
    private readonly oilPriceKey?: string,
    private readonly eiaKey?: string,
  ) {}

  async range(country: string | undefined, region: string | undefined, fuelType: FuelType, ctx: ProviderContext): Promise<EnergyPriceRange> {
    const cc: 'CA' | 'US' = country === 'US' ? 'US' : 'CA';
    const currency = cc === 'US' ? 'USD' : 'CAD';
    if (fuelType === 'electric') {
      const e = DEFAULTS[cc].electricity;
      return {
        ...e,
        currency,
        unit: 'kWh',
        confidence: 'approximate',
        note: 'home charging (low) to DC fast charging (high); check your network’s rates',
        source: { name: 'Planning default', retrievedAt: nowIso() },
      };
    }
    const fuel = fuelType === 'diesel' ? 'diesel' : 'gasoline';
    let price: number | undefined;
    let source = { name: 'Planning default (set a fuel price key for current prices)', url: undefined as string | undefined, retrievedAt: nowIso() };

    try {
      if (cc === 'CA' && this.oilPriceKey && fuel === 'gasoline') {
        const code = PROVINCES.has(region ?? '') ? `GASOLINE_RETAIL_CA_${region}_CAD` : 'GASOLINE_RETAIL_CA_CAD';
        price = await this.cache.get(code, async () => {
          const res = await fetchJson<{ data?: { price?: number; formatted?: string; unit?: string } | { price?: number }[] }>(
            'OilPriceAPI',
            `https://api.oilpriceapi.com/v1/prices/latest?by_code=${code}`,
            { headers: { Authorization: `Token ${this.oilPriceKey}` } },
          );
          const d = Array.isArray(res.data) ? res.data[0] : res.data;
          const v = d?.price;
          return v == null ? undefined : v > 20 ? v / 100 : v; // cents/L → $/L
        });
        source = { name: `OilPriceAPI (${code}, Natural Resources Canada data)`, url: 'https://www.oilpriceapi.com/gasoline-prices/canada', retrievedAt: nowIso() };
      } else if (cc === 'US' && this.eiaKey) {
        const product = fuel === 'diesel' ? 'EPD2D' : 'EPMR';
        const key = `eia-${product}`;
        price = await this.cache.get(key, async () => {
          const url =
            `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${this.eiaKey}&frequency=weekly&data[0]=value` +
            `&facets[product][]=${product}&facets[duoarea][]=NUS&sort[0][column]=period&sort[0][direction]=desc&length=1`;
          const res = await fetchJson<{ response?: { data?: { value: string }[] } }>('EIA', url);
          const v = Number(res.response?.data?.[0]?.value);
          return Number.isFinite(v) && v > 0 ? v / 3.785 : undefined; // $/gal → $/L
        });
        source = { name: 'US Energy Information Administration, weekly retail (US average)', url: 'https://www.eia.gov/petroleum/gasdiesel/', retrievedAt: nowIso() };
      }
    } catch {
      ctx.note('Fuel price lookup failed; using planning defaults.');
      price = undefined;
    }

    const live = price != null;
    const base = price ?? DEFAULTS[cc][fuel];
    if (!live) ctx.note('Fuel prices use planning defaults; add OILPRICEAPI_KEY / EIA_API_KEY for current prices.');
    return {
      low: round3(base * 0.94),
      typical: round3(base),
      high: round3(base * 1.1),
      currency,
      unit: 'L',
      confidence: 'approximate',
      note: live ? 'regional average; stations vary ±6–10%' : 'planning default, not a current price',
      source,
    };
  }
}
