import { describe, expect, it, vi } from 'vitest';
import { ExchangeRates } from './fx.js';

const ok = (v: string) => async () => ({ observations: [{ d: '2026-10-15', FXUSDCAD: { v } }] });

describe('ExchangeRates', () => {
  it('uses the Bank of Canada rate and caches it', async () => {
    const f = vi.fn(ok('1.3712'));
    const fx = new ExchangeRates(1.38, f);
    expect(await fx.usdToCad(0)).toBe(1.3712);
    expect(await fx.usdToCad(60_000)).toBe(1.3712);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('falls back to USD_CAD_RATE, then keeps the last good rate', async () => {
    let fail = true;
    const fx = new ExchangeRates(1.38, async () => {
      if (fail) throw new Error('down');
      return ok('1.36')();
    });
    expect(await fx.usdToCad(0)).toBe(1.38);
    fail = false;
    expect(await fx.usdToCad(11 * 60_000)).toBe(1.36);
    fail = true;
    expect(await fx.usdToCad(7 * 3_600_000)).toBe(1.36);
  });

  it('ignores a nonsense value', async () => {
    expect(await new ExchangeRates(1.38, ok('0')).usdToCad(0)).toBe(1.38);
  });
});
