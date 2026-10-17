import { Logger } from '@nestjs/common';
import { fetchJson } from './infra.js';

const VALET_URL = 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1';
const FRESH_MS = 6 * 60 * 60 * 1000; // the Bank publishes one rate per business day
const RETRY_MS = 10 * 60 * 1000; // after a failed fetch, wait this long before trying again

interface ValetResponse {
  observations?: { d: string; FXUSDCAD?: { v: string } }[];
}

/**
 * USD → CAD rate from the Bank of Canada's official daily rate (free, no key), used to convert
 * US fuel prices and fares. Cached in memory; falls back to the last good rate, then to
 * USD_CAD_RATE, so a trip is never held up by the feed.
 */
export class ExchangeRates {
  private readonly log = new Logger(ExchangeRates.name);
  private rate?: { value: number; date: string; at: number };
  private failedAt = -Infinity;
  private inflight?: Promise<number>;

  constructor(
    private readonly fallback: number,
    private readonly fetcher: (url: string) => Promise<ValetResponse> = (url) => fetchJson<ValetResponse>('Bank of Canada', url, { timeoutMs: 5_000, retries: 0 }),
  ) {}

  /** Canadian dollars per US dollar. Never throws. */
  async usdToCad(now = Date.now()): Promise<number> {
    if (this.rate && now - this.rate.at < FRESH_MS) return this.rate.value;
    if (now - this.failedAt < RETRY_MS) return this.rate?.value ?? this.fallback;
    this.inflight ??= this.load(now).finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async load(now: number): Promise<number> {
    try {
      const obs = (await this.fetcher(VALET_URL)).observations?.at(-1);
      const value = Number(obs?.FXUSDCAD?.v);
      // Sanity range so a malformed response can never wreck the cost estimates.
      if (!obs || !Number.isFinite(value) || value < 0.8 || value > 2.5) throw new Error(`unexpected rate ${obs?.FXUSDCAD?.v}`);
      this.rate = { value, date: obs.d, at: now };
      return value;
    } catch (e) {
      this.failedAt = now;
      this.log.warn(`USD/CAD rate unavailable, using ${this.rate ? 'last known' : 'USD_CAD_RATE'}: ${(e as Error).message.slice(0, 120)}`);
      return this.rate?.value ?? this.fallback;
    }
  }
}
