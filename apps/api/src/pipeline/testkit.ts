// Shared helpers for tests. Not imported by production code.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WhatsApp } from "../whatsapp.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const API_ROOT = resolve(HERE, "..", "..");
export const FIXTURES = join(HERE, "fixtures");
export const VENV_PYTHON = join(API_ROOT, "python", ".venv-stt", "Scripts", "python.exe");
export const PYTHON = process.env.TEST_PYTHON ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python");
export const CONTROLS_SCRIPT = join(API_ROOT, "python", "controls_cli.py");
export const FAKE_WORKER = join(FIXTURES, "fake_stt_worker.py");

/** Transcript of fixture V-X01 (synthetic). */
export const TRANSCRIPT = "הייתי אצל דן לוי ברחוב הדקל 3 הטלפון שלו 0521234567 החלפתי קבל ומאוורר העבודה עלתה 250 שקל לא כולל מעמ והחלקים 100 שקל כולל מעמ אחזור ביום ראשון בבוקר";

const MODEL_KEYS = ["extracted_fields", "field_states", "clarification_requests", "unassigned_business_info"];
export const fixtureDoc = (name: "V-X01" | "V-X02"): any => JSON.parse(readFileSync(join(FIXTURES, `${name}.extraction.json`), "utf8"));

/** The four keys the model is asked to return (the runner adds version + metadata). */
export function modelReply(doc: any): string {
  return JSON.stringify(Object.fromEntries(MODEL_KEYS.map((k) => [k, doc[k]])));
}

export function setField(doc: any, k: string, value: unknown, state: string, quote: string | null, reason?: string) {
  doc.extracted_fields[k] = { value, evidence_state: state, needs_clarification: state === "UNCLEAR" || state === "NEEDS_CONFIRMATION" };
  doc.field_states[k] = { uncertainty_reason: reason ?? (state === "PRESENT" ? "KNOWN" : state === "NOT_DECIDED" ? "NOT_DETERMINED" : state === "UNCLEAR" ? "AMBIGUOUS_REFERENCE" : "NOT_MENTIONED"), evidence_quote: quote };
}

/** Empty draft (everything MISSING/UNKNOWN) with the given PRESENT strings: {field: [value, quote]}. */
export function docWith(strings: Record<string, [string, string]>): any {
  const d = fixtureDoc("V-X02");
  for (const [k, [v, q]] of Object.entries(strings)) {
    setField(d, k, v, "PRESENT", q);
    if (k === "work_summary") d.field_states[k].summary_items = [{ kind: "ACTION_DONE", text: v }]; // BV-17: a summary needs its items
  }
  return d;
}

export class FakeWA implements WhatsApp {
  texts: string[] = [];
  forms: Array<{ to: string; text: string; formId: string; revision: number }> = [];
  media = new Map<string, Buffer>();
  private n = 0;
  async sendText(_to: string, text: string) { this.texts.push(text); }
  async sendForm() { return "wamid.LEGACY"; }
  async sendFormMessage(to: string, text: string, formId: string, revision: number) {
    this.forms.push({ to, text, formId, revision });
    return `wamid.OUT${++this.n}`;
  }
  async fetchMedia(id: string) {
    const b = this.media.get(id);
    if (!b) throw new Error("media lookup failed: http 404");
    return { bytes: b, mime: "audio/ogg; codecs=opus" };
  }
}
