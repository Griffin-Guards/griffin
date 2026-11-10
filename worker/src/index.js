// GRIFFIN API (Cloudflare Worker + D1): the second key on an AI agent's Solana wallet.
//   GET  /v1/griffin                 Griffin's public key and the base program list
//   GET  /v1/wallet/:multisig        wallet members, whether Griffin can guard it, policy, last verdicts
//   POST /v1/policy                  { multisig, policy, nonce, signature } signed by the owner (config authority)
//   POST /v1/guard                   { multisig, index } -> verdict; when passed, a release tx signed by Griffin
//   GET  /v1/feed                    latest verdicts across all wallets
//   GET  /v1/stats                   counts
//   POST /mcp                        read-only tools for agents: check a move, read a policy
//   POST /rpc                        short list of RPC calls for the site, keeps the RPC key here

import {
  Connection, Keypair, PublicKey, bs58, readMove, readWallet, guardable, normalizePolicy, policyHash, policyMessage,
  verifySigned, simulateMove, judge, checkInstructions, buildRelease, compile, fmtSol, BASE_PROGRAMS, multisig as squads,
} from '../../core/griffin.mjs';

export const VERSION = '0.1.0';
const DAY = 86400000;
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version',
};
const json = (body, status = 200) => new Response(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), {
  status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const fail = (status, message) => Object.assign(new Error(message), { status });
const isKey = (s) => { try { return new PublicKey(s).toBase58() === s; } catch { return false; } };

const connection = (env) => new Connection(env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const griffinKey = (env) => {
  if (!env.GRIFFIN_SECRET) throw fail(503, 'Griffin has no key yet');
  return Keypair.fromSecretKey(bs58.decode(env.GRIFFIN_SECRET));
};

async function policyOf(env, multisig) {
  const row = await env.DB.prepare('SELECT body, hash, owner, updated FROM policies WHERE multisig = ?').bind(multisig).first();
  return row ? { policy: JSON.parse(row.body), hash: row.hash, owner: row.owner, updated: row.updated } : null;
}

async function walletView(env, multisig) {
  if (!isKey(multisig)) throw fail(400, 'that wallet address looks wrong');
  const griffin = griffinKey(env).publicKey.toBase58();
  let wallet;
  try { wallet = await readWallet(connection(env), multisig); } catch { throw fail(404, 'no Squads wallet at that address'); }
  const { results } = await env.DB.prepare('SELECT idx, creator, verdict, reasons, sol_out, at FROM verdicts WHERE multisig = ? ORDER BY at DESC LIMIT 30').bind(multisig).all();
  return {
    multisig, ...wallet, griffin,
    problem: guardable(wallet, griffin),
    policy: await policyOf(env, multisig),
    spent24h: (await spentToday(env, multisig, -1)).sol,
    verdicts: results.map(row),
  };
}

const row = (r) => ({ multisig: r.multisig, index: r.idx, creator: r.creator, verdict: r.verdict, reasons: JSON.parse(r.reasons), solOut: r.sol_out, at: r.at });

async function setPolicy(env, body) {
  const { multisig, nonce, signature } = body || {};
  if (!isKey(multisig)) throw fail(400, 'that wallet address looks wrong');
  if (!/^\d{13}$/.test(String(nonce)) || Math.abs(Date.now() - Number(nonce)) > 10 * 60000) throw fail(400, 'the signed policy is too old, sign it again');
  let policy;
  try { policy = normalizePolicy(body.policy); } catch (e) { throw fail(400, e.message); }
  const wallet = await readWallet(connection(env), multisig).catch(() => { throw fail(404, 'no Squads wallet at that address'); });
  const problem = guardable(wallet, griffinKey(env).publicKey.toBase58());
  if (problem) throw fail(400, problem);
  const owner = wallet.configAuthority;
  if (!verifySigned(policyMessage(multisig, policy, nonce), signature, owner)) throw fail(401, 'the signature is not from the wallet owner');
  const old = await env.DB.prepare('SELECT nonce FROM policies WHERE multisig = ?').bind(multisig).first();
  if (old && Number(old.nonce) >= Number(nonce)) throw fail(409, 'a newer policy is already set');
  const hash = policyHash(policy);
  await env.DB.prepare(`INSERT INTO policies (multisig, owner, body, hash, nonce, signature, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(multisig) DO UPDATE SET owner = ?2, body = ?3, hash = ?4, nonce = ?5, signature = ?6, updated = ?7`)
    .bind(multisig, owner, JSON.stringify(policy), hash, String(nonce), signature, Date.now()).run();
  return { multisig, owner, hash, policy };
}

// What Griffin already passed for this wallet in the last 24 hours, leaving out the move being judged.
async function spentToday(env, multisig, index) {
  const { results } = await env.DB.prepare("SELECT sol_out, tokens_out FROM verdicts WHERE multisig = ? AND verdict = 'passed' AND at > ? AND idx != ?")
    .bind(multisig, Date.now() - DAY, index).all();
  const out = { sol: 0n, tokens: {} };
  for (const r of results) {
    out.sol += BigInt(r.sol_out || 0);
    for (const [m, v] of Object.entries(JSON.parse(r.tokens_out || '{}'))) out.tokens[m] = (out.tokens[m] || 0n) + BigInt(v);
  }
  return out;
}

async function limitCheck(env, multisig) {
  const day = new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare('INSERT INTO usage (multisig, day, n) VALUES (?1, ?2, 1) ON CONFLICT(multisig, day) DO UPDATE SET n = n + 1 RETURNING n').bind(multisig, day).first();
  if (r.n > Number(env.GUARD_PER_DAY || 500)) throw fail(429, 'that is all the checks for this wallet today');
}

async function guard(env, body) {
  const { multisig } = body || {};
  const index = Number(body?.index);
  if (!isKey(multisig)) throw fail(400, 'that wallet address looks wrong');
  if (!Number.isInteger(index) || index < 1) throw fail(400, 'give the move number (index)');
  await limitCheck(env, multisig);
  const conn = connection(env);
  const griffin = griffinKey(env);
  const griffinPk = griffin.publicKey.toBase58();
  let move;
  try { move = await readMove(conn, multisig, index); } catch (e) { throw fail(404, e.message); }
  const problem = guardable(move.wallet, griffinPk);
  if (problem) throw fail(400, problem);
  if (move.status !== 'Active') throw fail(409, `that move is ${move.status}, not waiting for a vote`);
  if (move.stale) throw fail(409, 'that move is stale: the wallet config changed after it');
  const owner = move.wallet.configAuthority;
  const saved = await policyOf(env, multisig);
  let result;
  if (move.creator === owner) {
    result = { verdict: 'passed', reasons: ['the owner proposed it'], out: { sol: 0n, tokens: {} } };
  } else if (!saved) {
    result = { verdict: 'turned back', reasons: ['the owner has not set a policy yet'], out: { sol: 0n, tokens: {} } };
  } else {
    const sim = await simulateMove({ connection: conn, move, griffin: griffinPk });
    if (!sim.ok) {
      // A failed run still gets read against the rules, so the owner sees what was wrong with it.
      const { problems } = checkInstructions(move, saved.policy);
      result = { verdict: 'turned back', reasons: [...problems, `the move fails when simulated: ${JSON.stringify(sim.err)}`], out: { sol: 0n, tokens: {} }, logs: sim.logs };
    } else {
      result = judge({ move, policy: saved.policy, delta: sim.delta, spent: await spentToday(env, multisig, index), owner });
      result.delta = { sol: sim.delta.sol, tokens: sim.delta.tokens };
    }
  }
  const at = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO verdicts (multisig, idx, creator, verdict, reasons, sol_out, tokens_out, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(multisig, idx) DO UPDATE SET verdict = ?4, reasons = ?5, sol_out = ?6, tokens_out = ?7, at = ?8`)
      .bind(multisig, index, move.creator, result.verdict, JSON.stringify(result.reasons), result.out.sol.toString(),
        JSON.stringify(Object.fromEntries(Object.entries(result.out.tokens).map(([k, v]) => [k, v.toString()]))), at),
    env.DB.prepare('INSERT INTO counts (verdict, n) VALUES (?1, 1) ON CONFLICT(verdict) DO UPDATE SET n = n + 1').bind(result.verdict),
  ]);
  const out = { multisig, index, creator: move.creator, verdict: result.verdict, reasons: result.reasons, out: result.out, delta: result.delta, logs: result.logs, policyHash: saved?.hash || null, at };
  if (result.verdict !== 'passed') return out;
  // Browser wallets add their own instructions when signing, which would void Griffin's signature.
  // So for the owner Griffin sends its vote alone and pays that fee; the owner executes after.
  if (body.submit && move.creator === owner) {
    const { blockhash } = await conn.getLatestBlockhash();
    const vote = compile(griffin.publicKey, blockhash, [squads.instructions.proposalApprove({ multisigPda: new PublicKey(multisig), transactionIndex: BigInt(index), member: griffin.publicKey })]);
    vote.sign([griffin]);
    const signature = await conn.sendRawTransaction(vote.serialize());
    return { ...out, voteSignature: signature };
  }
  // Passed: Griffin signs its vote; the proposer pays the fee, signs and sends.
  const { ixs, tables } = await buildRelease({ connection: conn, multisigPda: multisig, index, griffin: griffinPk, member: move.creator });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = compile(move.creator, blockhash, ixs, tables);
  tx.sign([griffin]);
  return { ...out, transaction: Buffer.from(tx.serialize()).toString('base64'), lastValidBlockHeight };
}

async function feed(env, limit) {
  const { results } = await env.DB.prepare('SELECT multisig, idx, creator, verdict, reasons, sol_out, at FROM verdicts ORDER BY at DESC LIMIT ?').bind(limit).all();
  return { verdicts: results.map(row) };
}

async function stats(env) {
  const { results } = await env.DB.prepare('SELECT verdict, n FROM counts').all();
  const by = Object.fromEntries(results.map((r) => [r.verdict, r.n]));
  const wallets = await env.DB.prepare('SELECT COUNT(*) AS n FROM policies').first();
  return { passed: by.passed || 0, turnedBack: by['turned back'] || 0, wallets: wallets.n, token: env.TOKEN_ADDRESS || null };
}

// ---------- MCP ----------
const MCP_TOOLS = [
  { name: 'griffin_check', title: 'Ask Griffin to co-sign', description: 'Ask Griffin to judge a proposed move on a Griffin-guarded Squads wallet. Returns PASSED with a release transaction (Griffin vote + execute, already signed by Griffin; you sign as fee payer and send) or TURNED BACK with reasons. Never try to route around a TURNED BACK.', inputSchema: { type: 'object', properties: { multisig: { type: 'string' }, index: { type: 'number' } }, required: ['multisig', 'index'] } },
  { name: 'griffin_policy', title: 'Read the policy', description: 'The owner-signed policy for a wallet: SOL per move and per day, token limits, recipients, extra programs, buy list. Plan moves inside it.', inputSchema: { type: 'object', properties: { multisig: { type: 'string' } }, required: ['multisig'] } },
];

async function mcp(request, env) {
  const msg = await request.json().catch(() => null);
  if (!msg || msg.jsonrpc !== '2.0') return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
  const reply = (result) => json({ jsonrpc: '2.0', id: msg.id, result });
  const text = (t, data) => reply({ content: [{ type: 'text', text: t }], ...(data ? { structuredContent: JSON.parse(JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v))) } : {}) });
  if (msg.id === undefined) return new Response(null, { status: 202, headers: cors });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'griffin', title: 'GRIFFIN: the second key on your agent wallet', version: VERSION },
        instructions: 'Your wallet needs two votes. You hold one, Griffin holds the other and only votes for moves inside the owner\'s policy. Read the policy first, propose, then call griffin_check.',
      });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: MCP_TOOLS });
    case 'tools/call': {
      const { name, arguments: a = {} } = msg.params || {};
      try {
        if (name === 'griffin_check') {
          const r = await guard(env, a);
          return text(`${r.verdict.toUpperCase()}${r.reasons.length ? `: ${r.reasons.join('; ')}` : ''}${r.transaction ? '\nSign the transaction as fee payer and send it.' : ''}`, r);
        }
        if (name === 'griffin_policy') {
          const w = await walletView(env, a.multisig);
          return text(w.policy ? `Policy ${w.policy.hash.slice(0, 12)}: ${fmtSol(w.policy.policy.solPerTx)} SOL per move, ${fmtSol(w.policy.policy.solPerDay)} SOL per day, spent ${fmtSol(w.spent24h)} in 24h` : 'No policy yet: every agent move is turned back.', w);
        }
        return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool: ${name}` } });
      } catch (e) {
        if (!e.status) console.error(e);
        return reply({ isError: true, content: [{ type: 'text', text: e.status ? e.message : 'failed' }] });
      }
    }
    default: return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

