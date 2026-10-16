// Core SOL Rescue logic: find token accounts whose rent deposit can be
// reclaimed, and build one unsigned transaction that closes them.
// Kept free of MCP so it can be unit-tested with a stubbed fetch.

import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
export const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111";
export const MAX_TX_BYTES = 1232;
export const MAX_CLOSES_PER_TX = 25;
export const BASE_FEE_LAMPORTS = 5000n;
const RPC_TIMEOUT_MS = 3500;
const RPC_RETRY_DELAY_MS = 400;
const BURN_IX = 8;
const CLOSE_ACCOUNT_IX = 9;

// Never burned, whatever the caller asks: real money, not spam.
export const PROTECTED_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  So11111111111111111111111111111111111111112: "wrapped SOL",
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TokenAccount {
  address: string;
  mint: string;
  program: "spl-token" | "spl-token-2022";
  lamports: bigint;
  amount: string;
  uiAmount: string;
  isNative: boolean;
  // Why the account cannot be closed (or burned and closed); null when it can.
  block: string | null;
}

export interface Closable extends TokenAccount {}

export interface Skipped extends TokenAccount {
  reason: string;
}

export interface Scan {
  wallet: string;
  totalTokenAccounts: number;
  closable: Closable[];
  holdingBalance: TokenAccount[];
  skipped: Skipped[];
}

export function parseWallet(value: string): PublicKey {
  let key: PublicKey;
  try {
    key = new PublicKey(value);
  } catch {
    throw new Error(`"${value}" is not a valid Solana address.`);
  }
  if (!PublicKey.isOnCurve(key.toBytes())) {
    throw new Error(`"${value}" is a program-derived address, not a wallet that can sign.`);
  }
  return key;
}

export function lamportsToSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

