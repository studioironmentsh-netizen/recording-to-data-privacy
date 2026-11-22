import type { Config } from "./config.ts";
import type { InboundEvent, MetaStatusError } from "./events.ts";
import { buttonSignatureValid, decodeButtonId, type Action } from "./forms.ts";
import { errMsg, log, maskPhone, shortId, type Fields } from "./logger.ts";
import type { Form, Store } from "./store.ts";
import { approvability } from "./pipeline/formview.ts";
import type { OutboxRunner } from "./pipeline/outbox.ts";
import { techKey, type VoicePipeline } from "./pipeline/pipeline.ts";
import { stashTemporarily, type WhatsApp } from "./whatsapp.ts";

export interface Deps { cfg: Config; store: Store; wa: WhatsApp; pipeline?: VoicePipeline; outbox?: OutboxRunner }

/** Every button-triggered text goes through here: with OUTBOUND_ENABLED off it is suppressed (state changes still apply). */
async function reply(d: Deps, to: string, text: string): Promise<void> {
  if (d.cfg.outboundEnabled !== true) { log("info", "outbound_suppressed", { what: "button_reply" }); return; }
  await d.wa.sendText(to, text);
}

/** Which events must come from an allowlisted technician. Fail-closed: anything not explicitly exempt needs the allowlist. */
export function requiresAllowlist(kind: InboundEvent["kind"]): boolean {
  switch (kind) {
    case "status": return false; // receipt for OUR message: `from` is the recipient. Trust = Meta signature (server.ts) + the known-wamid lookup in handleStatus
    case "audio": case "button": case "other": return true;
    default: return true; // any future/unknown kind gets no automatic authorization
  }
}

export async function handleEvent(ev: InboundEvent, d: Deps, receivedAtMs: number = Date.now()): Promise<void> {
  const base = { msg: shortId(ev.messageId), from: maskPhone(ev.from) };
  if (requiresAllowlist(ev.kind) && !d.cfg.allowedTechnicians.has(ev.from)) {
    // kind (+ message type for "other") tells what was rejected; no message id, no full number, no content
    log("warn", "unauthorized_sender", { kind: ev.kind, from: maskPhone(ev.from), ...(ev.kind === "other" ? { type: /^[a-z_]{1,24}$/.test(ev.type) ? ev.type : "unknown" } : {}) });
    return;
  }
  if (d.cfg.inboundMediaOnly === true && ev.kind === "audio") log("info", "sender_allowed", base);
  if (ev.kind === "status") return handleStatus(ev, d, base);
  if (!d.store.claimMessage(ev.messageId)) {
    log("info", "duplicate_ignored", base);
    return;
  }
  if (d.outbox) { // the technician wrote: the 24 h service window is open again (M-4: blocked deliveries are released)
    const k = techKey(ev.from);
    d.store.touchInbound(k, Date.now());
    if (d.store.releaseWindowClosed(k, Date.now()) > 0) void d.outbox.drain();
  }
  try {
    if (ev.kind === "audio") await (d.pipeline ? d.pipeline.processVoice(ev, base, receivedAtMs) : handleAudio(ev, d, base));
    else if (ev.kind === "button") await handleButton(ev, d, base);
    else if (ev.kind === "other") log("info", "message_ignored", { ...base, type: ev.type });
  } catch (e) {
    log("error", "handler_failed", { ...base, kind: ev.kind, error: errMsg(e) });
  }
}

/** Delivery receipts for OUR messages: the only trustworthy "delivered" signal (the Graph API response only means accepted). */
/** Flat log fields for Meta delivery errors. When Meta sent none, say so explicitly instead of implying details exist. */
export function describeStatusErrors(errors: MetaStatusError[] | undefined): Fields {
  const first = errors?.[0];
  if (!errors || !first) return { meta_errors: "not_provided" };
  return {
    meta_errors: errors.length, error_code: first.code ?? null, error_title: first.title ?? null, error_message: first.message ?? null,
    error_details: first.details ?? null, error_href: first.href ?? null,
    ...(errors.length > 1 ? { error_codes: errors.map((e) => e.code ?? "?").join(",") } : {}),
  };
}

