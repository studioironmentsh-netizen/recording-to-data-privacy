import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------- port

export interface LlmRequest { model: string; maxTokens: number; effort: "low" | "medium" | "high"; prompt: string; timeoutMs: number }
export interface LlmResponse { text: string; stopReason: string; inputTokens: number | null; outputTokens: number | null; modelVersion: string | null }
export type LlmErrorCode = "TIMEOUT" | "RATE_LIMIT" | "SERVER" | "NETWORK" | "AUTH" | "BAD_REQUEST" | "BUDGET" | "GATE_CLOSED";

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly retryAfterS?: number;
  constructor(code: LlmErrorCode, retryAfterS?: number) {
    super(code);
    this.code = code;
    this.retryAfterS = retryAfterS;
  }
}

export interface LlmPort {
  readonly kind: "MOCK" | "REAL";
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Deterministic double: replies (or errors) are consumed in order; calls are recorded (no network). */
export class MockLlm implements LlmPort {
  readonly kind = "MOCK" as const;
  readonly requests: LlmRequest[] = [];
  private script: Array<LlmResponse | LlmError | ((req: LlmRequest) => LlmResponse | LlmError)>;
  constructor(script: MockLlm["script"]) {
    this.script = [...script];
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const next = this.script.shift();
    if (next === undefined) throw new Error("MockLlm script exhausted");
    const r = typeof next === "function" ? next(req) : next;
    if (r instanceof LlmError) throw r;
    return r;
  }
}

export function mockReply(text: string, over: Partial<LlmResponse> = {}): LlmResponse {
  return { text, stopReason: "end_turn", inputTokens: 1000, outputTokens: 500, modelVersion: "mock", ...over };
}

// ---------------------------------------------------------------- live gate + budget

export const LIVE_APPROVAL_PHRASE = "MOSHE_APPROVED_USD10_60CALLS_MAX3_PER_MESSAGE";
export const BUDGET = { maxCalls: 60, maxUsd: 10, perReceiptMax: 3, inUsdPerM: 4, outUsdPerM: 20 } as const;

export interface GateDecision { live: boolean; missing: string[] }

/** Real (billable) Anthropic calls are possible ONLY if every condition holds. Values are never returned or logged. */
export function evaluateLiveGate(env: NodeJS.ProcessEnv): GateDecision {
  const missing: string[] = [];
  if (env.EXTRACTOR_MODE !== "real") missing.push("EXTRACTOR_MODE=real");
  if (env.ANTHROPIC_LIVE_APPROVAL !== LIVE_APPROVAL_PHRASE) missing.push("ANTHROPIC_LIVE_APPROVAL (exact approval phrase)");
  if (env.ANTHROPIC_KEY_ROTATION_CONFIRMED !== "yes") missing.push("ANTHROPIC_KEY_ROTATION_CONFIRMED=yes (exposed key revoked, new key issued)");
  const key = env.ANTHROPIC_API_KEY ?? "";
  if (!key.startsWith("sk-ant-") || key.length < 20) missing.push("ANTHROPIC_API_KEY (new key)");
  return { live: missing.length === 0, missing };
}

interface Ledger { calls: number; usd: number }

/** Persistent spend ledger; every call is reserved BEFORE it is made. */
/** Effective spend cap: min(approved experiment ceiling $10, the account balance the operator configured). Invalid values close the gate. */
export function budgetCapUsd(env: NodeJS.ProcessEnv): number {
  const raw = env.ANTHROPIC_BUDGET_USD;
  if (raw === undefined || raw === "") return BUDGET.maxUsd;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new LlmError("GATE_CLOSED");
  return Math.min(v, BUDGET.maxUsd);
}

export class BudgetLedger {
  private file: string;
  private maxUsd: number;
  constructor(dir: string, maxUsd: number = BUDGET.maxUsd) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "anthropic_ledger.json"); // lives in DATA_DIR, independent of the API key: switching keys never resets the counters
    this.maxUsd = Math.min(maxUsd, BUDGET.maxUsd);
  }
  private load(): Ledger {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Ledger) : { calls: 0, usd: 0 };
  }
  private save(l: Ledger) {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(l));
    renameSync(tmp, this.file);
  }
  snapshot(): Ledger { return this.load(); }
  /** Reserve a call worst case (full max output). Throws BUDGET if it could exceed the approved limits. */
  reserve(maxOutputTokens: number): void {
    const l = this.load();
    const worst = (maxOutputTokens * BUDGET.outUsdPerM) / 1e6;
    if (l.calls + 1 > BUDGET.maxCalls || l.usd + worst > this.maxUsd) throw new LlmError("BUDGET");
    l.calls += 1;
    l.usd += worst; // provisional, corrected in settle()
    this.save(l);
  }
  settle(maxOutputTokens: number, inTok: number | null, outTok: number | null): void {
    const l = this.load();
    const worst = (maxOutputTokens * BUDGET.outUsdPerM) / 1e6;
    const actual = inTok !== null && outTok !== null ? (inTok * BUDGET.inUsdPerM + outTok * BUDGET.outUsdPerM) / 1e6 : worst;
    l.usd = Math.max(0, l.usd - worst + actual);
    this.save(l);
  }
}

