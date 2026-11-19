import type { Presented } from "./controls.ts";

/** Three display states only (SRS 4.2.7 / GAP-03-L): value, empty, "לא ברור". */
export type Shown = "VALUE" | "EMPTY" | "UNCLEAR";
export interface StoredField {
  shown: Shown;
  text: string; // exactly what the technician sees after the label
  value?: unknown; // kept ONLY when the field is VERIFIED (needed for M-2 / merge); never a transcript fragment or quote
}
export type StoredFields = Record<string, StoredField>;

export const FIELD_LABELS: Array<[string, string]> = [
  ["customer_name", "לקוח"], ["customer_address", "כתובת"], ["customer_phone", "טלפון"], ["customer_external_number", "מספר לקוח"],
  ["visit_date_statement", "תאריך ביקור"], ["work_summary", "מה בוצע ומה סוכם"], ["spare_parts", "חלקי חילוף"],
  ["parts_price", "מחיר חלקים"], ["visit_price", "מחיר ביקור"], ["next_visit", "ביקור הבא"],
];
const VAT_OF: Record<string, string> = { parts_price: "parts_vat_basis", visit_price: "visit_vat_basis" };
const DAY_PART: Record<string, string> = { MORNING: "בבוקר", NOON: "בצהריים", EVENING: "בערב" };

function fmtValue(k: string, v: any): string {
  if (v === null || v === undefined) return "";
  if (k === "spare_parts" && Array.isArray(v)) {
    return v.length === 0 ? "ללא חלקים" : v.map((p: any) => [p.name, p.quantity ? `× ${p.quantity}${p.unit ? " " + p.unit : ""}` : ""].filter(Boolean).join(" ")).join(", ");
  }
  if ((k === "parts_price" || k === "visit_price") && typeof v === "object") return `${v.amount} ₪`;
  if ((k === "visit_date_statement") && typeof v === "object") return String(v.date ?? v.expression);
  if (k === "next_visit" && typeof v === "object") {
    return [v.description ?? v.expression ?? v.date, v.day_part ? DAY_PART[v.day_part] : "", v.time ?? ""].filter(Boolean).join(" ");
  }
  return String(v);
}

/** Future-action text for BA-03 ("נדרשה החלפת X, לא ידוע אם בוצעה"), taken from the summary items the model produced. */
function futureActionNote(doc: any): string | null {
  const items = doc.field_states?.work_summary?.summary_items;
  const f = Array.isArray(items) ? items.find((i: any) => i.kind === "FUTURE_ACTION") : null;
  return f ? String(f.text) : null;
}

/** Maps the controls' classification to the three display states; nothing is guessed or completed. */
export function toStoredFields(p: Presented, rejectedFields: string[]): StoredFields {
  const out: StoredFields = {};
  for (const [k] of FIELD_LABELS) {
    const ef = p.displayed.extracted_fields[k];
    const pres = p.presentation[k];
    const cls = rejectedFields.includes(k) ? "REJECTED_INFERENCE" : pres.class;
    if (cls === "VERIFIED" && ef.evidence_state === "PRESENT") {
      let text = fmtValue(k, ef.value);
      const vk = VAT_OF[k];
      if (vk) {
        const vp = p.presentation[vk];
        const vef = p.displayed.extracted_fields[vk];
        if (vp.class === "VERIFIED" && vef.value === "INCLUDED") text += " כולל מע״מ";
        else if (vp.class === "VERIFIED" && vef.value === "EXCLUDED") text += " לא כולל מע״מ";
        else if (vef.evidence_state === "UNCLEAR" || vp.class === "REJECTED_INFERENCE" || vp.class === "HUMAN_CONFIRM") text += " (מע״מ: לא ברור)";
      }
      out[k] = { shown: "VALUE", text, value: ef.value };
    } else if (ef.evidence_state === "NOT_DECIDED") {
      out[k] = { shown: "VALUE", text: "טרם נקבע" }; // M-1: said explicitly, shown as a value
    } else if (cls === "REJECTED_INFERENCE") {
      out[k] = { shown: "UNCLEAR", text: "לא ברור — לתיקון" };
    } else if (cls === "HUMAN_CONFIRM") {
      const sug = fmtValue(k, ef.value);
      out[k] = { shown: "UNCLEAR", text: sug ? `לא ברור — ייתכן ${sug}` : "לא ברור" }; // suggestion only inside the marker (M-1)
    } else if (cls === "UNCLEAR") {
      const note = k === "spare_parts" ? futureActionNote(p.displayed) : null;
      out[k] = { shown: "UNCLEAR", text: note ? `לא ברור — ${note}` : "לא ברור" };
    } else {
      out[k] = { shown: "EMPTY", text: "—" };
    }
  }
  return out;
}

/** M-2 (approved): a form with missing fields is approvable if it has a customer name and at least an address or a phone. */
export function approvability(fields: StoredFields): { ok: boolean; missing: string[] } {
  const has = (k: string) => fields[k]?.shown === "VALUE" && typeof fields[k]?.value === "string" && String(fields[k]!.value).trim() !== "";
  const missing: string[] = [];
  if (!has("customer_name")) missing.push("שם לקוח");
  if (!has("customer_address") && !has("customer_phone")) missing.push("כתובת או טלפון");
  return { ok: missing.length === 0, missing };
}

/** SALV-R11: only fields that are VERIFIED in the new extraction replace the old ones; everything else keeps its previous state. */
export function mergePatch(prev: StoredFields, patch: StoredFields): { fields: StoredFields; changed: string[] } {
  const fields: StoredFields = { ...prev };
  const changed: string[] = [];
  for (const [k, f] of Object.entries(patch)) {
    if (f.shown === "VALUE" && f.value !== undefined && JSON.stringify(prev[k]?.value) !== JSON.stringify(f.value)) {
      fields[k] = f;
      changed.push(k);
    }
  }
  return { fields, changed };
}

export function formatDate(d: Date): string {
  return new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" }).format(d).replaceAll("/", ".");
}

export interface RenderInput { number: number; revision: number; fields: StoredFields; captureDate: string; partial: boolean; mockWatermark: boolean }

/** MSG-02 (+ MSG-39 for partial forms). The visit date defaults to the capture date (SRS 4.3 / D1). */
export function renderForm(r: RenderInput): string {
  const name = r.fields.customer_name?.shown === "VALUE" ? r.fields.customer_name.text : "לקוח לא צוין";
  const lines = [`טופס #${r.number} · ${name} · ${r.captureDate} · גרסה ${r.revision}`];
  if (r.mockWatermark) lines.push("⚠️ בדיקת פיתוח: חילוץ מדומה, אין להסתמך על התוכן");
  if (r.partial) lines.push("חלק מהשדות לא נקלטו וסומנו \"לתיקון\". אפשר להשלים דרך \"תקן או הוסף\".");
  for (const [k, label] of FIELD_LABELS) {
    const f = r.fields[k]!;
    if (k === "customer_external_number" && f.shown === "EMPTY") continue; // optional field: no empty line
    const text = k === "visit_date_statement" && f.shown === "EMPTY" ? r.captureDate : f.text;
    lines.push(`${label}: ${text}`);
  }
  return lines.join("\n");
}