// ---------- RPC for the site ----------
const RPC_ALLOWED = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getLatestBlockhash', 'getTokenAccountsByOwner',
  'sendTransaction', 'simulateTransaction', 'getSignatureStatuses', 'getBlockHeight', 'getAddressLookupTable',
]);
async function rpc(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  const text = await request.text();
  if (text.length > 64 * 1024) return json({ error: 'too large' }, 413);
  let call;
  try { call = JSON.parse(text); } catch { return json({ error: 'bad JSON' }, 400); }
  if (Array.isArray(call) || !RPC_ALLOWED.has(call?.method)) return json({ jsonrpc: '2.0', id: call?.id ?? null, error: { code: -32000, message: 'Method not allowed' } }, 403);
  const upstream = await fetch(env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
  return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (p === '/rpc') return await rpc(request, env);
      if (p === '/mcp') return request.method === 'POST' ? await mcp(request, env) : json({ error: 'MCP endpoint: send JSON-RPC with POST' }, 405);
      if (request.method === 'GET') {
        if (p === '/v1') return json({ name: 'GRIFFIN API', version: VERSION, endpoints: ['/v1/griffin', '/v1/wallet/:multisig', '/v1/policy', '/v1/guard', '/v1/feed', '/v1/stats', '/mcp'] });
        if (p === '/v1/griffin') return json({ griffin: griffinKey(env).publicKey.toBase58(), programs: BASE_PROGRAMS, version: VERSION });
        if (p === '/v1/stats') return json(await stats(env));
        if (p === '/v1/feed') return json(await feed(env, Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30))));
        const w = p.match(/^\/v1\/wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
        if (w) return json(await walletView(env, w[1]));
      }
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (p === '/v1/policy') return json(await setPolicy(env, body), 201);
        if (p === '/v1/guard') return json(await guard(env, body));
      }
      if (p.startsWith('/v1')) throw fail(404, 'not found');
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (!e.status) console.error(e);
      return json({ error: e.status ? e.message : 'internal error' }, e.status || 500);
    }
  },
};
