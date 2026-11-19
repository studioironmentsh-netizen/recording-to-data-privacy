// Local stand-in for the Meta Graph API boundary (test support only). The product's real GraphWhatsApp class talks to it over HTTP,
// so request/response shapes, auth header, media two-step download and error payloads follow the live contract.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface GraphFailure { status: number; code?: number }

export class MockGraph {
  private server: Server | null = null;
  baseUrl = "";
  readonly messages: any[] = []; // bodies of accepted POST /messages
  readonly rejected: any[] = []; // bodies of requests answered with an injected failure
  readonly media = new Map<string, Buffer>();
  failures: GraphFailure[] = []; // consumed one per POST /messages
  skip = 0; // let this many POSTs succeed before the next injected failure applies
  private n = 0;
  private token: string;
  constructor(token: string) {
    this.token = token;
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { error: { code: 190, type: "OAuthException", message: "invalid token" } });
      const url = new URL(req.url ?? "/", "http://x");
      const parts = url.pathname.split("/").filter(Boolean); // [version, ...]
      if (req.method === "POST" && parts[2] === "messages") {
        const body = JSON.parse(await readAll(req));
        const f = this.skip > 0 ? (this.skip--, undefined) : this.failures.shift();
        if (f) { this.rejected.push(body); return send(f.status, { error: { code: f.code ?? 1, type: "OAuthException", message: "injected" } }); }
        this.messages.push(body);
        return send(200, { messaging_product: "whatsapp", contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.MOCKGRAPH${++this.n}` }] });
      }
      if (req.method === "GET" && parts[0] === "media") {
        const b = this.media.get(parts[1]!);
        return b ? send(200, b, { "content-type": "audio/ogg" }) : send(404, { error: { code: 100 } });
      }
      if (req.method === "GET" && parts.length === 2) { // GET /{version}/{media-id}
        const b = this.media.get(parts[1]!);
        return b ? send(200, { messaging_product: "whatsapp", url: `${this.baseUrl}/media/${parts[1]}`, mime_type: "audio/ogg; codecs=opus", sha256: "0".repeat(64), file_size: b.length, id: parts[1] }) : send(404, { error: { code: 100 } });
      }
      send(404, { error: { code: 100 } });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
  get interactive(): any[] { return this.messages.filter((m) => m.type === "interactive"); }
  get texts(): any[] { return this.messages.filter((m) => m.type === "text"); }
}

function readAll(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const c: Buffer[] = [];
    req.on("data", (d: Buffer) => c.push(d));
    req.on("end", () => resolve(Buffer.concat(c).toString("utf8")));
  });
}
