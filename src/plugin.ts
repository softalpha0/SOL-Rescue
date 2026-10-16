import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  BASE_FEE_LAMPORTS,
  MAX_CLOSES_PER_TX,
  buildCloseBatch,
  burnBlock,
  expiresAt,
  lamportsToSol,
  scanWallet,
  type TokenAccount,
} from "./rescue.js";

const LIST_LIMIT = 50;
const MAX_BURN_MINTS = 10;
const rpcUrl = () => process.env.SOLANA_RPC_URL || undefined;

const solanaAddress = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Solana base58 address");

const accountOut = z.object({
  address: z.string(),
  mint: z.string(),
  program: z.enum(["spl-token", "spl-token-2022"]),
  rentSol: z.string(),
});

const holdingOut = accountOut.extend({
  balance: z.string().describe("Token balance in display units"),
  burnable: z.boolean().describe("Whether reclaim_rent can burn this balance and close the account if the user asks"),
  note: z.string().optional(),
});

const toOut = (a: TokenAccount) => ({ address: a.address, mint: a.mint, program: a.program, rentSol: lamportsToSol(a.lamports) });

const toHolding = (a: TokenAccount) => {
  const block = burnBlock(a);
  return { ...toOut(a), balance: a.uiAmount, burnable: block === null, ...(block ? { note: block } : {}) };
};

const server = new McpServer({ name: "sol-rescue", version: "0.2.0" });

