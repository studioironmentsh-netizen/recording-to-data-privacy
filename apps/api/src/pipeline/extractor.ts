import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIELD_KEYS, validate, type Problem } from "./contract/validate-extraction.ts";
import type { ControlsPort, Presented } from "./controls.ts";
import { LlmError, BUDGET, type LlmPort } from "./llm.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROMPT_FILE = join(HERE, "contract", "extraction_prompt_v4_ba03.txt");
/** Exact API model id used in the approved comparison round (research/stage_b/model_comparison/compare_config.json). Never substituted. */
export const MODEL_ID = "claude-opus-5-5";
const USABILITY_GROUP = ["customer_name", "customer_address", "customer_phone", "work_summary", "spare_parts", "parts_price", "visit_price", "next_visit"];
const VAT = ["parts_vat_basis", "visit_vat_basis"];

export interface ExtractorConfig {
  maxOutputTokens: number; // first-call value (16000 in the approved experiment)
  maxOutputTokensCeiling: number; // SALV-R16
  timeoutMs: number; // per call
  deadlineMs: number; // 180 s total per receipt
  attemptsMax: number; // clamped to 3
  effort: "low" | "medium" | "high";
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  jitter?: () => number;
}

export const DEFAULT_EXTRACTOR_CONFIG: ExtractorConfig = {
  maxOutputTokens: 16000, maxOutputTokensCeiling: 32000, timeoutMs: 120000, deadlineMs: 180000, attemptsMax: 3, effort: "low",
};

export type FailureCode =
  | "LLM_REJECTED" | "LLM_REFUSAL" | "LLM_UNAVAILABLE" | "LLM_BUDGET" | "LLM_GATE_CLOSED" | "UNPARSEABLE" | "ENVELOPE_INVALID"
  | "NOTHING_TO_SALVAGE" | "NO_BUSINESS_CONTENT" | "DEADLINE" | "CONTROLS_FAILED";

export interface AttemptLog { n: number; outcome: string; ms: number; inputTokens: number | null; outputTokens: number | null }
export type ExtractionOutcome =
  | { ok: true; presented: Presented; attempts: AttemptLog[]; rejectedFields: string[]; promptSha256: string; providerKind: "MOCK" | "REAL" }
  | { ok: false; code: FailureCode; attempts: AttemptLog[] };

export function loadPromptTemplate(): string {
  return readFileSync(PROMPT_FILE, "utf8");
}

/** Function replacer: transcript text can contain `$&` etc. and must be inserted verbatim. */
export function buildPrompt(template: string, transcript: string): string {
  return template.replace("{{TRANSCRIPT}}", () => transcript);
}