// ---------------------------------------------------------------- real client (official SDK), only behind the gate

export class AnthropicLlm implements LlmPort {
  readonly kind = "REAL" as const;
  private client: Anthropic;
  private ledger: BudgetLedger;
  private constructor(client: Anthropic, ledger: BudgetLedger) {
    this.client = client;
    this.ledger = ledger;
  }

  /** The only way to obtain a real client. Throws (and never constructs the SDK client) while the gate is closed. */
  static create(env: NodeJS.ProcessEnv, dataDir: string): AnthropicLlm {
    const gate = evaluateLiveGate(env);
    if (!gate.live) throw new LlmError("GATE_CLOSED");
    // maxRetries 0: retries belong to the pipeline policy (bounded, counted, shared quota of 3 calls per message).
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 });
    return new AnthropicLlm(client, new BudgetLedger(dataDir, budgetCapUsd(env)));
  }

  /** Test seam: wraps an already-built (fake) client. Not reachable from configuration, so it cannot open the live gate. */
  static fromClientForTests(client: Pick<Anthropic, "messages">, ledger: BudgetLedger): AnthropicLlm {
    return new AnthropicLlm(client as Anthropic, ledger);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.ledger.reserve(req.maxTokens);
    try {
      // Same request shape as the approved comparison round: effort via output_config, no sampling params, no prefill,
      // no server-side fallback model (SRS FP-11: fallback to another model is OFF).
      const res = await this.client.messages.create(
        { model: req.model, max_tokens: req.maxTokens, output_config: { effort: req.effort }, messages: [{ role: "user", content: req.prompt }] },
        { timeout: req.timeoutMs },
      );
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      this.ledger.settle(req.maxTokens, res.usage?.input_tokens ?? null, res.usage?.output_tokens ?? null);
      return { text, stopReason: String(res.stop_reason ?? ""), inputTokens: res.usage?.input_tokens ?? null, outputTokens: res.usage?.output_tokens ?? null, modelVersion: res.model ?? null };
    } catch (e) {
      throw mapSdkError(e);
    }
  }
}

function mapSdkError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new LlmError("TIMEOUT");
  if (e instanceof Anthropic.APIConnectionError) return new LlmError("NETWORK");
  if (e instanceof Anthropic.RateLimitError) {
    const ra = Number(e.headers?.get?.("retry-after") ?? NaN);
    return new LlmError("RATE_LIMIT", Number.isFinite(ra) ? ra : undefined);
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new LlmError("AUTH");
  if (e instanceof Anthropic.APIError) return new LlmError((e.status ?? 500) >= 500 ? "SERVER" : "BAD_REQUEST");
  return new LlmError("NETWORK");
}
