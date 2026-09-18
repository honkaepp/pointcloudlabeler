import { describe, it, expect } from 'vitest';
import { describeHits, scanSources } from '../testing/sourceScan';
import {
  normaliseCurrency, currencyCsvSuffix, DEFAULT_CURRENCY, MAX_CURRENCY_LEN,
} from './currency';

/** The euro sign, spelled so this file does not match its own scan
 *  below — the same trap every source-scanning test here has to dodge. */
const EURO = String.fromCharCode(0x20ac);

describe('the currency a price is in', () => {
  it('falls back to the default rather than to nothing', () => {
    // A blank field must not produce unlabelled money: "1 234 /ha" reads
    // as a typo, and "1 234" reads as whatever the reader assumes.
    for (const blank of ['', '   ', '\t', null, undefined]) {
      expect(normaliseCurrency(blank)).toBe(DEFAULT_CURRENCY);
    }
    expect(DEFAULT_CURRENCY).toBe(EURO);
  });

  it('keeps what the user typed, trimmed and bounded', () => {
    expect(normaliseCurrency('  USD ')).toBe('USD');
    expect(normaliseCurrency('kr')).toBe('kr');
    expect(normaliseCurrency('R$')).toBe('R$');
    expect(normaliseCurrency('CHF')).toBe('CHF');
    // Case is the user's business — "kr" and "Kr" are both real.
    expect(normaliseCurrency('Kr')).toBe('Kr');
    // A paste accident cannot put a paragraph into a table cell.
    const long = 'X'.repeat(200);
    expect(normaliseCurrency(long)).toHaveLength(MAX_CURRENCY_LEN);
  });

  it('names a CSV money column after letters, never after a symbol', () => {
    // A header a spreadsheet or an R script has to parse. Symbols are
    // not column names, and two currencies whose symbols differ only in
    // punctuation would collide.
    expect(currencyCsvSuffix('USD')).toBe('revenue_usd');
    expect(currencyCsvSuffix('kr')).toBe('revenue_kr');
    expect(currencyCsvSuffix('CHF')).toBe('revenue_chf');
    expect(currencyCsvSuffix('R$')).toBe('revenue_r');
    // Nothing to spell it with → the neutral name, NOT a guess at which
    // currency a bare symbol means. The euro sign is used by one
    // currency; the dollar sign by more than twenty.
    expect(currencyCsvSuffix(EURO)).toBe('revenue');
    expect(currencyCsvSuffix('$')).toBe('revenue');
    expect(currencyCsvSuffix('¥')).toBe('revenue');
    // And the result is always a usable identifier.
    for (const c of [EURO, '$', 'USD', 'R$', '¥', 'kr']) {
      expect(currencyCsvSuffix(c)).toMatch(/^[a-z_]+$/);
    }
  });
});

/** The defect this setting exists for was not that the euro was the
 *  wrong default — it is a fine default. It was that the symbol was
 *  written into a dozen places as a literal, so a forester in Chile
 *  pricing at 35000 CLP/m³ got a client-facing report claiming euros,
 *  a CSV column named `total_eur`, and no way to say otherwise.
 *
 *  This scans the SHIPPING source. Its job is to stop the next literal,
 *  which is how the first twelve got there. */
describe('no shipping file states a currency of its own', () => {
  it('writes no hardcoded currency symbol outside currency.ts', () => {
    // currency.ts is where the default is DEFINED — exactly one place in
    // the app may name a currency, and this is it.
    const hits = scanSources('src', EURO, f => f.endsWith(`${'currency'}.ts`));
    expect(
      hits,
      `these state a currency instead of reading the setting:\n${describeHits(hits)}`,
    ).toEqual([]);
  });

  it('names no money column after a fixed currency', () => {
    // `total_eur` in a CSV of Chilean pesos is a file that lies to
    // whatever reads it next.
    const hits = scanSources('src', new RegExp(`_${'eur'}\\b|_${'usd'}\\b`, 'i'),
      f => f.endsWith(`${'currency'}.ts`));
    expect(hits, `fixed-currency identifiers:\n${describeHits(hits)}`).toEqual([]);
  });
});
