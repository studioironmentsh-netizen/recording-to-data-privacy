// Parses a Meta webhook payload into a flat list of inbound events.
export type InboundEvent =
  | { kind: "audio"; messageId: string; from: string; mediaId: string; mime: string; voice: boolean }
  | { kind: "button"; messageId: string; from: string; buttonId: string; title: string; contextId?: string }
  | { kind: "other"; messageId: string; from: string; type: string };

type Json = Record<string, any>;

export function parseWebhook(body: unknown): InboundEvent[] {
  const out: InboundEvent[] = [];
  const b = body as Json;
  if (!b || b.object !== "whatsapp_business_account" || !Array.isArray(b.entry)) return out;
  for (const entry of b.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") continue;
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
