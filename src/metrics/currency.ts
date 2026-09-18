// What currency the prices in PointCloudLabeler are in.
//
// Every price the app takes is a number the user types — a stumpage
// price per cubic metre — and every revenue figure is that number
// multiplied by a volume. PointCloudLabeler printed all of them with a hardcoded
// "€": in the Bucking panel, in the Thinning panel's estimate, in the
// CSV column names (`sawlog_eur`, `total_eur`) and in the plot report's
// revenue card.
//
// The arithmetic was never wrong. The label was, everywhere outside the
// euro area — a forester in Chile pricing at 35000 CLP/m³ got a
// client-facing report claiming euros, and the CSV column said so too.
// The report is a deliverable somebody else reads; a figure carrying
// the wrong currency is a false statement about money, not a cosmetic
// slip, and nothing in the numbers reveals it.
//
// So it is a setting: free text, because there are more currencies than
// anyone should enumerate and a forester knows their own. Default "€",
// which keeps every existing project reading exactly as it did.
//
// Stored in localStorage under a key mirrored to settings.json (see
// persistence/settingsStore.ts's PERSISTED_KEYS), so it survives a
// WebView2 profile reset like every other preference.

export const CURRENCY_KEY = 'pointcloudlabeler-currency';
export const DEFAULT_CURRENCY = '€';

/** Longest symbol/code accepted. "kr", "CHF", "US$", "R$" all fit;
 *  this only exists so a paste accident cannot put a paragraph into a
 *  table cell. */
export const MAX_CURRENCY_LEN = 8;

/** Trim, cap the length, and fall back to the default when what is left
 *  is empty — a blank field must not silently produce unlabelled money.
 *  Total by construction: every input maps to a usable symbol. */
export function normaliseCurrency(raw: string | null | undefined): string {
  const t = (raw ?? '').trim();
  if (!t) return DEFAULT_CURRENCY;
  return t.slice(0, MAX_CURRENCY_LEN);
}

export function getCurrency(): string {
  try {
    return normaliseCurrency(localStorage.getItem(CURRENCY_KEY));
  } catch {
    // Private mode / storage disabled — the default is still correct.
    return DEFAULT_CURRENCY;
  }
}

export function setCurrency(raw: string): string {
  const value = normaliseCurrency(raw);
  try {
    localStorage.setItem(CURRENCY_KEY, value);
  } catch {
    /* preference just doesn't persist */
  }
  return value;
}

/** A currency as a CSV column-name fragment: `sawlog_revenue_usd`.
 *
 *  A symbol is not a column name — "€" and "R$" are not safe in a
 *  header a spreadsheet or an R script will parse, and two currencies
 *  whose symbols differ only in punctuation would collide. So the
 *  fragment is ASCII letters only, lowercased, and anything with none
 *  (a bare "€", "¥", "₪") falls back to the neutral "revenue" rather
 *  than to a guess at which currency that symbol means. The header then
 *  says what the column IS; the report and the panels carry the symbol
 *  itself. */
export function currencyCsvSuffix(currency: string): string {
  const letters = currency.replace(/[^A-Za-z]/g, '').toLowerCase();
  return letters ? `revenue_${letters}` : 'revenue';
}
