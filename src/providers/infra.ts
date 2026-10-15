/**
 * Shared plumbing for provider adapters: HTTP with timeouts/retries, a per-generation
 * spend meter, and a context that records which providers fell back to sample data.
 */

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly status?: number,
  ) {
    super(`${provider}: ${message}`);
  }
}

export async function fetchJson<T>(
  provider: string,
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number } = {},
): Promise<T> {
  const { timeoutMs = 15_000, retries = 1, ...rest } = init;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...rest, signal: ctrl.signal });
      if (res.ok) return (await res.json()) as T;
      const body = await res.text().catch(() => '');
      const err = new ProviderError(provider, `HTTP ${res.status} ${body.slice(0, 300)}`, res.status);
      if (res.status === 429 || res.status >= 500) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw err;
    } catch (e) {
      if (e instanceof ProviderError && e.status && e.status < 500 && e.status !== 429) throw e;
      lastErr = e instanceof Error && e.name === 'AbortError' ? new ProviderError(provider, `timed out after ${timeoutMs} ms`) : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new ProviderError(provider, String(lastErr));
}

/**
 * List prices in USD per 1,000 calls (or per million tokens for models), used to estimate
 * what each generated trip costs. Free monthly allowances are ignored, so this is conservative.
 * Verify against current price lists: https://developers.google.com/maps/billing-and-pricing/pricing
 */
export const PRICING_USD = {
  geocoding: 5 / 1000,
  routesEssentials: 5 / 1000,
  /** Toll calculation puts a request in Compute Routes Enterprise (Google SKU details). */
  routesWithTolls: 15 / 1000,
  /** Text Search with opening hours + rating fields is billed as Enterprise. Verify. */
  placesTextSearchEnterprise: 35 / 1000,
  tollguru: 80 / 5000,
} as const;

/** Per-token model prices, read lazily so .env is loaded first. Defaults match Claude Sonnet-class pricing. */
const llmPrice = (fast = false) =>
  fast
    ? {
        // Defaults match Claude Haiku-class pricing.
        input: Number(process.env.LLM_FAST_INPUT_USD_PER_MTOK ?? 0.1) / 1_000_000,
        output: Number(process.env.LLM_FAST_OUTPUT_USD_PER_MTOK ?? 0.5) / 1_000_000,
      }
    : {
        input: Number(process.env.LLM_INPUT_USD_PER_MTOK ?? 2) / 1_000_000,
        output: Number(process.env.LLM_OUTPUT_USD_PER_MTOK ?? 10) / 1_000_000,
      };

export type MeterKey = keyof typeof PRICING_USD;

export class ProviderContext {
  readonly calls: Record<string, number> = {};
  private usd = 0;
  readonly notes = new Set<string>();
  usedSampleData = false;

  record(key: MeterKey, count = 1) {
    this.calls[key] = (this.calls[key] ?? 0) + count;
    this.usd += PRICING_USD[key] * count;
  }

  recordTokens(input: number, output: number, fast = false) {
    this.calls.llmInputTokens = (this.calls.llmInputTokens ?? 0) + input;
    this.calls.llmOutputTokens = (this.calls.llmOutputTokens ?? 0) + output;
    const p = llmPrice(fast);
    this.usd += input * p.input + output * p.output;
  }

  sample(note: string) {
    this.usedSampleData = true;
    this.notes.add(note);
  }

  note(note: string) {
    this.notes.add(note);
  }

  get costUsd() {
    return Math.round(this.usd * 10_000) / 10_000;
  }
}

export const nowIso = () => new Date().toISOString();

/** Tiny in-memory TTL cache for open-data feeds (advisories, 511 events). */
export class TtlCache<T> {
  private store = new Map<string, { at: number; value: T }>();
  constructor(private readonly ttlMs: number) {}
  async get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = await load();
    this.store.set(key, { at: Date.now(), value });
    return value;
  }
}