server.registerTool(
  "scan_wallet",
  {
    title: "Scan wallet for stuck SOL",
    description:
      "Read-only. Finds SOL locked as rent (about 0.002 SOL each) in a wallet's Solana token accounts. " +
      "Reports empty accounts that can be closed right away, and lists accounts that still hold tokens so the user can pick " +
      "worthless spam or dust to burn and close with reclaim_rent. Never moves funds.",
    inputSchema: z.object({ wallet: solanaAddress.describe("Public Solana wallet address to scan") }).strict(),
    outputSchema: z.object({
      wallet: z.string(),
      totalTokenAccounts: z.number().int(),
      closableCount: z.number().int(),
      reclaimableSol: z.string().describe("SOL returned by closing the empty accounts"),
      transactionsNeeded: z.number().int(),
      closable: z.array(accountOut).describe(`First ${LIST_LIMIT} empty closable accounts, largest deposit first`),
      holdingBalanceCount: z.number().int().describe("Accounts that still hold tokens; only burned if the user names the mint"),
      holdingRentSol: z.string().describe("SOL locked in accounts that still hold tokens"),
      holding: z.array(holdingOut).describe(`First ${LIST_LIMIT} accounts that still hold tokens`),
      skipped: z.array(accountOut.extend({ reason: z.string() })),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ wallet }) => {
    const scan = await scanWallet(wallet, { rpcUrl: rpcUrl() });
    const sum = (list: TokenAccount[]) => list.reduce((s, a) => s + a.lamports, 0n);
    const result = {
      wallet: scan.wallet,
      totalTokenAccounts: scan.totalTokenAccounts,
      closableCount: scan.closable.length,
      reclaimableSol: lamportsToSol(sum(scan.closable)),
      transactionsNeeded: Math.ceil(scan.closable.length / MAX_CLOSES_PER_TX),
      closable: scan.closable.slice(0, LIST_LIMIT).map(toOut),
      holdingBalanceCount: scan.holdingBalance.length,
      holdingRentSol: lamportsToSol(sum(scan.holdingBalance)),
      holding: scan.holdingBalance.slice(0, LIST_LIMIT).map(toHolding),
      skipped: scan.skipped.slice(0, LIST_LIMIT).map((a) => ({ ...toOut(a), reason: a.reason })),
    };
    const parts: string[] = [];
    if (scan.closable.length > 0) {
      parts.push(
        `Found ${scan.closable.length} empty token accounts holding ${result.reclaimableSol} SOL that can be reclaimed now ` +
          `(${result.transactionsNeeded} transaction(s)).`,
      );
    } else {
      parts.push(`No empty token accounts to close among ${scan.totalTokenAccounts}.`);
    }
    if (scan.holdingBalance.length > 0) {
      parts.push(
        `${scan.holdingBalance.length} accounts still hold tokens and lock ${result.holdingRentSol} SOL. ` +
          "They are never touched unless the user picks worthless ones to burn and close.",
      );
    }
    return { content: [{ type: "text", text: parts.join(" ") }], structuredContent: result };
  },
);

server.registerTool(
  "reclaim_rent",
  {
    title: "Reclaim stuck SOL",
    description:
      "Proposes one unsigned Solana transaction that closes the sender's empty token accounts and returns their rent deposits to the sender. " +
      `Closes up to ${MAX_CLOSES_PER_TX} accounts per call; call again for the rest after this one confirms. ` +
      "Optional burnMints also burns the ENTIRE balance of those tokens and closes their accounts. Burning is permanent: " +
      "only pass mints the user has explicitly confirmed are worthless spam or dust. USDC, USDT and wrapped SOL are always refused.",
    inputSchema: z
      .object({
        sender: solanaAddress.describe("Public address of the user's selected PayBox Solana wallet; it signs, pays the fee and receives the SOL"),
        maxAccounts: z.number().int().min(1).max(MAX_CLOSES_PER_TX).optional().describe(`Cap on accounts to close (default ${MAX_CLOSES_PER_TX})`),
        burnMints: z
          .array(solanaAddress)
          .max(MAX_BURN_MINTS)
          .optional()
          .describe("Token mints the user confirmed are worthless; their full balance is burned and the account closed"),
      })
      .strict(),
    outputSchema: z.object({
      "io.paybox/transactionProposal": z.object({
        version: z.literal("1"),
        kind: z.literal("solana"),
        chain: z.literal("solana:mainnet"),
        expiresAt: z.string(),
        transaction: z.object({ transactionBase64: z.string() }),
      }),
      closingCount: z.number().int(),
      reclaimSol: z.string(),
      networkFeeSol: z.string(),
      remainingClosable: z.number().int(),
      accounts: z.array(accountOut),
      burned: z.array(z.object({ mint: z.string(), address: z.string(), balance: z.string() })),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ sender, maxAccounts, burnMints }) => {
    const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
    const scan = await scanWallet(sender, { rpcUrl: rpcUrl() });

    const toBurn: TokenAccount[] = [];
    for (const mint of new Set(burnMints ?? [])) {
      const held = scan.holdingBalance.filter((a) => a.mint === mint);
      if (held.length === 0) return fail(`Refused: the wallet holds no balance of token ${mint}, so there is nothing to burn.`);
      for (const account of held) {
        const block = burnBlock(account);
        if (block) return fail(`Refused to burn ${mint}: ${block}. Nothing was proposed.`);
        toBurn.push(account);
      }
    }

    if (scan.closable.length === 0 && toBurn.length === 0) {
      const hint =
        scan.holdingBalance.length > 0
          ? ` ${scan.holdingBalance.length} accounts still hold tokens; if some are worthless, the user can choose them to burn with burnMints.`
          : "";
      return fail(`Nothing to reclaim: this wallet has no empty token accounts that can be closed.${hint}`);
    }

    const batch = buildCloseBatch(sender, scan.closable, maxAccounts, toBurn);
    const burnedSet = new Set(batch.burned);
    const closedEmpty = batch.included.filter((a) => !burnedSet.has(a)).length;
    const result = {
      "io.paybox/transactionProposal": {
        version: "1" as const,
        kind: "solana" as const,
        chain: "solana:mainnet" as const,
        expiresAt: expiresAt(),
        transaction: { transactionBase64: batch.transactionBase64 },
      },
      closingCount: batch.included.length,
      reclaimSol: lamportsToSol(batch.reclaimLamports),
      networkFeeSol: lamportsToSol(BASE_FEE_LAMPORTS),
      remainingClosable: scan.closable.length - closedEmpty,
      accounts: batch.included.map(toOut),
      burned: batch.burned.map((a) => ({ mint: a.mint, address: a.address, balance: a.uiAmount })),
    };
    const burnNote =
      batch.burned.length > 0
        ? ` This permanently burns ${batch.burned.length} token balance(s): ${batch.burned.map((a) => `${a.uiAmount} of ${a.mint}`).join(", ")}.`
        : "";
    const skippedBurns = toBurn.length - batch.burned.length;
    const text =
      `Proposed closing ${result.closingCount} token accounts to return ${result.reclaimSol} SOL to ${scan.wallet} ` +
      `(network fee about ${result.networkFeeSol} SOL).${burnNote}` +
      (skippedBurns > 0 ? ` ${skippedBurns} requested burn(s) did not fit; run again after this confirms.` : "") +
      (result.remainingClosable > 0 ? ` ${result.remainingClosable} empty accounts remain; run again after this transaction confirms.` : "");
    return { content: [{ type: "text", text }], structuredContent: result };
  },
);

await server.connect(new StdioServerTransport());