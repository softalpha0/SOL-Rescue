// SOL Rescue for any wallet: the same scan and close logic as the PayBox plugin,
// signed in the user's own browser wallet (Phantom, Solflare, Backpack).
// No keys ever reach this page; the wallet extension signs.

import { Connection, type Transaction } from "@solana/web3.js";
import {
  DEFAULT_RPC_URL,
  MAX_CLOSES_PER_TX,
  buildCloseBatch,
  burnBlock,
  lamportsToSol,
  scanWallet,
  type Scan,
  type TokenAccount,
} from "../src/rescue.ts";

interface WalletProvider {
  publicKey?: { toString(): string } | null;
  connect(): Promise<unknown>;
  disconnect?(): Promise<void>;
  signAndSendTransaction?(tx: Transaction): Promise<{ signature: string } | string>;
  signTransaction?(tx: Transaction): Promise<Transaction>;
}

declare global {
  interface Window {
    phantom?: { solana?: WalletProvider };
    solflare?: WalletProvider & { isSolflare?: boolean };
    backpack?: WalletProvider;
    solana?: WalletProvider;
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const short = (a: string) => `${a.slice(0, 4)}\u2026${a.slice(-4)}`;
const solscan = (kind: "account" | "tx" | "token", id: string) => `https://solscan.io/${kind}/${id}`;
const sum = (list: TokenAccount[]) => list.reduce((s, a) => s + a.lamports, 0n);

let provider: WalletProvider | null = null;
let owner = "";
let scan: Scan | null = null;
let busy = false;

function wallets(): { name: string; provider: WalletProvider }[] {
  const found: { name: string; provider: WalletProvider }[] = [];
  if (window.phantom?.solana) found.push({ name: "Phantom", provider: window.phantom.solana });
  if (window.solflare?.isSolflare) found.push({ name: "Solflare", provider: window.solflare });
  if (window.backpack) found.push({ name: "Backpack", provider: window.backpack });
  if (found.length === 0 && window.solana) found.push({ name: "Wallet", provider: window.solana });
  return found;
}

function rpcUrl(): string {
  return ($<HTMLInputElement>("rpc").value || `${location.origin}/rpc`).trim();
}

function status(text: string, kind: "info" | "ok" | "error" = "info", html = false) {
  const el = $("status");
  el.className = `status ${kind}`;
  if (html) el.innerHTML = text;
  else el.textContent = text;
  el.hidden = !text;
}

function setBusy(on: boolean) {
  busy = on;
  for (const id of ["connect", "scan", "reclaim"]) {
    const b = document.getElementById(id) as HTMLButtonElement | null;
    if (b) b.disabled = on || (id !== "connect" && !owner);
  }
  updateReclaimButton();
}

function renderWalletPicker() {
  const list = wallets();
  const box = $("wallet-picker");
  box.innerHTML = "";
  if (list.length === 0) {
    box.innerHTML =
      '<p class="muted">No Solana wallet extension found. Install <a href="https://phantom.app" target="_blank" rel="noopener">Phantom</a> or <a href="https://solflare.com" target="_blank" rel="noopener">Solflare</a>, then reload this page.</p>';
    return;
  }
  for (const w of list) {
    const b = document.createElement("button");
    b.className = "btn";
    b.id = list.length === 1 ? "connect" : `connect-${w.name}`;
    b.textContent = `Connect ${w.name}`;
    b.onclick = () => connect(w.provider);
    box.appendChild(b);
  }
}

async function connect(p: WalletProvider) {
  try {
    setBusy(true);
    status("Waiting for your wallet to approve the connection\u2026");
    await p.connect();
    if (!p.publicKey) throw new Error("The wallet did not share an address.");
    provider = p;
    owner = p.publicKey.toString();
    $("owner").innerHTML = `Connected: <a href="${solscan("account", owner)}" target="_blank" rel="noopener">${short(owner)}</a>`;
    $("connected").hidden = false;
    $("wallet-picker").hidden = true;
    status("");
    await doScan();
  } catch (err) {
    status(`Could not connect: ${(err as Error).message}`, "error");
  } finally {
    setBusy(false);
  }
}

// quiet: refresh after a reclaim without replacing its success message.
async function doScan(quiet = false) {
  if (!owner) return;
  setBusy(true);
  if (!quiet) status("Scanning your token accounts\u2026");
  try {
    scan = await scanWallet(owner, { rpcUrl: rpcUrl() });
    render();
    if (!quiet) status("");
  } catch (err) {
    status(`Scan failed: ${(err as Error).message} If this keeps happening, paste a private RPC URL under Advanced.`, "error");
  } finally {
    setBusy(false);
  }
}

function render() {
  if (!scan) return;
  $("results").hidden = false;
  $("sum-total").textContent = String(scan.totalTokenAccounts);
  $("sum-empty").textContent = `${scan.closable.length} \u00b7 ${lamportsToSol(sum(scan.closable))} SOL`;
  $("sum-holding").textContent = `${scan.holdingBalance.length} \u00b7 ${lamportsToSol(sum(scan.holdingBalance))} SOL`;
  $("sum-skipped").textContent = String(scan.skipped.length);

  const empty = $("empty-list");
  empty.innerHTML = scan.closable.length
    ? scan.closable
        .map(
          (a) =>
            `<li><a href="${solscan("token", a.mint)}" target="_blank" rel="noopener">${short(a.mint)}</a><span>${lamportsToSol(a.lamports)} SOL</span></li>`,
        )
        .join("")
    : '<li class="muted">No empty accounts. Nothing to close without burning.</li>';

  const holding = $("holding-list");
  holding.innerHTML = scan.holdingBalance.length
    ? scan.holdingBalance
        .map((a) => {
          const block = burnBlock(a);
          return `<li>
            <label class="${block ? "disabled" : ""}">
              <input type="checkbox" class="burn" value="${a.address}" ${block ? "disabled" : ""}>
              <a href="${solscan("token", a.mint)}" target="_blank" rel="noopener">${short(a.mint)}</a>
              <span class="bal">${a.uiAmount}</span>
            </label>
            <span>${block ? `<em>${block}</em>` : `${lamportsToSol(a.lamports)} SOL`}</span>
          </li>`;
        })
        .join("")
    : '<li class="muted">No other token accounts.</li>';
  for (const box of holding.querySelectorAll<HTMLInputElement>("input.burn")) box.onchange = updateReclaimButton;

  $("skipped-list").innerHTML = scan.skipped.length
    ? scan.skipped.map((a) => `<li>${short(a.mint)}<span><em>${a.reason}</em></span></li>`).join("")
    : '<li class="muted">None.</li>';
  updateReclaimButton();
}

function selectedBurns(): TokenAccount[] {
  if (!scan) return [];
  const chosen = new Set(
    [...document.querySelectorAll<HTMLInputElement>("input.burn:checked")].map((b) => b.value),
  );
  return scan.holdingBalance.filter((a) => chosen.has(a.address) && burnBlock(a) === null);
}

function updateReclaimButton() {
  const btn = document.getElementById("reclaim") as HTMLButtonElement | null;
  if (!btn) return;
  if (!scan) {
    btn.disabled = true;
    return;
  }
  const burns = selectedBurns();
  const count = Math.min(scan.closable.length + burns.length, MAX_CLOSES_PER_TX);
  const lamports = sum([...burns, ...scan.closable].slice(0, MAX_CLOSES_PER_TX));
  btn.disabled = busy || count === 0;
  btn.textContent = count === 0 ? "Nothing to reclaim" : `Reclaim ${lamportsToSol(lamports)} SOL (${count} accounts)`;
}

async function reclaim() {
  if (!provider || !scan) return;
  const burns = selectedBurns();
  if (burns.length > 0) {
    const list = burns.map((a) => `\u2022 ${a.uiAmount} of ${a.mint}`).join("\n");
    const ok = window.confirm(
      `This PERMANENTLY BURNS these token balances before closing their accounts:\n\n${list}\n\nOnly continue if they are worthless spam or dust.`,
    );
    if (!ok) return;
  }
  setBusy(true);
  try {
    const batch = buildCloseBatch(owner, scan.closable, MAX_CLOSES_PER_TX, burns);
    const connection = new Connection(rpcUrl(), "confirmed");
    const latest = await connection.getLatestBlockhash("confirmed");
    const tx = batch.transaction;
    tx.recentBlockhash = latest.blockhash;
    status(`Approve the transaction in your wallet: closing ${batch.included.length} accounts to return ${lamportsToSol(batch.reclaimLamports)} SOL.`);

    let signature: string;
    if (provider.signAndSendTransaction) {
      const res = await provider.signAndSendTransaction(tx);
      signature = typeof res === "string" ? res : res.signature;
    } else if (provider.signTransaction) {
      const signed = await provider.signTransaction(tx);
      signature = await connection.sendRawTransaction(signed.serialize());
    } else {
      throw new Error("This wallet cannot sign transactions.");
    }

    status("Sent. Waiting for confirmation\u2026");
    await waitForConfirmation(connection, signature, latest.lastValidBlockHeight);
    status(
      `Reclaimed ${lamportsToSol(batch.reclaimLamports)} SOL. <a href="${solscan("tx", signature)}" target="_blank" rel="noopener">View transaction</a>`,
      "ok",
      true,
    );
    await doScan(true);
  } catch (err) {
    status(`Not reclaimed: ${(err as Error).message}`, "error");
  } finally {
    setBusy(false);
  }
}

// Polls over plain HTTP instead of relying on the RPC's websocket, which some
// endpoints and networks block.
async function waitForConfirmation(connection: Connection, signature: string, lastValidBlockHeight: number) {
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const s = value[0];
    if (s?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return;
    if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      throw new Error(`Not confirmed before it expired. Check ${solscan("tx", signature)} before trying again.`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function init() {
  $<HTMLInputElement>("rpc").placeholder = `Default: local forwarder to ${DEFAULT_RPC_URL}`;
  $("scan").onclick = () => doScan();
  $("reclaim").onclick = () => reclaim();
  // Wallet extensions inject shortly after load.
  renderWalletPicker();
  setTimeout(renderWalletPicker, 600);
  setBusy(false);
}

init();