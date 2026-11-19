export type Action = "approve" | "edit";
const CODE: Record<Action, string> = { approve: "ap", edit: "ed" };
export const BUTTON_TITLES: Record<Action, string> = { approve: "אשר", edit: "תקן או הוסף" };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function encodeButtonId(action: Action, formId: string, revision: number): string {
  if (!ID_RE.test(formId)) throw new Error("invalid form_id");
  if (!Number.isInteger(revision) || revision < 1) throw new Error("invalid revision");
  return `${CODE[action]}:${formId}:${revision}`;
}

export function decodeButtonId(id: string): { action: Action; formId: string; revision: number } | null {
  const m = /^(ap|ed):([A-Za-z0-9_-]{1,64}):([1-9][0-9]{0,8})$/.exec(id);
  if (!m) return null;
  return { action: m[1] === "ap" ? "approve" : "edit", formId: m[2]!, revision: Number(m[3]) };
}
