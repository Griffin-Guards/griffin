// GRIFFIN on Robinhood Chain: the co-signer.
//   GET  /v1/griffin             Griffin's key, the module, the chain
//   GET  /v1/safe/:safe          the Safe's charter as the module and its CharterSet event hold it
//   POST /v1/charter             { safe, tx } -> reads the CharterSet event from that transaction and keeps its lists
//   GET  /v1/charter/:safe, /v1/verdicts/:safe   what Griffin keeps, without touching the chain
//   POST /v1/guard               { safe, to, value, data } -> verdict; when passed, Griffin's signature and the execute calldata
//   GET  /v1/feed, /v1/stats     the gate
//   POST /mcp                    griffin_check, griffin_charter
// The charter lives on chain and is enforced there. Griffin adds a simulation of each move and its signature.
import { privateKeyToAccount } from 'viem/accounts';
import { client, addr, readCharter, guardMove, charterLists, fmtEth, CHAIN_ID } from '../../core/griffin-rh.mjs';

export const VERSION = '0.1.0';
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version',
};
const json = (body, status = 200) => new Response(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), {
  status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const fail = (status, message) => Object.assign(new Error(message), { status });

const pub = (env) => client(env.RH_RPC_URL);
const griffinKey = (env) => {
  if (!env.GRIFFIN_KEY) throw fail(503, 'Griffin has no key yet');
  return privateKeyToAccount(env.GRIFFIN_KEY.startsWith('0x') ? env.GRIFFIN_KEY : `0x${env.GRIFFIN_KEY}`);
};
const moduleOf = (env) => {
  if (!env.MODULE) throw fail(503, 'the GRIFFIN module is not deployed yet');
  return addr(env.MODULE);
};
const fromBlock = (env) => BigInt(env.MODULE_FROM_BLOCK || 0);
// how far back to look for CharterSet logs; QuickNode's plan allows 5 blocks a call
const logScan = (env) => BigInt(env.LOG_SCAN || 9000);

function readMove(body) {
  const to = addr(body.to);
  let value;
  try { value = BigInt(body.value ?? 0); } catch { throw fail(400, 'value is wei as a decimal string'); }
  if (value < 0n) throw fail(400, 'value is wei as a decimal string');
  const data = body.data || '0x';
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length > 2 + 2 * 24576) throw fail(400, 'data is hex calldata');
  return { to, value, data };
}

// Charter lists, kept from the CharterSet event: free RPCs refuse the long log ranges needed to find it again.
const big = (_, v) => (typeof v === 'bigint' ? v.toString() : v);
async function knownOf(env, safe) {
  const row = await env.DB.prepare('SELECT version, lists FROM charters WHERE safe = ?').bind(safe).first();
  return row ? { version: row.version, ...JSON.parse(row.lists) } : null;
}
async function keep(env, safe, lists, tx = null) {
  const body = JSON.stringify({ recipients: lists.recipients, tokens: lists.tokens.map((t) => ({ token: t.token, perMove: t.perMove, perDay: t.perDay })), targets: lists.targets }, big);
  await env.DB.prepare('INSERT INTO charters (safe, version, lists, tx, at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(safe) DO UPDATE SET version = ?2, lists = ?3, tx = ?4, at = ?5')
    .bind(safe, lists.version.toString(), body, tx, Date.now()).run();
}
async function charterOf(env, safe) {
  const known = await knownOf(env, safe);
  const c = await readCharter(pub(env), moduleOf(env), safe, { known, fromBlock: fromBlock(env), scan: logScan(env) });
  if (c.listsKnown && c.version > 0n && (!known || known.version !== c.version.toString())) await keep(env, safe, c);
  return { c, known };
}

async function reportCharter(env, body) {
  const safe = addr(body.safe);
  if (!/^0x[0-9a-fA-F]{64}$/.test(body.tx || '')) throw fail(400, 'tx is a transaction hash');
  const receipt = await pub(env).getTransactionReceipt({ hash: body.tx }).catch(() => null);
  if (!receipt || receipt.status !== 'success') throw fail(404, 'no successful transaction with that hash yet');
  const lists = charterLists(receipt.logs, moduleOf(env), safe);
  if (!lists) throw fail(400, 'that transaction wrote no charter for this Safe');
  await keep(env, safe, lists, body.tx);
  return { safe, version: lists.version, kept: true };
}

async function safeView(env, safe) {
  const { c: charter } = await charterOf(env, addr(safe));
  const { results } = await env.DB.prepare('SELECT nonce, verdict, reasons, to_addr, value, at FROM verdicts WHERE safe = ? ORDER BY at DESC LIMIT 20').bind(charter.safe).all();
  return { ...charter, guardedByThisGriffin: charter.griffin.toLowerCase() === griffinKey(env).address.toLowerCase(), verdicts: results.map(row) };
}

async function guard(env, body) {
  const safe = addr(body.safe);
  const day = new Date().toISOString().slice(0, 10);
  const used = await env.DB.prepare('SELECT n FROM usage WHERE safe = ? AND day = ?').bind(safe, day).first();
  if ((used?.n || 0) >= Number(env.GUARD_PER_DAY || 500)) throw fail(429, 'this Safe asked Griffin too often today');
  await env.DB.prepare('INSERT INTO usage (safe, day, n) VALUES (?1, ?2, 1) ON CONFLICT(safe, day) DO UPDATE SET n = n + 1').bind(safe, day).run();
  const move = readMove(body);
  const r = await guardMove({ pub: pub(env), module: moduleOf(env), fromBlock: fromBlock(env), known: await knownOf(env, safe), scan: logScan(env), griffin: griffinKey(env), safe, move });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO verdicts (safe, nonce, to_addr, value, selector, verdict, reasons, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
      .bind(safe, Number(r.nonce), move.to, move.value.toString(), move.data.slice(0, 10), r.verdict, JSON.stringify(r.reasons), Date.now()),
    env.DB.prepare('INSERT INTO counts (verdict, n) VALUES (?1, 1) ON CONFLICT(verdict) DO UPDATE SET n = n + 1').bind(r.verdict),
  ]);
  return r;
}

