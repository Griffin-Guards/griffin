# GRIFFIN

Your agent holds one key. Griffin holds the other.

An AI agent that can spend needs a wallet, and a wallet with one hot key does whatever the agent is talked into. GRIFFIN gives the agent half a wallet. Funds sit in a [Squads v4](https://squads.so) multisig that needs 2 of 3 votes. The agent proposes and votes once. Griffin, a co-signer, simulates the move and adds the second vote only when the move fits the charter you signed. You keep the third key and the crown.

- Site: https://griffinguard.fun
- X: https://x.com/griffindotfun
- API: https://griffinguard.fun/v1

## The three keys

| Key | Squads role | What it does |
|---|---|---|
| **Owner** (you) | full member, config authority | Signs the charter. Swaps the agent key or dismisses Griffin alone, in one transaction, with no vote. Owner moves pass without a check. |
| **Agent** | full member | Proposes moves and votes for them. One vote is never enough. |
| **Griffin** | vote only | Votes on agent moves inside the charter. Can never propose or execute, so it can never move funds by itself. |

Threshold 2, no time lock. The vault is the rent collector, so the rent of closed proposals goes back to your wallet.

## A move, end to end

1. The agent sends `vaultTransactionCreate` + `proposalCreate` + its own `proposalApprove`.
2. It calls `POST /v1/guard { multisig, index }`.
3. Griffin reads the proposal, then simulates `[griffin approve, execute]` and reads every writable account before and after.
4. The move is judged against the owner-signed policy.
5. **PASSED**: Griffin returns a release transaction (its vote, execute, close accounts) signed by Griffin, with the agent as fee payer. The agent signs and sends it.
   **TURNED BACK**: the reasons, and nothing moves. The proposal stays at 1 of 2.

## The charter

The owner signs this message in the wallet (`signMessage`, free, nothing moves):

```
GRIFFIN policy
wallet: <multisig>
hash: <sha256 of the policy>
nonce: <ms timestamp>
```

Only the multisig's config authority can set it, so an agent can't loosen its own leash.

| Field | Meaning |
|---|---|
| `solPerTx`, `solPerDay` | lamports, per move and per rolling 24 h of passed moves |
| `tokens` | `{ mint: { perTx, perDay } }` in base units |
| `recipients` | wallets the agent may pay |
| `programs` | extra programs on top of the base list |
| `buyOnly` | mints a swap may end in |

Base programs: System, Token, Token-2022, Associated Token, Compute Budget, Memo, Jupiter v6 (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`).

Always turned back, whatever the charter says:
- `approve` / `approveChecked` (letting someone else spend the tokens)
- `setAuthority`, and a token account closed into another wallet
- system calls other than a plain transfer
- a transfer to anyone not on the recipient list (SOL into the wallet's own wSOL account counts as the wallet)
- a payout with nothing coming back
- a simulated result where a delegate, an owner or a close authority changes
- a move that fails in simulation

## Agents

`agent/` runs next to the agent and keeps the agent key local.

```bash
npm run setup
export GRIFFIN_AGENT_KEY=./agent-key.json   # keypair JSON or base58 secret
export GRIFFIN_WALLET=<multisig address>
export SOL_RPC_URL=<your mainnet RPC>
node agent/cli.mjs status
node agent/cli.mjs send <to> 0.05
node agent/cli.mjs swap So11111111111111111111111111111111111111112 EPjFWdd5AufqSSqeM2qq1xzybapC8G4wGGkEZwyTDt1v 1000000 100
node agent/cli.mjs mcp                       # stdio MCP server
```

MCP tools: `griffin_status`, `griffin_send_sol`, `griffin_send_token`, `griffin_swap`. A swap asks Jupiter again without any DEX whose program would sit outside the list, so routes come back in a shape Griffin can pass.

The worker also serves a read-only MCP at `POST /mcp` with `griffin_check` and `griffin_policy`.

## API

| | |
|---|---|
| `GET /v1/griffin` | Griffin's vote key and the base program list |
| `GET /v1/wallet/:multisig` | members, whether Griffin can guard it, the policy, recent verdicts |
| `POST /v1/policy` | `{ multisig, policy, nonce, signature }` signed by the owner |
| `POST /v1/guard` | `{ multisig, index, submit? }` → verdict, plus the release transaction when passed |
| `GET /v1/feed`, `GET /v1/stats` | the public gate: latest verdicts and counts |

`submit: true` is for owner moves from a browser wallet: Griffin sends its own vote, because wallets such as Phantom add instructions to a transaction and that voids a signature made in advance.

## Run your own Griffin

```bash
npm run setup && npm test          # 18 offline tests of the policy engine
npm run build                      # bundles app-src into site/app/app.js
cd worker
npx wrangler d1 create griffin     # paste the id into wrangler.toml
npx wrangler d1 execute griffin --remote --file schema.sql
npx wrangler secret put GRIFFIN_SECRET   # base58 secret key of Griffin's vote key
npx wrangler secret put SOL_RPC_URL      # a mainnet RPC that accepts Cloudflare IPs
npx wrangler deploy
```

Fund Griffin's key with a little SOL: it pays the fee when it sends its own vote for owner moves.

Locally, `npm run dev` runs the worker on Node with SQLite in place of D1 (put `GRIFFIN_SECRET` in `worker/.dev.vars`). `test/live-check.mjs` is the mainnet run with throwaway keys from `test/.live-keys.json`: create a wallet, sign a charter, pay a listed friend, swap through Jupiter, try a stranger, the limits and an `approve`, then dismiss Griffin and send everything back.

## Limits, honestly

- Griffin's key lives on a server. If it goes down, agent moves wait, and the owner can dismiss it in one transaction and keep going.
- Inside an allowed program, value can still be lost within the limits, for example a bad swap price inside the slippage the agent asked for.
- Each proposal holds about 0.004 SOL of rent from the agent until it is closed.
- Very long Jupiter routes may not fit one Squads transaction.
- No audit.

## License

MIT
