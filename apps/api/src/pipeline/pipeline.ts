import { createHash } from "node:crypto";
import type { Config } from "../config.ts";
import type { InboundEvent } from "../events.ts";
import { errMsg, log, type Fields } from "../logger.ts";
import type { Form, Store } from "../store.ts";
import { writeTempAudio, type WhatsApp } from "../whatsapp.ts";
import type { StructuredExtractor } from "./extractor.ts";
import { formatDate, mergePatch, toStoredFields } from "./formview.ts";
import type { OutboxRunner } from "./outbox.ts";
import { SttError, type SttPort } from "./stt.ts";
import { techKey } from "./techkey.ts";

export { techKey };

export const MSG = {
  ACK: "קיבלתי את סיכום הביקור. מכין טופס לבדיקה.",
  FAIL_NEW: "לא הצלחתי ליצור טופס מההקלטה. נא לשלוח שוב.",
  NO_CONTENT: "לא זיהיתי מידע על ביקור. שלח שוב, או כתוב את הפרטים.",
  FAIL_PATCH: (minutes: number) => `לא הצלחתי לעדכן את הטופס מההודעה. אפשר לשלוח שוב בתוך ${minutes} דקות.`,
  EXTRACTION_OFF: "קיבלתי את ההקלטה. חילוץ הטופס כבוי כרגע בסביבת הפיתוח (ממתין לאישור).",
} as const;

/** Container guess from magic bytes only (diagnostics; never logs content). */
export function sniffAudioContainer(b: Buffer): string {
  if (b.length >= 4 && b.toString("latin1", 0, 4) === "OggS") return "ogg";
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp") return "mp4/m4a";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WAVE") return "wav";
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return "webm/matroska";
  if (b.length >= 3 && (b.toString("latin1", 0, 3) === "ID3" || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0))) return "mp3";
  return "unknown";
}

export interface PipelineDeps {
  cfg: Config;
  store: Store;
  wa: WhatsApp;
  stt: SttPort;
  extractor: StructuredExtractor | null; // null => transcribe-only dry run (no Claude)
  outbox: OutboxRunner;
  now?: () => Date;
}

export class VoicePipeline {
  private d: PipelineDeps;
  constructor(d: PipelineDeps) {
    this.d = d;
  }

  /** Crash recovery at startup: receipts left in PROCESSING lost their audio; the technician is told (once, durably) to resend. */
  recoverAfterRestart(): { receipts: number; outbox: number } {
    const { store } = this.d;
    const dead = store.recoverReceipts();
    for (const r of dead) {
      store.enqueueText({ key: `text:recover:${r.id}`, techKey: r.techKey, kind: "TEXT", text: MSG.FAIL_NEW, status: "PENDING", attempts: 0, nextAt: 0, createdAt: Date.now() });
    }
    return { receipts: dead.length, outbox: store.recoverOutbox() };
  }

