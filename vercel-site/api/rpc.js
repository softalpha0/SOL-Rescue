// Vercel serverless forwarder for the SOL Rescue page. The public Solana RPC rejects
// browser-origin requests, so the page calls /rpc and this function forwards it.
// Only the methods the page needs are allowed, so the deployment is not an open proxy.

const UPSTREAM = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const ALLOWED = new Set([
  "getTokenAccountsByOwner",
  "getLatestBlockhash",
  "getSignatureStatuses",
  "getBlockHeight",
  "sendTransaction",
]);
const MAX_BATCH = 5;
const MAX_BODY = 64 * 1024;

function rpcError(res, status, message) {
  res.status(status).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message } });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return rpcError(res, 405, "Use POST");
  let payload = req.body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return rpcError(res, 400, "Invalid JSON");
    }
  }
  const raw = JSON.stringify(payload ?? null);
  if (raw.length > MAX_BODY) return rpcError(res, 413, "Request too large");
  const calls = Array.isArray(payload) ? payload : [payload];
  if (calls.length === 0 || calls.length > MAX_BATCH) return rpcError(res, 400, "Bad batch size");
  for (const call of calls) {
    if (!call || typeof call.method !== "string" || !ALLOWED.has(call.method)) {
      return rpcError(res, 403, `Method not allowed: ${call && call.method}`);
    }
  }
  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(15000),
    });
    res.status(upstream.status).setHeader("content-type", "application/json");
    res.send(await upstream.text());
  } catch (err) {
    res.status(502).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `RPC forwarder: ${err.message}` } });
  }
};