/** SALV-R2 / P1: deterministic syntactic extraction of ONE JSON object. No repairing: unbalanced or invalid input -> null. */
export function parseSingleJsonObject(raw: string): unknown | null {
  let s = raw.replace(/^﻿/, "").trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/.exec(s);
  if (fence) s = fence[1]!.trim();
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

const MODEL_KEYS = ["extracted_fields", "field_states", "clarification_requests", "unassigned_business_info"];

function assemble(model: any, meta: { providerKind: "MOCK" | "REAL"; modelVersion: string | null; promptSha: string; inputSha: string; ms: number; usage: AttemptLog }): any {
  return {
    contract_version: "STAGEB-EXTRACTION-1.0.0", template_version: "ac-pilot-srs46-0.1", ...model,
    extraction_metadata: {
      provider_id: "anthropic", provider_kind: meta.providerKind, extractor_version: MODEL_ID, model_id: MODEL_ID, model_version: meta.modelVersion ?? "UNREPORTED",
      pipeline_type: "B_STT_TRANSCRIPT", prompt_version: "extraction_prompt_v4_layerA_neutral_ba03", prompt_sha256: meta.promptSha, input_id: "receipt", input_sha256: meta.inputSha,
      timing_ms: Math.round(meta.ms), usage: { input_units: meta.usage.inputTokens, output_units: meta.usage.outputTokens, measured: meta.usage.inputTokens !== null },
    },
  };
}

/** Field a validator problem belongs to, or null for an envelope (S-DOC) problem. */
export function fieldOfProblem(p: Problem): string | null {
  const m = /^\$\.(?:extracted_fields|field_states)\.([a-z_]+)/.exec(p.path);
  return m && (FIELD_KEYS as readonly string[]).includes(m[1]!) ? m[1]! : null;
}

/** SALV-R4: a rejected field becomes empty and marked; nothing is repaired or invented. */
export function rejectField(doc: any, k: string): void {
  doc.extracted_fields[k] = { value: VAT.includes(k) ? "UNKNOWN" : null, evidence_state: "UNCLEAR", needs_clarification: true };
  doc.field_states[k] = { uncertainty_reason: "AMBIGUOUS_REFERENCE", evidence_quote: null };
  doc.clarification_requests = (doc.clarification_requests ?? []).filter((c: any) => !(c.field_keys ?? []).includes(k));
  doc.clarification_requests.push({ field_keys: [k], reason_code: "AMBIGUOUS_REFERENCE", candidate: null });
}

type SalvageResult = { kind: "DOC_FAIL" } | { kind: "OK"; doc: any; rejected: string[] };

function salvage(doc: any, transcript: string): SalvageResult {
  let rejected: string[] = [];
  for (let pass = 0; pass < 3; pass++) {
    const r = validate("extraction", doc, { transcript });
    if (r.ok) return { kind: "OK", doc, rejected };
    const fields = r.problems.map(fieldOfProblem);
    if (fields.some((f) => f === null)) return { kind: "DOC_FAIL" };
    const set = [...new Set(fields as string[])];
    for (const k of set) rejectField(doc, k);
    rejected = [...new Set([...rejected, ...set])];
  }
  return { kind: "DOC_FAIL" };
}

export class StructuredExtractor {
  private llm: LlmPort;
  private controls: ControlsPort;
  private cfg: ExtractorConfig;
  private template: string;
  private promptSha: string;
  constructor(llm: LlmPort, controls: ControlsPort, cfg: Partial<ExtractorConfig> = {}) {
    this.llm = llm;
    this.controls = controls;
    this.cfg = { ...DEFAULT_EXTRACTOR_CONFIG, ...cfg };
    this.cfg.attemptsMax = Math.min(this.cfg.attemptsMax, BUDGET.perReceiptMax); // hard ceiling: 3 calls per message
    this.template = loadPromptTemplate();
    this.promptSha = createHash("sha256").update(this.template).digest("hex");
  }

  async extract(transcript: string): Promise<ExtractionOutcome> {
    const sleep = this.cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.cfg.now ?? Date.now;
    const jitter = this.cfg.jitter ?? Math.random;
    const t0 = now();
    const attempts: AttemptLog[] = [];
    const inputSha = createHash("sha256").update(transcript).digest("hex");
    const prompt = buildPrompt(this.template, transcript);
    let maxTokens = this.cfg.maxOutputTokens;
    let lastCode: FailureCode = "NOTHING_TO_SALVAGE";
    let backoffIdx = 0;

    while (attempts.length < this.cfg.attemptsMax) {
      if (now() - t0 >= this.cfg.deadlineMs) return { ok: false, code: "DEADLINE", attempts };
      const n = attempts.length + 1;
      const a0 = now();
      const log = (outcome: string, inTok: number | null = null, outTok: number | null = null) => attempts.push({ n, outcome, ms: now() - a0, inputTokens: inTok, outputTokens: outTok });

      let res;
      try {
        res = await this.llm.complete({ model: MODEL_ID, maxTokens, effort: this.cfg.effort, prompt, timeoutMs: this.cfg.timeoutMs });
      } catch (e) {
        const code = e instanceof LlmError ? e.code : "NETWORK";
        log(`LLM_${code}`);
        if (code === "BUDGET") return { ok: false, code: "LLM_BUDGET", attempts };
        if (code === "GATE_CLOSED") return { ok: false, code: "LLM_GATE_CLOSED", attempts };
        if (code === "AUTH" || code === "BAD_REQUEST") return { ok: false, code: "LLM_REJECTED", attempts }; // FP-04: no retry
        lastCode = "LLM_UNAVAILABLE"; // TIMEOUT / RATE_LIMIT / SERVER / NETWORK: FP-01..03, exponential 2->6 s with jitter
        const waitMs = code === "RATE_LIMIT" && e instanceof LlmError && e.retryAfterS !== undefined
          ? Math.min(e.retryAfterS, 60) * 1000 : [2000, 6000][Math.min(backoffIdx++, 1)]! + jitter() * 500;
        if (attempts.length < this.cfg.attemptsMax) {
          if (now() - t0 + waitMs >= this.cfg.deadlineMs) return { ok: false, code: "DEADLINE", attempts };
          await sleep(waitMs);
        }
        continue;
      }

      if (res.stopReason === "refusal") { log("REFUSAL", res.inputTokens, res.outputTokens); return { ok: false, code: "LLM_REFUSAL", attempts }; } // N4: no retry
      if (res.stopReason === "max_tokens") { // SALV-R16: unparseable; one retry only if below the ceiling
        log("TRUNCATED", res.inputTokens, res.outputTokens);
        if (maxTokens >= this.cfg.maxOutputTokensCeiling) return { ok: false, code: "UNPARSEABLE", attempts };
        maxTokens = this.cfg.maxOutputTokensCeiling;
        lastCode = "UNPARSEABLE";
        continue;
      }

      const model = parseSingleJsonObject(res.text) as any; // P1
      const keys = model ? Object.keys(model) : [];
      if (!model || !MODEL_KEYS.every((k) => keys.includes(k)) || keys.some((k) => !MODEL_KEYS.includes(k))) {
        log("UNPARSEABLE_OR_ENVELOPE", res.inputTokens, res.outputTokens);
        lastCode = model ? "ENVELOPE_INVALID" : "UNPARSEABLE";
        continue; // SALV-R2: one more attempt within the shared quota
      }
      const doc = assemble(model, { providerKind: this.llm.kind, modelVersion: res.modelVersion, promptSha: this.promptSha, inputSha, ms: now() - a0, usage: { n, outcome: "", ms: 0, inputTokens: res.inputTokens, outputTokens: res.outputTokens } });

      const s = salvage(doc, transcript); // P2/P3
      if (s.kind === "DOC_FAIL") { log("ENVELOPE_INVALID", res.inputTokens, res.outputTokens); lastCode = "ENVELOPE_INVALID"; continue; }

      // BA-02: a valid answer in which nothing business-related was said does not open a draft and is not retried.
      if (FIELD_KEYS.every((k) => ["MISSING", "UNKNOWN"].includes(s.doc.extracted_fields[k].evidence_state))) {
        log("NO_BUSINESS_CONTENT", res.inputTokens, res.outputTokens);
        return { ok: false, code: "NO_BUSINESS_CONTENT", attempts };
      }

      let presented: Presented;
      try { presented = await this.controls.present(s.doc, transcript); } // P3 controls K1..K8 + presenter
      catch { log("CONTROLS_FAILED", res.inputTokens, res.outputTokens); return { ok: false, code: "CONTROLS_FAILED", attempts }; }

      const classes = presented.presentation;
      const verifiedU = USABILITY_GROUP.filter((k) => classes[k]?.class === "VERIFIED").length;
      const nonMissing = FIELD_KEYS.filter((k) => !["MISSING"].includes(classes[k]?.class ?? "MISSING") && presented.displayed.extracted_fields[k].evidence_state !== "UNKNOWN");
      const evidenceRejected = FIELD_KEYS.filter((k) => (classes[k]?.control_codes ?? []).some((c) => /^K1_|^K2_/.test(c)) || s.rejected.includes(k));
      const systematic = evidenceRejected.length >= 3 && nonMissing.length > 0 && evidenceRejected.length >= 0.5 * (nonMissing.length + 0); // N3 (defaults, uncalibrated)
      if (verifiedU === 0 || systematic) { // N1 / N3: one more attempt if the quota allows (SALV-R9)
        log(verifiedU === 0 ? "N1_NOTHING_VERIFIED" : "N3_SYSTEMATIC_REJECTION", res.inputTokens, res.outputTokens);
        lastCode = "NOTHING_TO_SALVAGE";
        continue;
      }
      log("ACCEPTED", res.inputTokens, res.outputTokens);
      const rejectedFields = FIELD_KEYS.filter((k) => classes[k]?.value_removed || s.rejected.includes(k));
      return { ok: true, presented, attempts, rejectedFields, promptSha256: this.promptSha, providerKind: this.llm.kind };
    }
    return { ok: false, code: lastCode, attempts };
  }
}
