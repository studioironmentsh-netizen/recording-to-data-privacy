// Canonical contract (STAGEB-*-1.0.0) — TypeScript validator. Dependency-free. INDEPENDENT implementation of the same rules as adapters/python_adapter.py.
// validate(layer, doc, ctx) -> { ok, problems:[{code,path,message}] }
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type Layer = "extraction" | "draft" | "approved";
export interface Problem { code: string; path: string; message: string }
export interface Result { ok: boolean; problems: Problem[] }
export interface Ctx { transcript?: string | null; sender_phone?: string | null; anchor?: string | null; anchor_instant?: string | null; org_utc_offset_minutes?: number | null }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const HERE0 = path.dirname(fileURLToPath(import.meta.url));
const HERE = path.basename(HERE0) === "dist" ? path.join(HERE0, "..") : HERE0;   // works from source and from compiled dist/
const CANON = HERE; // ADAPTED: schema file lives next to this module (see PROVENANCE.md)
const LAYER_FILE: Record<Layer, string> = { extraction: "extraction.schema.json", draft: "draft.schema.json", approved: "approved_form.schema.json" };
export const EXPECTED_VERSION: Record<Layer, string> = { extraction: "STAGEB-EXTRACTION-1.0.0", draft: "STAGEB-DRAFT-1.0.0", approved: "STAGEB-APPROVED-1.0.0" };
const cache: Partial<Record<Layer, J>> = {};

export const FIELD_KEYS = ["customer_name", "visit_date_statement", "customer_address", "customer_phone", "customer_external_number", "work_summary", "spare_parts", "parts_price",
  "parts_vat_basis", "visit_price", "visit_vat_basis", "next_visit"] as const;
const EMPTY_STATES = ["MISSING", "UNKNOWN", "UNCLEAR", "NOT_DECIDED"];
const CLARIFY_STATES = ["UNCLEAR", "NEEDS_CONFIRMATION"];
const ALLOWED: Record<string, string[]> = {
  customer_name: ["PRESENT", "MISSING", "UNCLEAR", "NEEDS_CONFIRMATION"], visit_date_statement: ["PRESENT", "MISSING", "UNCLEAR", "NEEDS_CONFIRMATION"],
  customer_address: ["PRESENT", "MISSING", "UNCLEAR"], customer_phone: ["PRESENT", "MISSING", "UNCLEAR"], customer_external_number: ["PRESENT", "MISSING", "UNCLEAR"],
  work_summary: ["PRESENT", "MISSING", "UNCLEAR"], spare_parts: ["PRESENT", "MISSING", "UNCLEAR"], parts_price: ["PRESENT", "MISSING", "UNCLEAR", "NOT_DECIDED"],
  parts_vat_basis: ["PRESENT", "UNKNOWN", "UNCLEAR"], visit_price: ["PRESENT", "MISSING", "UNCLEAR", "NOT_DECIDED"], visit_vat_basis: ["PRESENT", "UNKNOWN", "UNCLEAR"],
  next_visit: ["PRESENT", "MISSING", "UNCLEAR", "NEEDS_CONFIRMATION"],
};
const VAT = ["parts_vat_basis", "visit_vat_basis"];
const PRICE_OF_VAT: Record<string, string> = { parts_vat_basis: "parts_price", visit_vat_basis: "visit_price" };
const REASON_OK: Record<string, string[]> = {
  PRESENT: ["KNOWN"], MISSING: ["NOT_MENTIONED"], UNKNOWN: ["NOT_MENTIONED", "UNCLEAR_AUDIO"], UNCLEAR: ["UNCLEAR_AUDIO", "AMBIGUOUS_REFERENCE"],
  NOT_DECIDED: ["NOT_DETERMINED"], NEEDS_CONFIRMATION: ["AMBIGUOUS_REFERENCE"],
};
const FORBIDDEN_KEYS = new Set(["worker_id", "employee_id", "organization_id", "org_id", "company_id", "tenant_id", "form_id", "visit_id", "draft_id", "customer_id", "customer_internal_id",
  "template_id", "approved_at", "approved_by", "approval_status", "revision", "status", "form_status", "created_at", "cancelled_at", "permissions", "role", "sender_phone",
  "technician_phone", "system_ids", "version_status_times", "form_version"]);