function handleStatus(ev: Extract<InboundEvent, { kind: "status" }>, d: Deps, base: Fields) {
  if (!d.store.claimMessage(`status:${ev.messageId}:${ev.status}`)) return; // each status is processed once
  const rec = d.store.markDelivery(ev.messageId, ev.status, Date.now());
  if (ev.status === "failed") { // Meta could not deliver OUR message: keep the reason (the only place it is ever visible)
    log("warn", "delivery_failed", { ...base, known_message: Boolean(rec), form_id: rec?.formId ?? null, revision: rec?.revision ?? null, meta_timestamp: ev.timestamp > 0 ? ev.timestamp : null, ...describeStatusErrors(ev.errors) });
  }
  if (!rec) { log("info", "status_unknown_message", { ...base, status: ev.status }); return; } // out of order / not ours: ignored safely
  const now = Date.now();
  log("info", "delivery_status", {
    ...base, status: ev.status, form_id: rec.formId, revision: rec.revision,
    since_submit_ms: rec.submittedAt !== undefined ? now - rec.submittedAt : null,
    e2e_delivery_ms: ev.status === "delivered" && rec.receivedAt !== undefined ? now - rec.receivedAt : null, // webhook(voice) -> delivery receipt arrival
  });
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
    await reply(d, ev.from, `הטופס ${dec.formId} עודכן לגרסה ${form.revision}. נא להשתמש בהודעה העדכנית.`);
    return;
  }
  if (form.status !== "draft") {
    log("info", "button_already_handled", { ...fields, status: form.status });
    return;
  }
  if (form.fields) return handlePipelineButton(ev, d, form, dec, fields);
  d.store.setStatus(dec.formId, dec.action === "approve" ? "approved" : "editing");
  log("info", "button_click", { ...fields, context_verified: Boolean(ev.contextId) });
  await reply(d, ev.from, dec.action === "approve" ? `הטופס ${dec.formId} אושר.` : `הטופס ${dec.formId} ממתין לתיקון.`);
}

/** Buttons of forms created by the voice pipeline: signature, ownership, M-2 approval rule and the correction context (PATCH_TARGET). */
async function handlePipelineButton(ev: Extract<InboundEvent, { kind: "button" }>, d: Deps, form: Form, dec: { action: Action; formId: string; revision: number; sig?: string }, fields: Fields) {
  if (!buttonSignatureValid(dec, d.cfg.appSecret)) { // unsigned or forged id: no state change, no reply
    log("warn", "button_bad_signature", fields);
    return;
  }
  if (form.techId !== techKey(ev.from)) { // a button of someone else's form: no state change, no reply
    log("warn", "button_foreign_form", fields);
    return;
  }
  const num = form.number ?? 0;
  if (dec.action === "approve") {
    const ap = approvability(form.fields!);
    if (!ap.ok) { // M-2: needs a customer name and an address or a phone; nothing is invented to satisfy it
      log("info", "button_blocked_incomplete", { ...fields, missing: ap.missing.length });
      await reply(d, ev.from, `לא ניתן לאשר: חסר ${ap.missing.join(" ו")}. לחץ "תקן או הוסף" ושלח את הפרטים.`);
      return;
    }
    const r = d.store.approve(form.formId, form.revision, `msg:${ev.messageId}`, Date.now()); // atomic: one immutable FormVersion
    if (!r.ok) { log("info", "button_already_handled", { ...fields, reason: r.reason }); return; }
    log("info", "button_click", { ...fields, context_verified: Boolean(ev.contextId), m2_ok: true, version_seq: r.version.versionSeq, mode: r.version.mode });
    await reply(d, ev.from, `טופס #${num} אושר ונשמר.`);
    return;
  }
  d.store.setStatus(form.formId, "editing");
  d.store.setPatchTarget(form.techId!, { formId: form.formId, revision: form.revision, expiresAt: Date.now() + (d.cfg.pipeline?.patchTtlMs ?? 600000) });
  log("info", "button_click", { ...fields, context_verified: Boolean(ev.contextId), patch_context_open: true });
  const nm = form.fields!.customer_name;
  await reply(d, ev.from, nm?.shown === "VALUE" ? `מחכה לתיקון לטופס אצל ${nm.text}` : `מחכה לתיקון לטופס מספר ${num}`);
}
