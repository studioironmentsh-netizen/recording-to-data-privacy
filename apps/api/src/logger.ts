// Structured logger. Never pass bodies, tokens or message content to it.
const secrets: string[] = [];
export function registerSecrets(...values: string[]): void {
  for (const v of values) if (v && v.length >= 6) secrets.push(v);
}

export function maskPhone(id: string): string {
  return id.length <= 3 ? "***" : `***${id.slice(-3)}`;
}

export function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function scrub(s: string): string {
  let out = s;
  for (const sec of secrets) out = out.split(sec).join("[REDACTED]");
  return out;
}

export type Fields = Record<string, string | number | boolean | null | undefined>;

let sink: (line: string) => void = (l) => console.log(l);
export function setSink(fn: (line: string) => void): void {
  sink = fn;
}

export function log(level: "info" | "warn" | "error", event: string, fields: Fields = {}): void {
  sink(scrub(JSON.stringify({ t: new Date().toISOString(), level, event, ...fields })));
}

export function errMsg(e: unknown): string {
  return scrub(e instanceof Error ? e.message : "unknown error");
}