const DAYPART_RE = /בוקר|צהרים|צהריים|ערב|לילה|אחה/;
const ZERO_RE = /אפס|(?<![0-9.,])0(?![0-9])|חינם|בלי חיוב|ללא חיוב|ללא תשלום|לא חייבתי|לא גבינו|ללא עלות|בלי עלות|לא לקחתי/;
const NIQQUD = /[֑-ׇ]/g;
const QMAP: Record<string, string> = {
  "״": '"', "“": '"', "”": '"', "„": '"', "׳": "'", "’": "'", "‘": "'", " ": " ", "‏": " ", "‎": " ",
  "–": "-", "—": "-", "־": "-",
};

export function norm(t: string | null | undefined): string {
  const s = (t ?? "").normalize("NFC").replace(NIQQUD, "");
  let out = "";
  for (const c of s) out += QMAP[c] ?? c;
  return out;
}
const digits = (s: string | null | undefined): string => (s ?? "").replace(/[^0-9]/g, "");
const clen = (s: string): number => [...s].length;   // code points, like Python len()
const truthy = (v: J): boolean => !(v === null || v === undefined || v === "" || v === 0 || v === false || (Array.isArray(v) && v.length === 0));
const isObj = (v: J): boolean => v !== null && typeof v === "object" && !Array.isArray(v);

export function realDate(s: J): boolean {
  if (typeof s !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return false;
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const dim = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}
const P = (code: string, p: string, message: string): Problem => ({ code, path: p, message });

function loadSchema(layer: Layer): J {
  if (!cache[layer]) cache[layer] = JSON.parse(fs.readFileSync(path.join(CANON, LAYER_FILE[layer]), "utf-8"));
  return cache[layer];
}

function typeOk(v: J, t: string): boolean {
  switch (t) {
    case "null": return v === null;
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "number": return typeof v === "number";
    case "object": return isObj(v);
    case "array": return Array.isArray(v);
    default: return false;
  }
}

function checkSchema(v: J, s0: J, root: J, p: string, out: Problem[]): void {
  let s = s0;
  if (s.$ref) s = root.$defs[String(s.$ref).split("/").pop() as string];
  if (s.type !== undefined) {
    const ts: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!ts.some((t) => typeOk(v, t))) { out.push(P("SCHEMA", p, `type ${JSON.stringify(ts)} expected`)); return; }
  }
  if (s.enum !== undefined && !(s.enum as J[]).some((e: J) => e === v)) { out.push(P("SCHEMA", p, "value not in enum")); return; }
  if (typeof v === "string") {
    if (s.minLength !== undefined && clen(v) < s.minLength) out.push(P("SCHEMA", p, "too short"));
    if (s.maxLength !== undefined && clen(v) > s.maxLength) out.push(P("SCHEMA", p, "too long"));
    if (s.pattern !== undefined && !new RegExp(s.pattern).test(v)) out.push(P("SCHEMA", p, "pattern mismatch"));
  }
  if (typeof v === "number" && Number.isInteger(v) && s.minimum !== undefined && v < s.minimum) out.push(P("SCHEMA", p, "below minimum"));
  if (isObj(v)) {
    for (const k of (s.required ?? []) as string[]) if (!(k in v)) out.push(P("SCHEMA", `${p}.${k}`, "required"));
    const props = s.properties ?? {};
    for (const k of Object.keys(v)) {
      if (k in props) checkSchema(v[k], props[k], root, `${p}.${k}`, out);
      else if (s.additionalProperties === false) out.push(P("SCHEMA", `${p}.${k}`, "unknown property"));
    }
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) out.push(P("SCHEMA", p, "too few items"));
    if (s.items !== undefined) v.forEach((x, i) => checkSchema(x, s.items, root, `${p}[${i}]`, out));
  }
}

