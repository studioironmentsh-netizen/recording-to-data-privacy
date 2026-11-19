import { createHash } from "node:crypto";
import type { Config } from "../config.ts";
import type { InboundEvent } from "../events.ts";
import { errMsg, log, type Fields } from "../logger.ts";
import type { Store } from "../store.ts";
import { writeTempAudio, type WhatsApp } from "../whatsapp.ts";
import type { StructuredExtractor } from "./extractor.ts";
import { approvability, formatDate, mergePatch, renderForm, toStoredFields } from "./formview.ts";
import { SttError, type SttPort } from "./stt.ts";

export const MSG = {
  ACK: "קיבלתי את סיכום הביקור. מכין טופס לבדיקה.",
  FAIL_NEW: "לא הצלחתי ליצור טופס מההקלטה. נא לשלוח שוב.",
  NO_CONTENT: "לא זיהיתי מידע על ביקור. שלח שוב, או כתוב את הפרטים.",
  FAIL_PATCH: (minutes: number) => `לא הצלחתי לעדכן את הטופס מההודעה. אפשר לשלוח שוב בתוך ${minutes} דקות.`,
  EXTRACTION_OFF: "קיבלתי את ההקלטה. חילוץ הטופס כבוי כרגע בסביבת הפיתוח (ממתין לאישור).",
} as const;

export interface PipelineDeps {
  cfg: Config;
  store: Store;
  wa: WhatsApp;
  stt: SttPort;
  extractor: StructuredExtractor | null; // null => transcribe-only dry run (no Claude)
  now?: () => Date;
  mockWatermark?: boolean;
}

/** Stable, non-reversible technician key for local state (the WhatsApp number itself is not stored). */
export function techKey(waId: string): string {
  return createHash("sha256").update(waId).digest("hex").slice(0, 16);
}

export class VoicePipeline {
  private d: PipelineDeps;
  constructor(d: PipelineDeps) {
    this.d = d;
  }

