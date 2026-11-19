// NORM-2.0 (SRS 4.9.0 §12.3): deterministic normalisation of a WORD quantity (1..999) to a digit string, with evidence.
// Port of the specification oracle tools/norm_reference.py; validated against its test vectors (fixtures/norm_vectors.json).
export const NORM_VERSION = "NORM-2.0";

const UNITS_M: Record<string, number> = { "אחד": 1, "שניים": 2, "שנים": 2, "שני": 2, "שלושה": 3, "ארבעה": 4, "חמישה": 5, "שישה": 6, "שבעה": 7, "שמונה": 8, "תשעה": 9, "עשרה": 10 };
const UNITS_F: Record<string, number> = { "אחת": 1, "שתיים": 2, "שתים": 2, "שתי": 2, "שלוש": 3, "ארבע": 4, "חמש": 5, "שש": 6, "שבע": 7, "שמונה": 8, "תשע": 9, "עשר": 10 };
const UNITS: Record<string, number> = { ...UNITS_M, ...UNITS_F };
const TEEN_BASE: Record<string, number> = { "אחד": 1, "אחת": 1, "שנים": 2, "שתים": 2, "שלושה": 3, "שלוש": 3, "ארבעה": 4, "ארבע": 4, "חמישה": 5, "חמש": 5, "שישה": 6, "שש": 6, "שבעה": 7, "שבע": 7, "שמונה": 8, "תשעה": 9, "תשע": 9 };
const TEN_WORD = new Set(["עשר", "עשרה"]);
const TENS: Record<string, number> = { "עשרים": 20, "שלושים": 30, "ארבעים": 40, "חמישים": 50, "שישים": 60, "שבעים": 70, "שמונים": 80, "תשעים": 90 };
const HUND_SINGLE: Record<string, number> = { "מאה": 100, "מאתיים": 200 };
const HUND_COUNT: Record<string, number> = { "שלוש": 3, "ארבע": 4, "חמש": 5, "שש": 6, "שבע": 7, "שמונה": 8, "תשע": 9 };
const NUMBER_TOKENS = new Set([...Object.keys(UNITS), ...Object.keys(TENS), ...Object.keys(HUND_SINGLE), "מאות", ...TEN_WORD]);
const PREFIXES = "ובכלמשה";

const stripVav = (t: string): string => (t.length > 2 && t[0] === "ו" && NUMBER_TOKENS.has(t.slice(1)) ? t.slice(1) : t);

/** Cardinals 1..999 in the supported grammar; anything unsupported or ambiguous -> null (fail safe). */
export function parseNumber(tokens: string[]): number | null {
  const toks = tokens.map(stripVav);
  if (toks.length === 0) return null;
  let total = 0, i = 0, cls = 3; // 3 hundreds, 2 tens/teens, 1 units: must strictly decrease
  while (i < toks.length) {
    const t = toks[i]!;
    const nxt = toks[i + 1];
    if (Object.hasOwn(HUND_SINGLE, t) && cls >= 3) { total += HUND_SINGLE[t]!; cls = 2; i += 1; }
    else if (Object.hasOwn(HUND_COUNT, t) && nxt === "מאות" && cls >= 3) { total += HUND_COUNT[t]! * 100; cls = 2; i += 2; }
    else if (Object.hasOwn(TEEN_BASE, t) && nxt !== undefined && TEN_WORD.has(nxt) && cls >= 2) { total += TEEN_BASE[t]! + 10; cls = 0; i += 2; }
    else if (Object.hasOwn(TENS, t) && cls >= 2) { total += TENS[t]!; cls = 1; i += 1; }
    else if (TEN_WORD.has(t) && cls >= 2) { total += 10; cls = 0; i += 1; }
    else if (Object.hasOwn(UNITS, t) && cls >= 1) { total += UNITS[t]!; cls = 0; i += 1; }
    else return null;
  }
  return total >= 1 && total <= 999 ? total : null;
}