const row = (r) => ({ safe: r.safe, nonce: r.nonce, to: r.to_addr, value: r.value, verdict: r.verdict, reasons: JSON.parse(r.reasons), at: r.at });

async function feed(env, limit) {
  const { results } = await env.DB.prepare('SELECT safe, nonce, to_addr, value, verdict, reasons, at FROM verdicts ORDER BY at DESC LIMIT ?').bind(limit).all();
  return { verdicts: results.map(row) };
}

async function stats(env) {
  const { results } = await env.DB.prepare('SELECT verdict, n FROM counts').all();
  const by = Object.fromEntries(results.map((r) => [r.verdict, r.n]));
  const safes = await env.DB.prepare('SELECT COUNT(DISTINCT safe) AS n FROM verdicts').first();
  return { passed: by.passed || 0, turnedBack: by['turned back'] || 0, safes: safes.n, token: env.TOKEN_ADDRESS || null };
}

// ---------- MCP ----------
const MCP_TOOLS = [
  { name: 'griffin_check', title: 'Ask Griffin to co-sign', description: 'Ask Griffin to judge a move out of a GRIFFIN-guarded Safe on Robinhood Chain. Returns PASSED with Griffin\'s signature and the calldata for GriffinModule.execute (send it from the agent key), or TURNED BACK with reasons. value is wei as a decimal string, data is hex calldata ("0x" for a plain ETH send). Never try to route around a TURNED BACK.', inputSchema: { type: 'object', properties: { safe: { type: 'string' }, to: { type: 'string' }, value: { type: 'string' }, data: { type: 'string' } }, required: ['safe', 'to'] } },
  { name: 'griffin_charter', title: 'Read the charter', description: 'The charter the Safe wrote on chain: ETH per move and per day, spent today, recipients, token limits, contracts it may call. Plan moves inside it.', inputSchema: { type: 'object', properties: { safe: { type: 'string' } }, required: ['safe'] } },
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
        serverInfo: { name: 'griffin-rh', title: 'GRIFFIN on Robinhood Chain', version: VERSION },
        instructions: 'You spend from a Safe through GriffinModule. Read the charter first, ask griffin_check for each move, then send the execute calldata it returns from your agent key.',
      });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: MCP_TOOLS });
    case 'tools/call': {
      const { name, arguments: a = {} } = msg.params || {};
      try {
        if (name === 'griffin_check') {
          const r = await guard(env, a);
          return text(`${r.verdict.toUpperCase()}${r.reasons.length ? `: ${r.reasons.join('; ')}` : ''}${r.execute ? '\nSend execute.data to execute.to from the agent key before the deadline.' : ''}`, r);
        }
        if (name === 'griffin_charter') {
          const c = await safeView(env, a.safe);
          return text(c.version === 0n ? 'No charter: the agent can move nothing.' : `${fmtEth(c.ethPerMove)} ETH per move, ${fmtEth(c.ethPerDay)} per day, ${fmtEth(c.spentEth)} spent today; ${c.recipients.length} recipients, ${c.tokens.length} tokens, ${c.targets.length} contracts`, c);
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (p === '/mcp') return request.method === 'POST' ? await mcp(request, env) : json({ error: 'MCP endpoint: send JSON-RPC with POST' }, 405);
      if (request.method === 'GET') {
        if (p === '/v1') return json({ name: 'GRIFFIN API · Robinhood Chain', version: VERSION, endpoints: ['/v1/griffin', '/v1/safe/:safe', '/v1/charter', '/v1/guard', '/v1/feed', '/v1/stats', '/mcp'] });
        if (p === '/v1/griffin') return json({ griffin: griffinKey(env).address, module: env.MODULE || null, chainId: CHAIN_ID, version: VERSION });
        if (p === '/v1/stats') return json(await stats(env));
        if (p === '/v1/feed') return json(await feed(env, Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30))));
        // D1 only, no chain reads: the app reads the chain itself and asks these for what only Griffin keeps
        const k = p.match(/^\/v1\/charter\/(0x[0-9a-fA-F]{40})$/);
        if (k) return json({ safe: addr(k[1]), known: await knownOf(env, addr(k[1])) });
        const v = p.match(/^\/v1\/verdicts\/(0x[0-9a-fA-F]{40})$/);
        if (v) {
          const { results } = await env.DB.prepare('SELECT safe, nonce, to_addr, value, verdict, reasons, at FROM verdicts WHERE safe = ? ORDER BY at DESC LIMIT 30').bind(addr(v[1])).all();
          return json({ verdicts: results.map(row) });
        }
        const s = p.match(/^\/v1\/safe\/(0x[0-9a-fA-F]{40})$/);
        if (s) return json(await safeView(env, s[1]));
      }
      if (request.method === 'POST' && p === '/v1/guard') return json(await guard(env, await request.json().catch(() => ({}))));
      if (request.method === 'POST' && p === '/v1/charter') return json(await reportCharter(env, await request.json().catch(() => ({}))));
      if (p.startsWith('/v1')) throw fail(404, 'not found');
      return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'not found' }, 404);
    } catch (e) {
      if (!e.status) console.error(e);
      return json({ error: e.status ? e.message : 'something broke, try again' }, e.status || 500);
    }
  },
};
