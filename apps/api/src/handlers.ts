import type { Config } from "./config.ts";
import type { InboundEvent } from "./events.ts";
import { decodeButtonId } from "./forms.ts";
import { errMsg, log, maskPhone, shortId, type Fields } from "./logger.ts";
import type { Store } from "./store.ts";
import { stashTemporarily, type WhatsApp } from "./whatsapp.ts";

export interface Deps { cfg: Config; store: Store; wa: WhatsApp; }

export async function handleEvent(ev: InboundEvent, d: Deps): Promise<void> {
  const base = { msg: shortId(ev.messageId), from: maskPhone(ev.from) };
  if (!d.cfg.allowedTechnicians.has(ev.from)) {
    log("warn", "unauthorized_sender", base);
    return;
  }
  if (!d.store.claimMessage(ev.messageId)) {
    log("info", "duplicate_ignored", base);
    return;
  }
  try {
    if (ev.kind === "audio") await handleAudio(ev, d, base);
    else if (ev.kind === "button") await handleButton(ev, d, base);
    else log("info", "message_ignored", { ...base, type: ev.type });
  } catch (e) {
    log("error", "handler_failed", { ...base, kind: ev.kind, error: errMsg(e) });
  }
}

async function handleAudio(ev: Extract<InboundEvent, { kind: "audio" }>, d: Deps, base: Fields) {
  const media = await d.wa.fetchMedia(ev.mediaId);
  const stash = stashTemporarily(d.cfg.dataDir, media.bytes, d.cfg.mediaKeepSeconds);
  // Meta's reported sha256 may not be comparable; log the comparison, don't gate on it.
  const shaOk = media.sha256Reported ? media.sha256Reported.toLowerCase() === stash.sha256 : null;
  log("info", "audio_received", {
    ...base, mime: media.mime || ev.mime, voice: ev.voice, size: stash.size,
    sha256: stash.sha256.slice(0, 12), sha_matches_meta: shaOk, deleted: stash.deleted,
  });
}

async function handleButton(ev: Extract<InboundEvent, { kind: "button" }>, d: Deps, base: Fields) {
  const dec = decodeButtonId(ev.buttonId);
  if (!dec) {
    log("warn", "button_unrecognized", base);
    return;
  }
  const fields = { ...base, action: dec.action, form_id: dec.formId, revision: dec.revision };
  // Cross-check against the outbound message the button belongs to.
  if (ev.contextId) {
    const sent = d.store.getSent(ev.contextId);
    if (!sent || sent.formId !== dec.formId || sent.revision !== dec.revision) {
      log("warn", "button_context_mismatch", { ...fields, context: shortId(ev.contextId) });
      return;
    }
  }
  const form = d.store.getForm(dec.formId);
  if (!form) {
    log("warn", "button_unknown_form", fields);
    return;
  }
  if (form.revision !== dec.revision) {
    log("info", "button_stale", { ...fields, current_revision: form.revision });
    await d.wa.sendText(ev.from, `הטופס ${dec.formId} עודכן לגרסה ${form.revision}. נא להשתמש בהודעה העדכנית.`);
    return;
  }
  if (form.status !== "draft") {
    log("info", "button_already_handled", { ...fields, status: form.status });
    return;
  }
  d.store.setStatus(dec.formId, dec.action === "approve" ? "approved" : "editing");
  log("info", "button_click", { ...fields, context_verified: Boolean(ev.contextId) });
  await d.wa.sendText(ev.from, dec.action === "approve" ? `הטופס ${dec.formId} אושר.` : `הטופס ${dec.formId} ממתין לתיקון.`);
}
