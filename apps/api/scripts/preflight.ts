// READ-ONLY live-readiness preflight. Changes nothing, sends nothing, never prints a secret value, never turns LIVE mode on.
// Usage: npm run preflight [-- --skip-worker] [-- --full-hash]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { BudgetLedger, BUDGET, budgetCapUsd, evaluateLiveGate } from "../src/pipeline/llm.ts";
import { PythonSttWorker } from "../src/pipeline/stt.ts";

type Level = "PASS" | "FAIL" | "WARN" | "BLOCKED" | "INFO";
const rows: Array<{ level: Level; check: string; detail: string }> = [];
const add = (level: Level, check: string, detail: string) => rows.push({ level, check, detail });
const env = process.env;
const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const set = (k: string) => Boolean(env[k]) && !String(env[k]).startsWith("replace_with");

// ---- Meta / WhatsApp configuration (structure only)
for (const k of ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_PHONE_NUMBER_ID", "ALLOWED_TECHNICIAN_WA_IDS"]) {
  add(set(k) ? "PASS" : "FAIL", `env ${k}`, set(k) ? "present" : "missing or placeholder");
}
if (set("WHATSAPP_PHONE_NUMBER_ID")) add(/^\d{5,20}$/.test(env.WHATSAPP_PHONE_NUMBER_ID!) ? "PASS" : "FAIL", "phone number id format", "digits expected");
if (set("WHATSAPP_APP_SECRET")) add(/^[0-9a-f]{32}$/i.test(env.WHATSAPP_APP_SECRET!) ? "PASS" : "WARN", "app secret format", "32 hex characters expected");
if (set("WHATSAPP_ACCESS_TOKEN")) add(env.WHATSAPP_ACCESS_TOKEN!.length >= 100 ? "PASS" : "WARN", "access token shape", "length check only; temporary DEV tokens expire (~24 h) and cannot be verified offline");
const allow = (env.ALLOWED_TECHNICIAN_WA_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
add(allow.length >= 1 && allow.every((n) => /^\d{8,15}$/.test(n)) ? "PASS" : "FAIL", "technician allowlist", `${allow.length} number(s), digits only`);
add(allow.length <= 3 ? "PASS" : "WARN", "test isolation", allow.length <= 3 ? "small allowlist (test technicians only)" : "more than 3 allowed numbers: not a test setup");
add(env.NODE_ENV !== "production" ? "PASS" : "FAIL", "environment", "NODE_ENV must not be production for the experiment");
add(!env.GRAPH_BASE_URL ? "PASS" : "FAIL", "Graph endpoint", env.GRAPH_BASE_URL ? "GRAPH_BASE_URL (mock endpoint) is set: unset it for the live run" : "default graph.facebook.com");
add(/^v\d{2}\.\d$/.test(env.GRAPH_API_VERSION ?? "v23.0") ? "PASS" : "FAIL", "Graph API version", env.GRAPH_API_VERSION ?? "default");
add("INFO", "Webhook registration", "cannot be verified offline: confirm in Meta (callback URL = tunnel/webhook, field `messages`, tunnel running). Callback verification itself was verified earlier by report.");

// ---- pipeline switches
add(env.PIPELINE_ENABLED === "true" ? "PASS" : "FAIL", "PIPELINE_ENABLED", env.PIPELINE_ENABLED === "true" ? "true" : "not true: the server would only download and discard voice messages");
const modelDir = env.STT_MODEL_DIR ?? "";
if (!modelDir || !isAbsolute(modelDir)) add("FAIL", "STT_MODEL_DIR", "missing or not an absolute path");
else {
  try {
    const man = JSON.parse(readFileSync(join(modelDir, "MODEL_MANIFEST.json"), "utf8"));
    let ok = man.revision === "72ad623a37947395efcc3933132353790e5a12f5";
    for (const [name, meta] of Object.entries<any>(man.files)) ok &&= existsSync(join(modelDir, name)) && statSync(join(modelDir, name)).size === meta.bytes;
    add(ok ? "PASS" : "FAIL", "STT model (pinned revision + file sizes)", ok ? "matches MODEL_MANIFEST.json" : "mismatch or missing file");
  } catch { add("FAIL", "STT model", "MODEL_MANIFEST.json unreadable"); }
}
const py = env.STT_PYTHON_EXE && isAbsolute(env.STT_PYTHON_EXE) ? env.STT_PYTHON_EXE : join(root, "python/.venv-stt/Scripts/python.exe");
if (!existsSync(py)) add("FAIL", "STT python environment", "isolated venv missing (apps/api/python/.venv-stt)");
else {
  try {
    const v = execFileSync(py, ["-I", "-c", "import faster_whisper,ctranslate2,av;print(faster_whisper.__version__,ctranslate2.__version__,av.__version__)"], { encoding: "utf8" }).trim();
    add(v.startsWith("1.2.1 4.9.0") ? "PASS" : "WARN", "STT dependencies", `faster-whisper/ctranslate2/av = ${v}`);
  } catch { add("FAIL", "STT dependencies", "import failed"); }
  if (args.includes("--full-hash") && modelDir) {
    try { execFileSync(py, ["-I", join(root, "python/verify_model.py"), modelDir], { encoding: "utf8" }); add("PASS", "STT model SHA-256", "all files verified"); } catch { add("FAIL", "STT model SHA-256", "verification failed"); }
  }
  if (!args.includes("--skip-worker") && modelDir && existsSync(modelDir)) {
    const w = new PythonSttWorker({ pythonExe: py, workerScript: join(root, "python/stt_worker.py"), modelDir, maxQueue: 1, jobTimeoutMs: 1000, startupTimeoutMs: 120000, maxAudioSeconds: 60 });
    const t0 = Date.now();
    try { await w.warmUp(); add("PASS", "STT worker", `ready in ${Date.now() - t0} ms (model loaded once)`); } catch { add("FAIL", "STT worker", "did not become ready"); }
    await w.close();
  } else add("INFO", "STT worker", "not started (--skip-worker or model missing)");
}

// ---- data directory ("database")
const dataDir = resolve(root, env.DATA_DIR ?? "./data");
try {
  mkdirSync(dataDir, { recursive: true });
  const probe = join(dataDir, ".preflight-probe");
  writeFileSync(probe, "x"); rmSync(probe);
  add("PASS", "data directory writable", "state store reachable");
  const st = join(dataDir, "state.json");
  if (existsSync(st)) { JSON.parse(readFileSync(st, "utf8")); add("PASS", "state.json", "parses"); }
  const tmp = join(dataDir, "tmp-media");
  add(!existsSync(tmp) || readdirSync(tmp).length === 0 ? "PASS" : "WARN", "temporary audio", "no leftover files (the server sweeps them at startup anyway)");
} catch { add("FAIL", "data directory", "not writable or state.json corrupt"); }

// ---- Claude (no call is ever made here)
const gate = evaluateLiveGate(env);
const mode = env.EXTRACTOR_MODE === "real" ? "real" : "mock";
if (mode === "real" && !gate.live) add("FAIL", "Claude live gate", `EXTRACTOR_MODE=real but closed. Missing: ${gate.missing.join("; ")}`);
else if (mode === "real") add("PASS", "Claude live gate", "all four conditions present (no call was made)");
else add("INFO", "Claude live gate", `closed (mock/transcribe-only). To open: ${gate.missing.filter((m) => !m.startsWith("EXTRACTOR_MODE")).join("; ") || "set EXTRACTOR_MODE=real"}`);
add(set("ANTHROPIC_API_KEY") ? (env.ANTHROPIC_API_KEY!.startsWith("sk-ant-") ? "PASS" : "FAIL") : "INFO", "Anthropic key present", set("ANTHROPIC_API_KEY") ? "present (value never shown)" : "not configured");
add(env.ANTHROPIC_KEY_ROTATION_CONFIRMED === "yes" ? "PASS" : "BLOCKED", "key safety", env.ANTHROPIC_KEY_ROTATION_CONFIRMED === "yes" ? "operator confirmed the key in use is not the exposed one" : "cannot be proven by software: operator must confirm the exposed key was revoked / that this key was never exposed");
try {
  const cap = budgetCapUsd(env);
  const led = new BudgetLedger(dataDir, cap).snapshot();
  add("PASS", "budget caps", `cap $${cap} (<= $${BUDGET.maxUsd}), ${BUDGET.maxCalls} calls, ${BUDGET.perReceiptMax} per message; used ${led.calls} calls / $${led.usd.toFixed(2)}`);
  add(env.ANTHROPIC_BUDGET_USD ? "PASS" : "WARN", "balance cap", env.ANTHROPIC_BUDGET_USD ? "ANTHROPIC_BUDGET_USD set" : "set ANTHROPIC_BUDGET_USD to the verified Console balance (reported ~3.80) so the ledger cannot exceed it");
} catch { add("FAIL", "budget caps", "ANTHROPIC_BUDGET_USD invalid"); }
add("BLOCKED", "Console balance", "the account balance cannot be read with an API key: operator must confirm it in the Anthropic Console before any real call");
add(mode === "mock" && env.PIPELINE_ENABLED === "true" ? "INFO" : "PASS", "no fabricated forms", mode === "mock" ? "mock extractor => transcribe-only: the server never sends a form that looks AI-extracted" : "real extraction path");
add("INFO", "LIVE MODE", "OFF. This script changes nothing and never enables it.");

// ---- report
const order: Level[] = ["FAIL", "BLOCKED", "WARN", "INFO", "PASS"];
for (const lv of order) for (const r of rows.filter((x) => x.level === lv)) console.log(`${lv.padEnd(7)} ${r.check} — ${r.detail}`);
const c = (l: Level) => rows.filter((r) => r.level === l).length;
console.log(`\nSUMMARY: ${c("PASS")} pass, ${c("FAIL")} fail, ${c("BLOCKED")} blocked, ${c("WARN")} warn, ${c("INFO")} info`);
console.log(c("FAIL") === 0 && c("BLOCKED") === 0 ? "PREFLIGHT: READY (live mode still OFF)" : "PREFLIGHT: NOT READY — fix FAIL items and clear BLOCKED items");
process.exit(c("FAIL") === 0 ? 0 : 1);