  async processVoice(ev: Extract<InboundEvent, { kind: "audio" }>, base: Fields, receivedAtMs: number): Promise<void> {
    const { cfg, store, wa, stt, extractor } = this.d;
    const now = this.d.now ?? (() => new Date());
    const t: Record<string, number> = {};
    const mark = (k: string, t0: number) => { t[k] = Math.round(performance.now() - t0); };
    const start = performance.now();
    t.queue_wait_ms = Math.max(0, Date.now() - receivedAtMs);
    const key = techKey(ev.from);
    const jobId = createHash("sha256").update(ev.messageId).digest("hex").slice(0, 24);
    if (cfg.pipeline?.ackEnabled) void wa.sendText(ev.from, MSG.ACK).catch((e) => log("warn", "ack_failed", { ...base, error: errMsg(e) }));

    let temp: { path: string; cleanup: () => void } | null = null;
    try {
      // 1) media download (Meta -> private temp file, deleted in finally)
      let p0 = performance.now();
      const media = await wa.fetchMedia(ev.mediaId);
      temp = writeTempAudio(cfg.dataDir, media.bytes, jobId);
      mark("media_download_ms", p0);

      // 2) local STT (audio decode is inside the worker; reported separately)
      p0 = performance.now();
      let transcript: string;
      try {
        const r = await stt.transcribe(temp.path, jobId);
        transcript = r.text;
        t.audio_s = r.audioDurationS;
        t.stt_decode_ms = Math.round(r.decodeS * 1000);
        t.stt_transcribe_ms = Math.round(r.transcribeS * 1000);
      } catch (e) {
        mark("stt_ms", p0);
        const code = e instanceof SttError ? e.code : "STT_FAILED";
        log("error", "stt_failed", { ...base, code, ...t });
        await wa.sendText(ev.from, MSG.FAIL_NEW);
        return;
      }
      mark("stt_ms", p0);
      temp.cleanup(); // audio is no longer needed once transcribed
      temp = null;

      if (!extractor) {
        await wa.sendText(ev.from, MSG.EXTRACTION_OFF);
        mark("total_ms", start);
        log("info", "pipeline_done", { ...base, mode: "transcribe_only", transcript_chars: transcript.length, ...t });
        return;
      }
      if (transcript.trim().split(/\s+/).filter(Boolean).length < 2) { // BA-02 shortcut: nothing to extract, no API call
        await wa.sendText(ev.from, MSG.NO_CONTENT);
        log("info", "pipeline_done", { ...base, outcome: "no_content", ...t });
        return;
      }

      // 3) Claude extraction (<=3 calls) + validation + controls
      p0 = performance.now();
      const out = await extractor.extract(transcript);
      mark("extraction_ms", p0);
      t.ai_calls = out.attempts.length;
      t.ai_in_tokens = out.attempts.reduce((a, x) => a + (x.inputTokens ?? 0), 0);
      t.ai_out_tokens = out.attempts.reduce((a, x) => a + (x.outputTokens ?? 0), 0);
      t.ai_first_call_ms = out.attempts[0]?.ms ?? 0;

      const target = store.getPatchTarget(key);
      const patchForm = target && target.expiresAt > now().getTime() ? store.getForm(target.formId) : undefined;
      const isPatch = Boolean(patchForm && patchForm.fields && patchForm.revision === target!.revision && patchForm.status === "editing");

      if (!out.ok) {
        const outcome = out.code;
        log(out.code === "NO_BUSINESS_CONTENT" ? "info" : "warn", "extraction_failed", { ...base, code: outcome, ...t });
        const minutes = Math.round((cfg.pipeline?.patchTtlMs ?? 600000) / 60000);
        await wa.sendText(ev.from, isPatch ? MSG.FAIL_PATCH(minutes) : out.code === "NO_BUSINESS_CONTENT" ? MSG.NO_CONTENT : MSG.FAIL_NEW);
        return;
      }

      // 4) form (new draft or patch -> new revision)
      p0 = performance.now();
      const fresh = toStoredFields(out.presented, out.rejectedFields);
      let number: number, formId: string, revision: number, fields = fresh, captureDate: string, mock: boolean;
      if (isPatch && patchForm) {
        const merged = mergePatch(patchForm.fields!, fresh); // SALV-R11: only verified new values replace old ones
        if (merged.changed.length === 0) {
          await wa.sendText(ev.from, MSG.FAIL_PATCH(Math.round((cfg.pipeline?.patchTtlMs ?? 600000) / 60000)));
          log("info", "patch_no_change", { ...base, form_id: patchForm.formId, ...t });
          return;
        }
        fields = merged.fields;
        number = patchForm.number!;
        formId = patchForm.formId;
        revision = patchForm.revision + 1;
        captureDate = patchForm.captureDate!;
        mock = Boolean(patchForm.mock) || out.providerKind === "MOCK";
        log("info", "patch_applied", { ...base, form_id: formId, revision, changed_fields: merged.changed.length });
      } else {
        number = store.nextNumber();
        formId = `F${number}`;
        revision = 1;
        captureDate = formatDate(now());
        mock = out.providerKind === "MOCK";
      }
      const partial = Object.values(fields).some((f) => f.text.endsWith("לתיקון"));
      store.saveDraft({ formId, revision, status: "draft", number, techId: key, fields, captureDate, partial, mock });
      const text = renderForm({ number, revision, fields, captureDate, partial, mockWatermark: mock && (this.d.mockWatermark ?? true) });
      mark("form_build_ms", p0);

      // 5) outbound (exactly two buttons); Meta acceptance != delivery
      p0 = performance.now();
      const wamid = await wa.sendFormMessage(ev.from, text, formId, revision);
      store.recordSent(wamid, formId, revision);
      if (isPatch) store.clearPatchTarget(key);
      mark("whatsapp_send_ms", p0);
      mark("total_ms", start);
      const ap = approvability(fields);
      log("info", "form_sent", { ...base, form_id: formId, revision, approvable: ap.ok, partial, rejected_fields: out.rejectedFields.length, ...t });
    } catch (e) {
      log("error", "pipeline_failed", { ...base, error: errMsg(e) });
      try { await wa.sendText(ev.from, MSG.FAIL_NEW); } catch { /* best effort */ }
    } finally {
      temp?.cleanup(); // success, failure and exceptions: the audio file never outlives the job
    }
  }
}