async function rpc(fetchFn: FetchLike, url: string, method: string, params: unknown[]): Promise<any> {
  const send = async () => {
    try {
      return await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Solana RPC request failed: ${(err as Error).message}`);
    }
  };
  let res = await send();
  // Public RPC rate-limits bursts; one short retry keeps us inside the 10 s budget.
  if (res.status === 429 || res.status >= 500) {
    await new Promise((r) => setTimeout(r, RPC_RETRY_DELAY_MS));
    res = await send();
  }
  if (!res.ok) throw new Error(`Solana RPC returned HTTP ${res.status}.`);
  const body = (await res.json()) as { result?: any; error?: { message?: string } };
  if (body.error) throw new Error(`Solana RPC error: ${body.error.message ?? "unknown"}`);
  return body.result;
}

// Reasons an empty account must not be closed. Returns null when it is safe.
export function blockReason(info: any, wallet: string): string | null {
  if (info.state !== "initialized") return `account is ${info.state}`;
  if (info.closeAuthority && info.closeAuthority !== wallet) return "another address holds close authority";
  for (const ext of info.extensions ?? []) {
    if (ext.extension === "transferFeeAmount" && BigInt(ext.state?.withheldAmount ?? 0) > 0n) {
      return "has withheld transfer fees";
    }
    if (ext.extension === "confidentialTransferAccount") return "uses confidential transfers";
  }
  return null;
}

export async function scanWallet(walletAddress: string, opts: { rpcUrl?: string; fetch?: FetchLike } = {}): Promise<Scan> {
  const wallet = parseWallet(walletAddress).toBase58();
  const fetchFn = opts.fetch ?? fetch;
  const url = opts.rpcUrl || DEFAULT_RPC_URL;

  const results = await Promise.all(
    [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((programId) =>
      rpc(fetchFn, url, "getTokenAccountsByOwner", [wallet, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]),
    ),
  );

  const scan: Scan = { wallet, totalTokenAccounts: 0, closable: [], holdingBalance: [], skipped: [] };
  for (const result of results) {
    for (const entry of result?.value ?? []) {
      const parsed = entry.account?.data?.parsed;
      const info = parsed?.info;
      if (!info?.tokenAmount) continue;
      scan.totalTokenAccounts++;
      const account: TokenAccount = {
        address: entry.pubkey,
        mint: info.mint,
        program: entry.account.data.program === "spl-token-2022" ? "spl-token-2022" : "spl-token",
        lamports: BigInt(entry.account.lamports),
        amount: info.tokenAmount.amount,
        uiAmount: info.tokenAmount.uiAmountString ?? info.tokenAmount.amount,
        isNative: info.isNative === true,
        block: blockReason(info, wallet),
      };
      if (account.amount !== "0") scan.holdingBalance.push(account);
      else if (account.block) scan.skipped.push({ ...account, reason: account.block });
      else scan.closable.push(account);
    }
  }
  scan.closable.sort((a, b) => (b.lamports > a.lamports ? 1 : b.lamports < a.lamports ? -1 : a.address.localeCompare(b.address)));
  return scan;
}

export function closeInstruction(account: TokenAccount, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(account.program === "spl-token-2022" ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM),
    keys: [
      { pubkey: new PublicKey(account.address), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([CLOSE_ACCOUNT_IX]),
  });
}

// Why a held token must not be burned; null when burning is allowed.
export function burnBlock(account: TokenAccount): string | null {
  const protectedName = PROTECTED_MINTS[account.mint];
  if (protectedName) return `${protectedName} is never burned`;
  if (account.isNative) return "wrapped SOL is never burned";
  return account.block;
}

export function burnInstruction(account: TokenAccount, owner: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = BURN_IX;
  data.writeBigUInt64LE(BigInt(account.amount), 1);
  return new TransactionInstruction({
    programId: new PublicKey(account.program === "spl-token-2022" ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM),
    keys: [
      { pubkey: new PublicKey(account.address), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(account.mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function serializedSize(tx: Transaction): number {
  // One signature slot (1 byte count + 64 bytes) plus the message.
  return 1 + 64 + tx.compileMessage().serialize().length;
}

export interface CloseBatch {
  transactionBase64: string;
  transaction: Transaction;
  included: TokenAccount[];
  burned: TokenAccount[];
  reclaimLamports: bigint;
}

// Builds one unsigned legacy transaction closing as many accounts as fit.
// Accounts in `toBurn` (already vetted with burnBlock) get their whole balance
// burned first, then closed; they go first so an explicit request is never cut.
// The user's wallet is the only signer and fee payer; rent goes back to it.
export function buildCloseBatch(
  walletAddress: string,
  closable: Closable[],
  maxAccounts = MAX_CLOSES_PER_TX,
  toBurn: TokenAccount[] = [],
): CloseBatch {
  const owner = parseWallet(walletAddress);
  const limit = Math.max(1, Math.min(maxAccounts, MAX_CLOSES_PER_TX));
  const tx = new Transaction({ feePayer: owner, recentBlockhash: PLACEHOLDER_BLOCKHASH });
  const included: TokenAccount[] = [];
  const burned: TokenAccount[] = [];
  const queue = [...toBurn.map((a) => ({ a, burn: true })), ...closable.map((a) => ({ a, burn: false }))];
  for (const { a, burn } of queue) {
    if (included.length >= limit) break;
    const ixs = burn ? [burnInstruction(a, owner), closeInstruction(a, owner)] : [closeInstruction(a, owner)];
    tx.add(...ixs);
    if (serializedSize(tx) > MAX_TX_BYTES) {
      tx.instructions.splice(-ixs.length);
      break;
    }
    included.push(a);
    if (burn) burned.push(a);
  }
  if (included.length === 0) throw new Error("No closable accounts to include.");
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return {
    transactionBase64: bytes.toString("base64"),
    transaction: tx,
    included,
    burned,
    reclaimLamports: included.reduce((sum, a) => sum + a.lamports, 0n),
  };
}

export function expiresAt(nowMs = Date.now()): string {
  return new Date(nowMs + 240_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}