const matchTok = (tok: string, name: string | null | undefined): boolean =>
  !!name && (tok === name || (tok.length > 1 && PREFIXES.includes(tok[0]!) && tok.slice(1) === name));

function runs(tokens: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < tokens.length) {
    if (NUMBER_TOKENS.has(stripVav(tokens[i]!))) {
      let j = i;
      while (j < tokens.length && NUMBER_TOKENS.has(stripVav(tokens[j]!))) j++;
      out.push([i, j]);
      i = j;
    } else i++;
  }
  return out;
}

export type NormReason = "NORM-QTY" | "NOT_APPLICABLE" | "NOT_APPLICABLE_DIGITS" | "UNSUPPORTED_EXPRESSION" | "NO_EVIDENCE" | "ITEM_OR_UNIT_MISMATCH" | "AMBIGUOUS_MULTIPLE" | "VALUE_QUOTE_CONFLICT";

/** Only a word-expression quantity is ever converted. Digits are never touched (QTY-R2). */
export function normalizeQuantity(value: string | null, quote: string | null, itemName: string, unit: string | null = null): { value: string | null; reason: NormReason } {
  if (value === null) return { value: null, reason: "NOT_APPLICABLE" };
  if (/^[0-9]+(\.[0-9]+)?$/.test(value.trim())) return { value: null, reason: "NOT_APPLICABLE_DIGITS" };
  const n = parseNumber(value.split(/\s+/).filter(Boolean));
  if (n === null) return { value: null, reason: "UNSUPPORTED_EXPRESSION" };
  if (!quote) return { value: null, reason: "NO_EVIDENCE" };
  const qt = quote.replace(/[,.]/g, " ").split(/\s+/).filter(Boolean);
  const anchor = unit ? unit : itemName;
  const hits: number[] = [];
  for (const [a, b] of runs(qt)) {
    if (b < qt.length && matchTok(qt[b]!, anchor)) {
      const m = parseNumber(qt.slice(a, b));
      if (m !== null) hits.push(m);
    }
  }
  if (hits.length === 0) {
    return { value: null, reason: runs(qt).some(([a, b]) => parseNumber(qt.slice(a, b)) !== null) ? "ITEM_OR_UNIT_MISMATCH" : "NO_EVIDENCE" };
  }
  if (new Set(hits).size > 1 || hits.length > 1) return { value: null, reason: "AMBIGUOUS_MULTIPLE" };
  if (hits[0] !== n) return { value: null, reason: "VALUE_QUOTE_CONFLICT" };
  return { value: String(n), reason: "NORM-QTY" };
}

/** The ONLY limit on quantity: the canonical field pattern (QTY-R1). NORM adds no business limit. */
export const contractOk = (s: string | null): boolean => s !== null && /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,3})?$/.test(s);

/**
 * Applies NORM-2.0 to a working copy of an extraction document (SALV-R3: before any AI retry, no AI cost).
 * Only `spare_parts[].quantity` values that are word expressions are touched. Returns the field names that were converted
 * (NORM-QTY) and whether any quantity had to be rejected (set to null, marked for correction).
 */
export function applyQuantityNormalization(doc: any): { normalized: number; rejected: number } {
  const ef = doc?.extracted_fields?.spare_parts;
  const parts = ef?.value;
  if (!Array.isArray(parts)) return { normalized: 0, rejected: 0 };
  const quote: string | null = doc.field_states?.spare_parts?.evidence_quote ?? null;
  let normalized = 0, rejected = 0;
  for (const p of parts) {
    if (typeof p?.quantity !== "string" || contractOk(p.quantity)) continue; // digits (or absent): pass through untouched
    const r = normalizeQuantity(p.quantity, quote, String(p.name ?? ""), p.unit ?? null);
    if (r.reason === "NORM-QTY" && contractOk(r.value)) { p.quantity = r.value; normalized++; }
    else { p.quantity = null; rejected++; }
  }
  return { normalized, rejected };
}