export function validateStructural(layer: Layer, doc: J): Problem[] {
  if (!isObj(doc)) return [P("SCHEMA", "$", "root must be an object")];
  const sc = loadSchema(layer);
  const out: Problem[] = [];
  checkSchema(doc, sc, sc, "$", out);
  return out;
}

function scanForbidden(o: J, p: string, out: Problem[]): void {
  if (isObj(o)) {
    for (const k of Object.keys(o)) {
      if (FORBIDDEN_KEYS.has(k)) out.push(P("BV-19", `${p}.${k}`, "server-owned key supplied by the extractor"));
      scanForbidden(o[k], `${p}.${k}`, out);
    }
  } else if (Array.isArray(o)) o.forEach((x, i) => scanForbidden(x, `${p}[${i}]`, out));
}

function finalRepr(key: string, value: J): string | null {
  if (value === null || value === undefined) return null;
  if (key === "parts_price" || key === "visit_price") return value.amount ?? null;
  if (key === "visit_date_statement" || key === "next_visit") return value.expression ?? null;
  return typeof value === "string" ? value : null;
}

// ----------------------------------------------------------------- R-04 phone normalisation / R-05 date verification (rules revision 1.1.0)
export function normalizePhone(s: string | null | undefined): string {
  let d = digits(s);
  if (d.startsWith("00972")) d = d.slice(5);
  else if (d.startsWith("972") && d.length >= 11) d = d.slice(3);
  if (d.length === 9 && !d.startsWith("0")) d = "0" + d;
  return d;
}

const p2 = (n: number, w: number): string => String(n).padStart(w, "0");
function isoOf(t: Date): string | null {
  const y = t.getUTCFullYear();
  if (!(y >= 1 && y <= 9999)) return null;
  return `${p2(y, 4)}-${p2(t.getUTCMonth() + 1, 2)}-${p2(t.getUTCDate(), 2)}`;
}
function utcDate(y: number, mo: number, d: number, h = 0, mi = 0, sec = 0): Date {
  const x = new Date(0);
  x.setUTCFullYear(y, mo - 1, d);
  x.setUTCHours(h, mi, sec, 0);
  return x;
}
export function addDays(iso: string, n: number): string | null {
  const x = utcDate(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));
  x.setTime(x.getTime() + n * 86400000);
  return isoOf(x);
}

