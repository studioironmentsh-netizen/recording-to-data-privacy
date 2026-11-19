import { createHash } from "node:crypto";

/** Stable, non-reversible technician key for local state (the WhatsApp number itself is never persisted with forms). */
export function techKey(waId: string): string {
  return createHash("sha256").update(waId).digest("hex").slice(0, 16);
}
