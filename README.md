# GRIFFIN on Robinhood Chain

Your agent holds one key. Griffin holds the other.

A policy guard for AI agent wallets on Robinhood Chain. The agent's funds sit in a [Safe](https://safe.global) (v1.4.1, already on Robinhood Chain). The owner stays the Safe's only owner. The agent is not an owner: it can only spend through **GriffinModule**, and only inside the charter the Safe wrote on chain, with Griffin's signature on every move.

## Who holds what

The charter is **on chain**, in the module, so the limits hold even if Griffin's server or key is compromised. Griffin adds a simulation of each move and its EIP-712 signature on top.

| | |
|---|---|
| Owner | the Safe's owner. Writes the charter, swaps the agent key, removes Griffin or disables the module, all with ordinary Safe transactions and no one else's vote. |
| Agent | a plain key. Calls `GriffinModule.execute(safe, to, value, data, deadline, signature)`. |
| Griffin | signs `Move(safe, to, value, dataHash, nonce, deadline)` after it simulates the move. Can never move funds itself. |

## The charter (enforced by the module)

- **ETH per move** and **ETH per UTC day**.
- **Recipients**: plain ETH sends and token `transfer`s only reach these.
- **Tokens** with a per-move and per-day limit. On a listed token only `transfer` (to a recipient) and `approve` (of a listed contract) are allowed; approvals count against the limit.
- **Targets**: contracts the agent may call with data (a DEX router, for example) and the only spenders it may approve.
- Never: a call to the Safe itself or to the module (that would run as the owner), delegatecall, a stale nonce, an expired or edited move.

`setCharter` replaces the whole charter: older recipients, tokens and targets stop counting. The full charter is in the `CharterSet` event, so anyone can read what a Safe allows.

Griffin also turns back a move that fails in simulation, or a call into a contract that takes ETH or tokens out of the Safe and returns nothing.

## Layout

| | |
|---|---|
| `contracts/GriffinModule.sol` | the module (6.5 KB runtime, no owner, no admin) |
| `contracts/GriffinSim.sol` | never deployed: placed by an `eth_call` state override and marked as a module, it runs a move through the Safe and reports the balance changes |
| `contracts/test.mjs` | 45 checks on a Hardhat fork with the real Safe singleton and factory |
| `contracts/deploy.html`, `deploy-server.mjs` | one-button deploy from a browser wallet; writes `deployed.json` |
| `core/griffin-rh.mjs` | charter reader, rule mirror (for reasons in words), simulation, verdict, EIP-712 signing, Safe setup calldata |
| `worker/` | the co-signer API: `/v1/griffin`, `/v1/safe/:safe`, `POST /v1/guard`, `/v1/feed`, `/v1/stats`, `POST /mcp` |
| `agent/` | CLI and stdio MCP for the agent: `griffin_status`, `griffin_send_eth`, `griffin_send_token`, `griffin_call` |
| `app-src/` | the app at /app/, bundled by `npm run build` into `site/app/app.js` |
| `test/e2e.mjs` | 22 checks: Safe made with the core's setup calldata, the worker in process, the agent kit sending real moves |

- Site: https://griffinguard.fun
- X: https://x.com/griffin_rbh
- GriffinModule: [`0x991948aCCf7C5d76e21c189136A0B19D7BBC7527`](https://repo.sourcify.dev/4663/0x991948aCCf7C5d76e21c189136A0B19D7BBC7527) (Sourcify exact match)

## Run the tests

```bash
npm install
cd contracts && node compile.mjs
npx hardhat node --config hardhat.config.cjs --port 8547   # a fork of Robinhood Chain; restart it if it gets old
node test.mjs
cd .. && node test/e2e.mjs
```

The public RPC keeps only recent state, so a fork older than a few thousand blocks starts failing with "historical state is not available".

## Deploy

1. `cd contracts && node deploy-server.mjs` and press the button at http://localhost:47231 with a wallet on Robinhood Chain. The address and block land in `deployed.json`.
2. Worker: `npx wrangler d1 create griffin-rh`, paste the id, `npx wrangler d1 execute griffin-rh --remote --file schema.sql`, set `MODULE` and `MODULE_FROM_BLOCK`, then `wrangler secret put GRIFFIN_KEY` and `RH_RPC_URL`, and `npx wrangler deploy`.
3. A Safe for an agent: `SafeProxyFactory.createProxyWithNonce(singletonL2, setupCalldata({...}), salt)`. `setupCalldata` in the core makes a 1-of-1 Safe for the owner that enables the module and writes the first charter in the same transaction. An existing Safe enables the module and calls `setCharter` with its own transaction.

## Limits

- The public Robinhood RPC answers `eth_call` with 429 from Cloudflare, so the worker needs a keyed RPC as `RH_RPC_URL`.
- Inside a listed contract, value can still be lost within the limits (a bad price inside the slippage the agent chose).
- Daily limits reset at 00:00 UTC, not on a rolling 24 hours.
- No audit.
