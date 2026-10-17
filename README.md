$readme = @'

\# SOL Rescue



\*\*Get back the SOL your Solana wallet doesn't know it has.\*\*



SOL Rescue is a \[MoonPay PayBox](https://paybox.sh) marketplace plugin. It finds SOL

locked as rent in Solana token accounts and proposes one transaction that closes those

accounts and sends the SOL back to your wallet. You approve every transaction in PayBox.

The plugin never sees your keys and charges no fees.



\- \*\*Live web app (any wallet):\*\* https://sol-rescue-vercel-site.vercel.app

\- \*\*Demo transaction on mainnet:\*\* \[4R3drG...W9Cdh](https://solscan.io/tx/4R3drGnwhr825nL5UEMPnFNz2215KDRoJjaBt68RwRajs3P5W9QStRotBXxSXbdwkWtXEAgSRA1Acn6CXztW9Cdh)

\- Built for the MoonPay PayBox Hackathon, Chapter 1.



\## The problem



Every token a Solana wallet has ever held gets its own token account, and each account

locks a rent deposit (about 0.0015 to 0.002 SOL). Selling or sending away the token does

not close the account, so that SOL stays locked. Wallets that trade memecoins often

have dozens of these accounts and a meaningful amount of SOL stuck in them.



The deposit comes back only when the account is closed, and an account can only be

closed once its token balance is zero.



\## How it works



1\. \*\*Scan.\*\* You ask your agent to scan a wallet. SOL Rescue reads every token account

&#x20;  (both the Token and Token-2022 programs) and reports:

&#x20;  - empty accounts that can be closed right away, and the SOL they hold;

&#x20;  - accounts that still hold tokens, with their balance and whether they can be burned;

&#x20;  - accounts it will not touch, with the reason.

2\. \*\*Reclaim.\*\* You ask it to reclaim. It builds one unsigned transaction that closes up

&#x20;  to 25 accounts and sends the rent to your wallet. If you name tokens you have

&#x20;  confirmed are worthless dust or spam, it burns their full balance first and then

&#x20;  closes those accounts too.

3\. \*\*Approve.\*\* PayBox shows you the transaction. You approve it, PayBox signs and sends

&#x20;  it, and the SOL lands back in your wallet.



\### Example (from the demo)



> \*\*You:\*\* Use the Sol Rescue plugin to scan my PayBox wallet sol-default.

>

> \*\*Agent:\*\* 1 token account, holding 190,085 candycoin, locks 0.00148844 SOL.

>

> \*\*You:\*\* Reclaim the rent. Burn the candycoin, I confirm it's worthless.

>

> \*\*Agent:\*\* The burn-and-close transaction is ready. Approve it in PayBox.

>

> \*\*Result:\*\* confirmed on mainnet, candycoin balance 0, rent returned to the wallet.



\## Tools



| Tool | What it does | Moves funds? |

|---|---|---|

| `scan\_wallet({ wallet })` | Lists closable empty accounts and the SOL they lock, accounts that still hold tokens (balance, burnable or not) and skipped accounts with reasons. | No, read-only |

| `reclaim\_rent({ sender, maxAccounts?, burnMints? })` | Returns an unsigned transaction proposal that closes up to 25 accounts (default 25) and returns the rent to `sender`. `burnMints` (up to 10, opt-in) burns the full balance of those tokens, then closes their accounts. | Only after you approve it in PayBox |



`reclaim\_rent` returns the proposal under `io.paybox/transactionProposal` together with

`closingCount`, `reclaimSol`, `networkFeeSol`, `remainingClosable`, `accounts` and

`burned`, so the agent can explain exactly what will happen before you approve. If more

than 25 accounts are closable, call it again after the first transaction confirms.



\## Safety



\- \*\*Your wallet is the only signer.\*\* It is also the fee payer and the only place the

&#x20; rent goes. There are no third-party addresses and no plugin fees.

\- \*\*No keys and no secrets.\*\* The plugin only builds unsigned transactions. PayBox

&#x20; signs them after you approve.

\- \*\*Empty accounts by default.\*\* Without `burnMints`, only zero-balance accounts are

&#x20; included. The SPL Token program also refuses to close a non-empty account on-chain,

&#x20; so if a token arrives between the proposal and signing, the transaction fails

&#x20; instead of losing funds.

\- \*\*Burning is opt-in, per token.\*\* Only mints you name are burned. USDC, USDT and

&#x20; wrapped SOL are always refused. A burn request for a token the wallet doesn't hold

&#x20; is refused, and nothing is proposed.

\- \*\*Accounts it skips:\*\* frozen accounts, accounts whose close authority belongs to

&#x20; another address, and Token-2022 accounts with withheld transfer fees or confidential

&#x20; balances.

\- \*\*Stateless.\*\* Nothing is stored between calls.

\- \*\*Short-lived proposals.\*\* Each proposal expires within 5 minutes.



\## Web app for any wallet



Not every wallet can be imported into PayBox, so the same scan-and-close logic also runs

as a web page: https://sol-rescue-vercel-site.vercel.app



1\. Open it in a desktop browser with Phantom, Solflare or Backpack installed. On a phone,

&#x20;  tap \*\*Open in Phantom\*\* or \*\*Open in Solflare\*\* to load it inside the wallet app.

2\. Connect your wallet. The scan starts automatically.

3\. Optionally tick dust tokens to burn. A confirmation dialog lists exactly what will be

&#x20;  burned.

4\. Click \*\*Reclaim\*\* and approve in your wallet.



The page signs in your own wallet extension and never sees your keys. Its `/rpc`

endpoint forwards only five read-and-send Solana RPC methods

(`getTokenAccountsByOwner`, `getLatestBlockhash`, `getSignatureStatuses`,

`getBlockHeight`, `sendTransaction`), because the public RPC rejects requests coming

straight from browsers.



\## Project layout



```

src/rescue.ts         Core logic: scan, safety checks, close and burn instructions, batching

src/plugin.ts         PayBox MCP server exposing scan\_wallet and reclaim\_rent

scripts/build.mjs     Bundles the plugin into dist/plugin.mjs

web/                  Web app (app.ts and index.html)

scripts/build-web.mjs Builds web-dist/

scripts/serve-web.mjs Local server for the web app, with an /rpc forwarder

vercel/               Vercel config and the /api/rpc forwarder

scripts/build-vercel.mjs  Assembles vercel-site/ for deployment

test/                 Unit and bundle tests against a fake Solana RPC

```



\## Develop



Requires Node 24 or newer and pnpm.



```bash

pnpm install --frozen-lockfile

pnpm build          # bundle the plugin into dist/plugin.mjs

pnpm test:unit      # build, then run the unit and bundle tests

pnpm web            # run the web app at http://localhost:5173

pnpm build:vercel   # assemble vercel-site/ for deployment

```



Set `SOLANA\_RPC\_URL` to use a private RPC endpoint (for example Helius) instead of the

public one, for the local web server, the Vercel function or the plugin.



\## PayBox developer portal setup



\- \*\*Upload:\*\* `dist/plugin.mjs` (one file, under 10 MiB).

\- \*\*Network host:\*\* `api.mainnet-beta.solana.com`

\- \*\*Environment variable (optional):\*\* `SOLANA\_RPC\_URL` for a different RPC endpoint.

&#x20; Add its hostname as a network host too. If it needs an API key in a header, store the

&#x20; key as a host-scoped \*\*Secret\*\*, not in the URL.

\- \*\*Secrets:\*\* none required.



\## Deploy the web app to Vercel



1\. Run `pnpm build:vercel` and commit `vercel-site/`.

2\. Import the repository in Vercel and set \*\*Root Directory\*\* to `vercel-site`.

3\. Optionally add `SOLANA\_RPC\_URL` under Environment Variables.



\## Technical notes



\- Uses the SPL Token `CloseAccount` (index 9) and `Burn` (index 8) instructions on both

&#x20; `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` and

&#x20; `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (Token-2022).

\- Burns are ordered before closes, and each batch stays under Solana's 1232-byte

&#x20; transaction limit.

\- Proposals are legacy transactions with one empty signature slot and a placeholder

&#x20; blockhash, which PayBox replaces when it signs.

\- RPC reads time out after 3.5 seconds and retry once on rate limits or server errors,

&#x20; to stay inside PayBox's 10-second limit per call.



\## License



MIT

'@

Set-Content -Path README.md -Value $readme -Encoding utf8

Write-Host "README.md updated"



