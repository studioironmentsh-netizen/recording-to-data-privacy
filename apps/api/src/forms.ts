import { createHmac, timingSafeEqual } from "node:crypto";

export type Action = "approve" | "edit";
const CODE: Record<Action, string> = { approve: "ap", edit: "ed" };
export const BUTTON_TITLES: Record<Action, string> = { approve: "אשר", edit: "תקן או הוסף" };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function encodeButtonId(action: Action, formId: string, revision: number): string {
  if (!ID_RE.test(formId)) throw new Error("invalid form_id");
  if (!Number.isInteger(revision) || revision < 1) throw new Error("invalid revision");
  return `${CODE[action]}:${formId}:${revision}`;
}

const mac = (action: Action, formId: string, revision: number, secret: string): string =>
  createHmac("sha256", secret).update(`btn|${CODE[action]}|${formId}|${revision}`).digest("hex").slice(0, 12);

/** Pipeline buttons carry a signature (HMAC over action|form|revision), so an id cannot be forged or re-targeted to another form. */
export function signedButtonId(action: Action, formId: string, revision: number, secret: string): string {
  return `${encodeButtonId(action, formId, revision)}:${mac(action, formId, revision, secret)}`;
}

export function buttonSignatureValid(d: { action: Action; formId: string; revision: number; sig?: string }, secret: string): boolean {
  if (!d.sig || !/^[0-9a-f]{12}$/.test(d.sig)) return false;
  return timingSafeEqual(Buffer.from(d.sig), Buffer.from(mac(d.action, d.formId, d.revision, secret)));
}

export function decodeButtonId(id: string): { action: Action; formId: string; revision: number; sig?: string } | null {
  const m = /^(ap|ed):([A-Za-z0-9_-]{1,64}):([1-9][0-9]{0,8})(?::([0-9a-f]{12}))?$/.exec(id);
  if (!m) return null;
  return { action: m[1] === "ap" ? "approve" : "edit", formId: m[2]!, revision: Number(m[3]), sig: m[4] };
}
