// Tiny static server: wallet extensions only inject into http(s) pages, not file://.
// It also forwards POST /rpc to Solana, because the public RPC rejects browser-origin requests.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = "web-dist";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const port = Number(process.env.PORT) || 5173;
const upstream = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const MAX_BODY = 1 << 20;

async function proxyRpc(req, res) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) return res.writeHead(413).end("Request too large");
  }
  try {
    const r = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(15000),
    });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(await r.text());
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `RPC proxy: ${err.message}` } }));
  }
}

createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  if (pathname === "/rpc" && req.method === "POST") return proxyRpc(req, res);
  const path = normalize(pathname).replace(/^([/\\])+/, "") || "index.html";
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`SOL Rescue web: http://localhost:${port}  (RPC via ${upstream})`));