export function effectiveAnchor(ctx: Ctx): [string | null, string | null] {
  const a = ctx.anchor ?? null, inst = ctx.anchor_instant ?? null, off = ctx.org_utc_offset_minutes ?? null;
  let local: string | null = null;
  if (a !== null) {
    if (!realDate(a)) return [null, "anchor is not a real calendar date"];
    local = a;
  }
  if (inst !== null) {
    const m = typeof inst === "string" ? /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$/.exec(inst) : null;
    if (!m || !realDate(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59) return [null, "anchor_instant must be a valid ISO-8601 instant with an offset"];
    if (typeof off !== "number" || !Number.isInteger(off) || Math.abs(off) > 840) return [null, "anchor_instant requires org_utc_offset_minutes (integer, |x|<=840)"];
    const fo = m[5] === "Z" ? 0 : (m[5][0] === "+" ? 1 : -1) * (Number(m[5].slice(1, 3)) * 60 + Number(m[5].slice(4, 6)));
    const u = utcDate(Number(m[1].slice(0, 4)), Number(m[1].slice(5, 7)), Number(m[1].slice(8, 10)), Number(m[2]), Number(m[3]), Number(m[4] ?? 0));
    u.setTime(u.getTime() + (off - fo) * 60000);
    const li = isoOf(u);
    if (li === null) return [null, "anchor_instant out of range"];
    if (local !== null && local !== li) return [null, "anchor and anchor_instant disagree"];
    local = li;
  }
  return [local, null];
}

const MONTHS: Record<string, number> = { "ינואר": 1, "פברואר": 2, "מרץ": 3, "מרס": 3, "אפריל": 4, "מאי": 5, "יוני": 6, "יולי": 7, "אוגוסט": 8, "ספטמבר": 9, "אוקטובר": 10, "נובמבר": 11, "דצמבר": 12 };
const REL_WORDS: Record<string, number> = { "היום": 0, "אתמול": -1, "שלשום": -2, "מחר": 1, "מחרתיים": 2, "מחרתים": 2 };
const HE = "א-ת";

export function relativeOffsets(expr: string): Set<number> {
  const e = norm(expr);
  const out = new Set<number>();
  for (const m of e.matchAll(new RegExp("(?<![" + HE + "])[לו]?(מחרתיים|מחרתים|מחר|אתמול|שלשום|היום)(?![" + HE + "])", "g"))) out.add(REL_WORDS[m[1]]);
  for (const m of e.matchAll(/(לפני|בעוד) ([0-9]{1,3}) ימים/g)) out.add((m[1] === "לפני" ? -1 : 1) * Number(m[2]));
  const W: Record<string, number> = { "יומיים": 2, "שבוע": 7, "שבועיים": 14 };
  for (const m of e.matchAll(/(לפני|בעוד) (יומיים|שבועיים|שבוע)/g)) out.add((m[1] === "לפני" ? -1 : 1) * W[m[2]]);
  return out;
}

function parseAbsolute(expr: string): [number, number, number | null] | null {
  const e = norm(expr);
  let m = /(?<![0-9])([0-9]{1,2})[./-]([0-9]{1,2})[./-]([0-9]{4}|[0-9]{2})(?![0-9])/.exec(e);
  if (m) { const y = Number(m[3]); return [Number(m[1]), Number(m[2]), y < 100 ? 2000 + y : y]; }
  m = new RegExp("(?<![0-9])([0-9]{1,2}) ?[בל]?(" + Object.keys(MONTHS).join("|") + ")(?: ([0-9]{4}))?").exec(e);
  if (m) return [Number(m[1]), MONTHS[m[2]], m[3] ? Number(m[3]) : null];
  m = /(?<![0-9])([0-9]{1,2})[./]([0-9]{1,2})(?![0-9./])/.exec(e);
  if (m) return [Number(m[1]), Number(m[2]), null];
  return null;
}

function checkDateValue(val: J, ctx: Ctx, p: string): Problem[] {
  const d = val.date ?? null;
  if (d === null) return [];
  if (!realDate(d)) return [P("BV-12", p, "impossible calendar date")];
  const [anchor, aerr] = effectiveAnchor(ctx);
  const kind = val.kind, expr: string = val.expression ?? "";
  if (aerr) return [P("BV-12", p, "unusable time anchor: " + aerr)];
  const out: Problem[] = [];
  if (kind === "RELATIVE") {
    if (anchor === null) return [P("BV-12", p, "a relative date cannot be resolved without a trusted anchor")];
    const offs = relativeOffsets(expr);
    if (offs.size !== 1) out.push(P("BV-12", p, "relative expression cannot be resolved mechanically (unknown or ambiguous): leave date null for server resolution / clarification"));
    else if (addDays(anchor, [...offs][0]) !== d) out.push(P("BV-12", p, "date does not equal anchor + the stated day offset"));
  } else if (kind === "ABSOLUTE") {
    const pa = parseAbsolute(expr);
    if (pa === null) out.push(P("BV-12", p, "absolute expression cannot be parsed: the date cannot be verified against the statement"));
    else {
      const [dd, mm, yy] = pa;
      const y = Number(d.slice(0, 4)), mo = Number(d.slice(5, 7)), da = Number(d.slice(8, 10));
      if (da !== dd || mo !== mm || (yy !== null && y !== yy)) out.push(P("BV-12", p, "date does not match the stated absolute date"));
      else if (yy === null && (anchor === null || Math.abs(y - Number(anchor.slice(0, 4))) > 1)) out.push(P("BV-12", p, "a date without a year needs an anchor year (+-1)"));
    }
  }
  return out;
}

function timeMatches(expr: string, t: string): boolean {
  let e = norm(expr);
  if (!/[0-9]{1,2}:[0-9]{2}/.test(e)) e = e.replace(/(?<![0-9])[0-9]{1,2}[./-][0-9]{1,2}(?:[./-](?:[0-9]{4}|[0-9]{2}))?(?![0-9])/g, " ");
  let toks: Array<[number, number]> = [...e.matchAll(/(?<![0-9])([0-9]{1,2}):([0-9]{2})(?![0-9])/g)].map((m) => [Number(m[1]), Number(m[2])]);
  if (toks.length === 0) toks = [...e.matchAll(/(?<![0-9])([0-9]{1,2})(?![0-9])/g)].map((m) => [Number(m[1]), 0] as [number, number]);
  if (toks.length === 0) return true;
  const h = Number(t.slice(0, 2)), m = Number(t.slice(3, 5));
  return toks.some(([th, tm]) => (h === th || (th < 12 && h === th + 12)) && m === tm);
}

function matchNorm(t: string): string {
  let s = norm(t);
  s = s.replace(new RegExp("(?<![" + HE + "])[הבלומכש]-?(?=[0-9])", "g"), "");
  s = s.replace(/\s*-\s*/g, "-");
  return s.replace(/\s+/g, " ").trim();
}

const NEG_RE = /(?<![א-ת])(לא|בלי|ללא|אין)(?![א-ת])/;
const VAT_QUOTE_RE = /כולל|מעמ|מע"מ|פלוס|vat/i;

function grounded(k: string, val: J, q: string): boolean {
  const nq = matchNorm(q);
  if (k === "customer_name" || k === "customer_address" || k === "customer_external_number") return typeof val === "string" && nq.includes(matchNorm(val));
  if (k === "customer_phone") {
    if (!(typeof val === "string" && digits(val) !== "")) return false;
    const qd = digits(q), nd = normalizePhone(val);
    return qd.includes(digits(val)) || qd.includes(nd) || qd.includes("972" + nd.replace(/^0+/, ""));
  }
  if (k === "parts_price" || k === "visit_price") {
    const a: string = val.amount;
    if (a === "0" || !/[0-9]/.test(nq)) return true;
    const flat = nq.replace(/(?<=[0-9]),(?=[0-9]{3})/g, "");
    const ip = a.split(".")[0];
    return new RegExp("(?<![0-9.,])" + ip + "(?![0-9])").test(flat);   // ip is digits only (Amount pattern)
  }
  if (k === "visit_date_statement" || k === "next_visit") return nq.includes(matchNorm(val.expression ?? ""));
  if (k === "spare_parts") return (val as J[]).every((it) => nq.includes(matchNorm(it.name ?? "")));
  if (VAT.includes(k)) return VAT_QUOTE_RE.test(norm(q));
  return true;
}

function checkFields(fields: J, states: J, ctx: Ctx, p0: string, provOnly = false): Problem[] {
  const out: Problem[] = [];
  const tr = ctx.transcript !== undefined && ctx.transcript !== null ? norm(ctx.transcript) : null;
  for (const k of FIELD_KEYS) {
    const f = fields[k], fsx = states[k], p = `${p0}.${k}`;
    const st: string = f.evidence_state, val: J = f.value, nc: boolean = f.needs_clarification;
    if (!ALLOWED[k].includes(st)) out.push(P("BV-02", p, `${st} not allowed for ${k}`));
    if (VAT.includes(k)) {
      if (st === "PRESENT" && val !== "INCLUDED" && val !== "EXCLUDED") out.push(P("BV-01", p, "PRESENT VAT needs INCLUDED/EXCLUDED"));
      if (EMPTY_STATES.includes(st) && val !== "UNKNOWN") out.push(P("BV-01", p, `${st} VAT must be UNKNOWN`));
    } else {
      if ((st === "PRESENT" || st === "NEEDS_CONFIRMATION") && val === null) out.push(P("BV-01", p, `${st} needs a value`));
      if (EMPTY_STATES.includes(st) && val !== null) out.push(P("BV-01", p, `${st} must have null value`));
    }
    if (nc !== CLARIFY_STATES.includes(st)) out.push(P("BV-03", p, "needs_clarification must equal (state in UNCLEAR/NEEDS_CONFIRMATION)"));
    const r: string | null = fsx.uncertainty_reason ?? null;
    if (r === null || !(REASON_OK[st] ?? []).includes(r)) out.push(P("BV-07", p, `uncertainty_reason ${r} incompatible with ${st}`));
    const q: J = fsx.evidence_quote ?? null;
    const needsEv = (st === "PRESENT" || st === "NEEDS_CONFIRMATION") && (!provOnly || f.provenance === "EXTRACTED");
    if (needsEv && !(typeof q === "string" && q.trim() !== "")) out.push(P("BV-09", p, "evidence_quote required for PRESENT/NEEDS_CONFIRMATION"));
    if (tr !== null && typeof q === "string" && q !== "" && !tr.includes(norm(q))) out.push(P("BV-10", p, "evidence_quote is not a verbatim substring of the input"));
    if ((st === "PRESENT" || st === "NEEDS_CONFIRMATION") && val !== null && typeof q === "string" && q.trim() !== "" && (!provOnly || f.provenance === "EXTRACTED")) {
      if (!grounded(k, val, q)) out.push(P("BV-20", p, "the value is not visible in its evidence quote"));
    }
    if ((k === "parts_price" || k === "visit_price") && isObj(val) && val.amount === "0") {
      if (!(typeof q === "string" && ZERO_RE.test(norm(q)))) out.push(P("BV-05", p, "0 requires an explicit zero/no-charge statement in the evidence"));
    }
    if (k === "spare_parts" && Array.isArray(val) && val.length === 0) {
      if (st !== "PRESENT" || !(typeof q === "string" && q.trim() !== "" && NEG_RE.test(norm(q)))) out.push(P("BV-06", p, "[] only as PRESENT with a quoted explicit negation (לא/בלי/ללא/אין)"));
    }
    if (k === "spare_parts" && st === "MISSING" && val !== null) out.push(P("BV-06", p, "silence about parts is null/MISSING"));
    if (k === "spare_parts" && Array.isArray(val) && val.length > 0) {
      const it: J[] = fsx.item_timing ?? [];
      if (it.length !== val.length) out.push(P("BV-16", p, "item_timing must have one REPLACED entry per part"));
    }
    if (k === "work_summary" && st === "PRESENT" && !truthy(fsx.summary_items)) out.push(P("BV-17", p, "work_summary PRESENT needs summary_items"));
    if (k === "customer_phone" && typeof val === "string") {
      if (!/^\+?[0-9]{7,15}$/.test(val)) out.push(P("BV-11", p, "phone must be digits with optional leading +"));
      const sp = ctx.sender_phone;
      if (sp && digits(sp) !== "" && normalizePhone(sp) === normalizePhone(val)) out.push(P("BV-11", p, "the technician's own number is never the customer phone"));
    }
    if ((k === "visit_date_statement" || k === "next_visit") && isObj(val)) {
      const extracted = !provOnly || f.provenance === "EXTRACTED";   // technician/server-edited values are not judged against the spoken expression
      if (extracted) out.push(...checkDateValue(val, ctx, p));
      else if ((val.date ?? null) !== null && !realDate(val.date)) out.push(P("BV-12", p, "impossible calendar date"));
      if (val.kind === "DESCRIPTIVE" && (val.date ?? null) !== null) out.push(P("BV-13", p, "DESCRIPTIVE expressions carry no date"));
      if (k === "next_visit" && truthy(val.time) && !/[0-9]|שעה/.test(val.expression ?? "")) out.push(P("BV-13", p, "an hour was invented: the expression contains no time"));
      if (extracted && k === "next_visit" && truthy(val.time) && /[0-9]/.test(val.expression ?? "") && !timeMatches(val.expression ?? "", val.time)) out.push(P("BV-13", p, "time contradicts the clock number in the expression"));
      if (extracted && k === "next_visit" && truthy(val.day_part) && !DAYPART_RE.test(val.expression ?? "")) out.push(P("BV-13", p, "a day part was invented: the expression names no part of the day"));
    }
    const ev: J[] = fsx.self_correction_events ?? [];
    if (ev.length > 0) {
      for (const e of ev) if ((e.from_value ?? null) === (e.to_value ?? null)) out.push(P("BV-15", p, "self-correction event with identical from/to"));
      const fr = finalRepr(k, val);
      if (st === "PRESENT" && fr !== null && (ev[ev.length - 1].to_value ?? null) !== fr) out.push(P("BV-15", p, "the last correction must equal the final value"));
    }
  }
  for (const vk of Object.keys(PRICE_OF_VAT)) {
    if (fields[vk].evidence_state === "PRESENT" && fields[PRICE_OF_VAT[vk]].evidence_state !== "PRESENT") out.push(P("BV-04", `${p0}.${vk}`, "a stated VAT basis requires its own PRESENT price"));
  }
  const a = fields.parts_price.value, b = fields.visit_price.value;
  if (isObj(a) && isObj(b) && a.amount === b.amount && tr !== null) {
    const re = new RegExp("(?<![0-9.,])" + String(a.amount).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![0-9])", "g");
    const n = (tr.match(re) ?? []).length;
    if (n === 1) out.push(P("BV-18", p0, "one amount appears once in the input but fills both prices"));
  }
  return out;
}

function checkCommon(doc: J, fieldsKey: string, _ctx: Ctx): Problem[] {
  const out: Problem[] = [];
  const fields = doc[fieldsKey];
  const covered = new Set<string>();
  (doc.clarification_requests as J[]).forEach((cr, i) => {
    for (const k of cr.field_keys as string[]) {
      covered.add(k);
      if (!fields[k].needs_clarification) out.push(P("BV-08", `$.clarification_requests[${i}]`, `${k} referenced but needs_clarification is false`));
    }
  });
  for (const k of FIELD_KEYS) if (fields[k].needs_clarification && !covered.has(k)) out.push(P("BV-08", `$.${fieldsKey}.${k}`, "needs_clarification without a clarification request"));
  const prices: J[] = ["parts_price", "visit_price"].filter((k) => isObj(fields[k].value)).map((k) => fields[k].value.amount);
  (doc.unassigned_business_info as J[]).forEach((u, i) => {
    if (u.type === "AMOUNT_UNASSIGNED" && prices.includes(u.amount)) out.push(P("BV-14", `$.unassigned_business_info[${i}]`, "an amount flagged unassigned is also placed in a price field"));
  });
  return out;
}

export function blockersOf(fields: J, visitDate: J): string[] {
  const b: string[] = [];
  if (fields.customer_name.evidence_state !== "PRESENT") b.push("MISSING_CUSTOMER_NAME");
  if (fields.customer_address.evidence_state !== "PRESENT" && fields.customer_phone.evidence_state !== "PRESENT") b.push("MISSING_ADDRESS_AND_PHONE");
  if (!realDate(visitDate)) b.push("INVALID_VISIT_DATE");
  if (FIELD_KEYS.some((k) => fields[k].needs_clarification)) b.push("OPEN_CLARIFICATION");
  return [...new Set(b)].sort();
}

function businessExtraction(doc: J, ctx: Ctx): Problem[] {
  return [...checkFields(doc.extracted_fields, doc.field_states, ctx, "$.extracted_fields"), ...checkCommon(doc, "extracted_fields", ctx)];
}

function businessDraft(doc: J, ctx: Ctx): Problem[] {
  const out: Problem[] = [...checkFields(doc.fields, doc.field_states, ctx, "$.fields", true), ...checkCommon(doc, "fields", ctx)];
  const vd = doc.visit_date.value ?? null;
  if (vd !== null && !realDate(vd)) out.push(P("BV-12", "$.visit_date", "impossible calendar date"));
  const exp = blockersOf(doc.fields, vd);
  const got: string[] = [...doc.approval_blockers].sort();
  if (JSON.stringify(got) !== JSON.stringify(exp) || new Set(doc.approval_blockers).size !== doc.approval_blockers.length) out.push(P("BV-D1", "$.approval_blockers", `blockers must equal the computed set ${JSON.stringify(exp)}`));
  if ((doc.kind === "CORRECTION") !== (doc.base_approved_version_id !== null)) out.push(P("BV-D3", "$.base_approved_version_id", "CORRECTION drafts (and only they) carry base_approved_version_id"));
  if (doc.visible !== ["REVIEW_READY", "NEEDS_INFO"].includes(doc.processing_state)) out.push(P("BV-D4", "$.visible", "visible iff processing_state is REVIEW_READY/NEEDS_INFO"));
  if (doc.processing_state === "REVIEW_READY" && exp.length > 0) out.push(P("BV-D4", "$.processing_state", "REVIEW_READY requires no blockers and no open clarification"));
  if (doc.processing_state === "NEEDS_INFO" && exp.length === 0) out.push(P("BV-D4", "$.processing_state", "NEEDS_INFO requires a blocker or an open clarification"));
  for (const k of FIELD_KEYS) if (doc.fields[k].needs_clarification && doc.fields[k].provenance !== "PENDING_CLARIFICATION") out.push(P("BV-D2", `$.fields.${k}`, "an open clarification must carry provenance PENDING_CLARIFICATION"));
  return out;
}

function businessApproved(doc: J, ctx: Ctx): Problem[] {
  const out: Problem[] = [...checkFields(doc.fields, doc.field_states, ctx, "$.fields", true), ...checkCommon({ ...doc, clarification_requests: [] }, "fields", ctx).filter((x) => x.code !== "BV-08")];
  const f = doc.fields;
  const b = blockersOf(f, doc.visit_date);
  if (b.length > 0) out.push(P("BV-A1", "$", `approval preconditions not met: ${JSON.stringify(b)}`));
  if (doc.approval.approved_by !== doc.worker_id) out.push(P("BV-A2", "$.approval.approved_by", "approval must be made by the owning technician"));
  const cs = doc.customer_snapshot;
  const nz = (x: J): J => (truthy(x) ? x : null);
  if (f.customer_name.value !== cs.name) out.push(P("BV-A4", "$.customer_snapshot.name", "snapshot name must equal the approved customer_name"));
  if (nz(f.customer_phone.value) !== nz(cs.phone)) out.push(P("BV-A4", "$.customer_snapshot.phone", "snapshot phone must equal the approved customer_phone"));
  if (nz(f.customer_address.value) !== nz(cs.address)) out.push(P("BV-A4", "$.customer_snapshot.address", "snapshot address must equal the approved customer_address"));
  return out;
}

export function validate(layer: Layer, doc: J, ctx: Ctx = {}): Result {
  if (isObj(doc) && doc.contract_version !== EXPECTED_VERSION[layer]) return { ok: false, problems: [P("VERSION", "$.contract_version", `expected ${EXPECTED_VERSION[layer]}`)] };
  const probs: Problem[] = [];
  if (layer === "extraction") scanForbidden(doc, "$", probs);
  probs.push(...validateStructural(layer, doc));
  if (probs.length > 0) return { ok: false, problems: probs };
  const p = layer === "extraction" ? businessExtraction(doc, ctx) : layer === "draft" ? businessDraft(doc, ctx) : businessApproved(doc, ctx);
  return { ok: p.length === 0, problems: p };
}

export const codes = (r: Result): string[] => [...new Set(r.problems.map((x) => x.code))].sort();