  async processVoice(ev: Extract<InboundEvent, { kind: "audio" }>, base: Fields, receivedAtMs: number): Promise<void> {
    const { cfg, store, wa, stt, extractor, outbox } = this.d;
    const now = this.d.now ?? (() => new Date());
    const t: Record<string, number> = {};
    const start = performance.now();
    const at = (k: string) => { t[k] = Math.round(performance.now() - start) + (t.webhook_to_start_ms ?? 0); }; // ms since the webhook was received
    const span = (k: string, t0: number) => { t[k] = Math.round(performance.now() - t0); };
    t.webhook_to_start_ms = Math.max(0, Date.now() - receivedAtMs);
    const key = techKey(ev.from);
    const jobId = createHash("sha256").update(ev.messageId).digest("hex").slice(0, 24);

    // T01: the receipt exists BEFORE any AI call; duplicates/retries of this message can never create a second Visit/Draft.
    const target = store.getPatchTarget(key);
    const patchForm = target && target.expiresAt > now().getTime() ? store.getForm(target.formId) : undefined;
    const isPatch = Boolean(patchForm && patchForm.fields && patchForm.revision === target!.revision && patchForm.status === "editing");
    store.beginReceipt(ev.messageId, key, isPatch ? "PATCH" : "NEW", receivedAtMs);

    // OUTBOUND_ENABLED gate (safe test mode): with outbound off, nothing below may reach the sender; the pipeline still runs and saves.
    const mediaOnly = cfg.inboundMediaOnly === true; // diagnostic stop right after the media download
    const outbound = cfg.outboundEnabled === true && !mediaOnly;
    if (!outbound) log("info", "outbound_suppressed", { ...base, what: "notices_and_form_delivery" });
    if (outbound && cfg.pipeline?.ackEnabled) void wa.sendText(ev.from, MSG.ACK).catch((e) => log("warn", "ack_failed", { ...base, error: errMsg(e) }));
    const notify = async (text: string) => { // every user-facing text of this job goes through here
      if (!outbound) return;
      try { await wa.sendText(ev.from, text); } catch (e) { log("warn", "failure_notice_not_sent", { ...base, error: errMsg(e) }); }
    };
    const fail = async (text: string, code: string) => {
      store.finishReceipt(ev.messageId, "FAILED", { failure: code });
      await notify(text);
    };

    let temp: { path: string; cleanup: () => void } | null = null;
    try {
      // 1) media download (Meta -> private temp file, always deleted in finally)
      let p0 = performance.now();
      const media = await wa.fetchMedia(ev.mediaId);
      if (mediaOnly) { // INBOUND_MEDIA_ONLY: proof that Meta delivered the audio and it was downloaded. No temp file is ever written, no STT, no Claude, no form.
        span("media_download_ms", p0);
        log("info", "media_download_succeeded", { ...base, media_download_ms: t.media_download_ms, mime: media.mime || ev.mime, container: sniffAudioContainer(media.bytes), size: media.bytes.length, voice: ev.voice });
        store.finishReceipt(ev.messageId, "MEDIA_ONLY"); // terminal: never left PROCESSING (a restart would otherwise turn it into FAILED + a queued notice)
        log("info", "media_only_stopped_before_stt", base);
        return;
      }
      temp = writeTempAudio(cfg.dataDir, media.bytes, jobId);
      span("media_download_ms", p0);
      at("t_media_download_completed_ms");

      // 2) local STT (the transcript lives only in this function's memory)
      p0 = performance.now();
      at("t_stt_started_ms");
      let transcript: string;
      try {
        const r = await stt.transcribe(temp.path, jobId);
        transcript = r.text;
        t.audio_s = r.audioDurationS;
        t.stt_decode_ms = Math.round(r.decodeS * 1000);
        t.stt_transcribe_ms = Math.round(r.transcribeS * 1000);
      } catch (e) {
        span("stt_ms", p0);
        const code = e instanceof SttError ? e.code : "STT_FAILED";
        log("error", "stt_failed", { ...base, code, ...t });
        await fail(MSG.FAIL_NEW, code);
        return;
      }
      span("stt_ms", p0);
      at("t_stt_completed_ms");
      temp.cleanup(); // audio is no longer needed once transcribed
      temp = null;

      if (!extractor) {
        store.finishReceipt(ev.messageId, "FAILED", { failure: "EXTRACTION_DISABLED" });
        await notify(MSG.EXTRACTION_OFF);
        span("total_ms", start);
        log("info", "pipeline_done", { ...base, mode: "transcribe_only", transcript_chars: transcript.length, ...t });
        return;
      }
      if (transcript.trim().split(/\s+/).filter(Boolean).length < 2) { // BA-02 shortcut: nothing to extract, no API call
        await fail(MSG.NO_CONTENT, "NO_CONTENT");
        log("info", "pipeline_done", { ...base, outcome: "no_content", ...t });
        return;
      }

      // 3) Claude extraction (<=3 calls) + NORM-2.0 + validation + controls
      p0 = performance.now();
      at("t_extraction_started_ms");
      const out = await extractor.extract(transcript);
      span("extraction_ms", p0);
      at("t_extraction_completed_ms");
      t.ai_calls = out.attempts.length;
      t.ai_in_tokens = out.attempts.reduce((a, x) => a + (x.inputTokens ?? 0), 0);
      t.ai_out_tokens = out.attempts.reduce((a, x) => a + (x.outputTokens ?? 0), 0);
      t.ai_llm_ms_total = out.attempts.reduce((a, x) => a + x.llmMs, 0);
      t.ai_first_call_ms = out.attempts[0]?.llmMs ?? 0;
      t.validation_ms = out.attempts.reduce((a, x) => a + x.validationMs, 0);
      at("t_validation_completed_ms");

      if (!out.ok) {
        log(out.code === "NO_BUSINESS_CONTENT" ? "info" : "warn", "extraction_failed", { ...base, code: out.code, ...t });
        const minutes = Math.round((cfg.pipeline?.patchTtlMs ?? 600000) / 60000);
        await fail(isPatch ? MSG.FAIL_PATCH(minutes) : out.code === "NO_BUSINESS_CONTENT" ? MSG.NO_CONTENT : MSG.FAIL_NEW, out.code); // the previous revision stays untouched
        return;
      }

      // 4) form (new draft or patch -> new revision); draft + outbox entry are committed in ONE transaction
      p0 = performance.now();
      const fresh = toStoredFields(out.presented, out.rejectedFields, out.quantityRejected);
      let fields = fresh, form: Form;
      if (isPatch && patchForm) {
        const merged = mergePatch(patchForm.fields!, fresh); // SALV-R11: only verified new values replace old ones
        if (merged.changed.length === 0) {
          await fail(MSG.FAIL_PATCH(Math.round((cfg.pipeline?.patchTtlMs ?? 600000) / 60000)), "PATCH_NO_CHANGE");
          log("info", "patch_no_change", { ...base, form_id: patchForm.formId, ...t });
          return;
        }
        fields = merged.fields;
        form = { ...patchForm, revision: patchForm.revision + 1, status: "draft", fields, mock: Boolean(patchForm.mock) || out.providerKind === "MOCK" };
        log("info", "patch_applied", { ...base, form_id: form.formId, revision: form.revision, changed_fields: merged.changed.length });
      } else {
        const number = store.nextNumber();
        form = { formId: `F${number}`, revision: 1, status: "draft", number, techId: key, fields, captureDate: formatDate(now()), mock: out.providerKind === "MOCK" };
      }
      const flagged = Object.entries(fields).filter(([, f]) => f.text.endsWith("לתיקון")).map(([k]) => k);
      form.flagged = flagged;
      form.partial = flagged.length > 0;
      form.mode = flagged.length > 0 ? "PARTIAL" : "FULL";
      store.saveDraftAndEnqueue(form, {
        key: `form:${form.formId}:${form.revision}`, techKey: key, kind: "FORM", formId: form.formId, revision: form.revision,
        status: "PENDING", attempts: 0, nextAt: 0, createdAt: Date.now(), receiptReceivedAt: receivedAtMs,
      }, ev.messageId);
      if (isPatch) store.clearPatchTarget(key);
      span("form_build_ms", p0);
      at("t_draft_saved_ms");

      // 5) outbound through the durable outbox; "submitted" = accepted by the Meta API, NOT delivered to the phone
      p0 = performance.now();
      await outbox.drain();
      span("outbound_ms", p0);
      at("t_outbound_submitted_ms");
      span("total_ms", start);
      const entry = store.getOutbox(`form:${form.formId}:${form.revision}`);
      log("info", entry?.status === "SENT" ? "form_sent" : outbound ? "form_saved_delivery_pending" : "form_saved_outbound_disabled", {
        ...base, form_id: form.formId, revision: form.revision, mode: form.mode, flagged_fields: flagged.length, outbox: entry?.status ?? "MISSING",
        qty_normalized: out.quantityNormalized, qty_rejected: out.quantityRejected, ...t,
      });
    } catch (e) {
      log("error", "pipeline_failed", { ...base, error: errMsg(e) });
      await fail(MSG.FAIL_NEW, "PIPELINE_ERROR");
    } finally {
      temp?.cleanup(); // success, failure and exceptions: the audio file never outlives the job
    }
  }
}
