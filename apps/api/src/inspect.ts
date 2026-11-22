// Read-only LOCAL inspector of saved forms (safe test mode). It is a separate http listener on its own loopback port:
// the Cloudflare tunnel forwards only the webhook port, so these routes are never reachable through it. It never writes.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Form, Receipt, Store } from "./store.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "forwarded", "cf-connecting-ip", "cf-ray", "cf-visitor", "x-real-ip"];

/** Short, non-reversible reference to the inbound message (never the raw WhatsApp message id). */
export function messageRef(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());

function receiptView(r: Receipt) {
  return {
    message_ref: messageRef(r.id), kind: r.kind, status: r.status, revision: r.revision ?? null, failure: r.failure ?? null,
    webhook_received_at: iso(r.receivedAt), processing_completed_at: iso(r.processingCompletedAt), processing_duration_ms: r.processingDurationMs ?? null,
  };
}

function summary(store: Store, f: Form) {
  const rs = store.receiptsForForm(f.formId);
  const last = rs[rs.length - 1];
  return { form_id: f.formId, revision: f.revision, status: f.status, mode: f.mode ?? null, processing_duration_ms: last?.processingDurationMs ?? null, receipt_status: last?.status ?? null };
}

function detail(store: Store, f: Form) {
  const rs = store.receiptsForForm(f.formId);
  const o = store.getOutbox(`form:${f.formId}:${f.revision}`);
  return {
    form_id: f.formId, number: f.number ?? null, revision: f.revision, status: f.status, mode: f.mode ?? null, capture_date: f.captureDate ?? null,
    mock_extraction: Boolean(f.mock), // true => produced by the MockLlm, not by Claude
    fields: Object.fromEntries(Object.entries(f.fields ?? {}).map(([k, v]) => [k, { shown: v.shown, text: v.text }])), // exactly what the technician would see; evidence quotes are never stored
    validation: { partial: Boolean(f.partial), flagged_fields: f.flagged ?? [] },
    receipts: rs.map(receiptView),
    transcript: null, transcript_stored: false, // by decision D16 / privacy page: transcripts are not persisted
    outbound: o ? { status: o.status, attempts: o.attempts } : null, // PENDING with attempts 0 => saved but never sent
  };
}

/** The caller must listen on 127.0.0.1 only. */
export function createInspector(store: Store): Server {
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(body, null, 2));
    };
    try {
      const host = String(req.headers.host ?? ""), port = req.socket.localPort;
      const localHost = host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
      const viaProxy = PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
      if (!LOOPBACK.has(req.socket.remoteAddress ?? "") || !localHost || viaProxy) return send(403, { error: "local access only" });
      if (req.method !== "GET") { res.setHeader("allow", "GET"); return send(405, { error: "read-only" }); }
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/local/forms") return send(200, { forms: store.listForms().map((f) => summary(store, f)) });
      const m = /^\/local\/forms\/([A-Za-z0-9_-]{1,40})$/.exec(path);
      if (m) {
        const f = store.getForm(m[1]!);
        return f ? send(200, detail(store, f)) : send(404, { error: "not found" });
      }
      return send(404, { error: "not found" });
    } catch {
      if (!res.headersSent) send(500, { error: "internal error" }); // never echo internals
    }
  };
  return createServer(handle);
}
