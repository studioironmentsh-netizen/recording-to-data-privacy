// Parses a Meta webhook payload into a flat list of inbound events.

/** Delivery error as Meta reports it in `statuses[].errors[]`. Only these known fields are kept; each is optional (Meta may omit or mistype any of them). */
export interface MetaStatusError { code?: number; title?: string; message?: string; details?: string; href?: string }

export type InboundEvent =
  | { kind: "audio"; messageId: string; from: string; mediaId: string; mime: string; voice: boolean }
  | { kind: "button"; messageId: string; from: string; buttonId: string; title: string; contextId?: string }
  | { kind: "status"; messageId: string; from: string; status: string; timestamp: number; errors?: MetaStatusError[] } // delivery receipt for OUR message (from = recipient)
  | { kind: "other"; messageId: string; from: string; type: string };

type Json = Record<string, any>;

const MAX_STATUS_ERRORS = 5;

/** Text field from Meta: strings only, control characters flattened, long digit runs (possible phone numbers) masked, length capped. */
function cleanText(v: unknown, max: number, maskDigits = true): string | undefined {
  if (typeof v !== "string") return undefined;
  let s = v.replace(/[\u0000-\u001f\u007f]+/g, " ");
  if (maskDigits) s = s.replace(/\d{7,}/g, "***");
  s = s.trim();
  return s === "" ? undefined : s.slice(0, max);
}

/** Safe normalisation of `statuses[].errors`: known fields only, never throws, never copies unknown objects. Undefined when nothing usable. */
export function parseStatusErrors(raw: unknown): MetaStatusError[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: MetaStatusError[] = [];
  for (const item of raw.slice(0, MAX_STATUS_ERRORS)) {
    if (item === null || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const data = e.error_data !== null && typeof e.error_data === "object" ? (e.error_data as Record<string, unknown>) : undefined;
    const err: MetaStatusError = {};
    if (typeof e.code === "number" && Number.isFinite(e.code)) err.code = e.code;
    else if (typeof e.code === "string" && /^\d{1,8}$/.test(e.code)) err.code = Number(e.code);
    const title = cleanText(e.title, 200); if (title) err.title = title;
    const message = cleanText(e.message, 300); if (message) err.message = message;
    const details = cleanText(data?.details, 500); if (details) err.details = details;
    const href = cleanText(e.href, 300, false); if (href && href.startsWith("https://")) err.href = href;
    if (Object.keys(err).length > 0) out.push(err);
  }
  return out.length > 0 ? out : undefined;
}

export function parseWebhook(body: unknown): InboundEvent[] {
  const out: InboundEvent[] = [];
  const b = body as Json;
  if (!b || b.object !== "whatsapp_business_account" || !Array.isArray(b.entry)) return out;
  for (const entry of b.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") continue;
      for (const st of change?.value?.statuses ?? []) {
        if (typeof st?.id === "string" && typeof st?.recipient_id === "string" && typeof st?.status === "string") {
          const errors = parseStatusErrors(st.errors);
          out.push({ kind: "status", messageId: st.id, from: st.recipient_id, status: st.status, timestamp: Number(st.timestamp ?? 0), ...(errors ? { errors } : {}) });
        }
      }
      for (const m of change?.value?.messages ?? []) {
        if (typeof m?.id !== "string" || typeof m?.from !== "string") continue;
        if (m.type === "audio" && typeof m.audio?.id === "string") {
          out.push({
            kind: "audio", messageId: m.id, from: m.from, mediaId: m.audio.id,
            mime: String(m.audio.mime_type ?? ""), voice: m.audio.voice === true,
          });
        } else if (m.type === "interactive" && m.interactive?.type === "button_reply"
          && typeof m.interactive.button_reply?.id === "string") {
          out.push({
            kind: "button", messageId: m.id, from: m.from,
            buttonId: m.interactive.button_reply.id,
            title: String(m.interactive.button_reply.title ?? ""),
            contextId: typeof m.context?.id === "string" ? m.context.id : undefined,
          });
        } else {
          out.push({ kind: "other", messageId: m.id, from: m.from, type: String(m.type ?? "unknown") });
        }
      }
    }
  }
  return out;
}
