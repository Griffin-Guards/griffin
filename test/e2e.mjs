// End to end on a Hardhat fork of Robinhood Chain: module + Safe on chain, the Griffin worker in this process,
// and the agent kit sending real execute() transactions.
// Start the fork first: cd contracts && npx hardhat node --config hardhat.config.cjs --port 8547
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, http as viemHttp, parseEther, encodeFunctionData, decodeEventLog, toHex, zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chain as rhChain, SAFE, setupCalldata, MODULE_ABI } from '../core/griffin-rh.mjs';

const RPC = process.env.RPC || 'http://127.0.0.1:8547';
process.env.RH_RPC_URL = RPC;
const art = (n) => JSON.parse(readFileSync(new URL(`../contracts/build/${n}.json`, import.meta.url)));
const chain = { ...rhChain, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: viemHttp(RPC) });
const raw = (method, params = []) => pub.request({ method, params });
let fails = 0;
const ok = (name, good, detail = '') => { if (!good) fails++; console.log(`${good ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };
const E = (n) => parseEther(String(n));
const wallet = async (eth = '10') => {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  if (eth !== '0') await raw('hardhat_setBalance', [account.address, toHex(E(eth))]);
  return { key, account, address: account.address, w: createWalletClient({ account, chain, transport: viemHttp(RPC) }) };
};
const send = async (who, to, data, value = 0n) => pub.waitForTransactionReceipt({ hash: await who.w.sendTransaction({ to, data, value, gas: 3_000_000n }) });
const deploy = async (who, a) => (await pub.waitForTransactionReceipt({ hash: await who.w.deployContract({ abi: a.abi, bytecode: a.bytecode }) })).contractAddress;
const FACTORY_ABI = [
  { type: 'function', name: 'createProxyWithNonce', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bytes' }, { type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'event', name: 'ProxyCreation', inputs: [{ type: 'address', name: 'proxy', indexed: true }, { type: 'address', name: 'singleton' }] },
];
let lastTx;
const createSafe = async (owner, opts) => {
  const r = await send(owner, SAFE.factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createProxyWithNonce', args: [SAFE.singletonL2, setupCalldata({ owner: owner.address, ...opts }), BigInt(Date.now())] }));
  lastTx = r.transactionHash;
  return r.logs.map((l) => { try { return decodeEventLog({ abi: FACTORY_ABI, ...l }); } catch { return null; } }).find((e) => e?.eventName === 'ProxyCreation').args.proxy;
};

// ---- chain side
const [deployer, owner, agent, friend, stranger] = await Promise.all([wallet(), wallet(), wallet(), wallet('0'), wallet('0')]);
const griffinKey = generatePrivateKey();
const griffin = privateKeyToAccount(griffinKey);
const block = await pub.getBlockNumber();
const module = await deploy(deployer, art('GriffinModule'));
const token = await deploy(deployer, art('MockToken'));
const router = await deploy(deployer, art('MockRouter'));
await raw('hardhat_setBalance', [router, toHex(E(5))]);
const safe = await createSafe(owner, {
  module, agent: agent.address, griffin: griffin.address, ethPerMove: E(0.5), ethPerDay: E(1),
  recipients: [friend.address], tokens: [{ token, perMove: E(100), perDay: E(150) }], targets: [router],
});
await send(owner, safe, '0x', E(3));
await send(deployer, token, encodeFunctionData({ abi: art('MockToken').abi, functionName: 'mint', args: [safe, E(1000)] }));
ok('Safe made with setupCalldata from core', !!safe, safe);

// ---- Griffin's worker, in this process on SQLite
Object.assign(process.env, { GRIFFIN_KEY: griffinKey, MODULE: module, MODULE_FROM_BLOCK: String(block) });
const { default: worker } = await import('../worker/src/index.js');
const { sqliteD1 } = await import('../worker/d1-sqlite.mjs');
const env = { GRIFFIN_KEY: griffinKey, MODULE: module, MODULE_FROM_BLOCK: String(block), RH_RPC_URL: RPC, DB: sqliteD1(':memory:'), GUARD_PER_DAY: '500' };
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(0);
const API = `http://localhost:${server.address().port}`;
const get = (p) => fetch(API + p).then((r) => r.json());

const g = await get('/v1/griffin');
ok('worker reports its key and the module', g.griffin === griffin.address && g.module === module);
const view = await get(`/v1/safe/${safe}`);
const same = (x, y) => String(x).toLowerCase() === String(y).toLowerCase();
ok('worker reads the charter with its lists', view.version === '1' && same(view.recipients[0], friend.address) && same(view.tokens[0].token, token) && same(view.targets[0], router) && view.enabled === true, JSON.stringify({ v: view.version, r: view.recipients, t: view.tokens, g: view.targets, e: view.enabled }));

// ---- the agent kit
const { loadConfig, status, sendEth, sendToken, call, act } = await import('../agent/griffin-agent.mjs');
const cfg = loadConfig({ GRIFFIN_AGENT_KEY: agent.key, GRIFFIN_SAFE: safe, GRIFFIN_API: API, RH_RPC_URL: RPC });
const st = await status(cfg);
ok('status shows balance and charter', st.balanceEth === '3' && st.charter.ethPerMove === E(0.5).toString());

const a = await sendEth(cfg, friend.address, '0.2');
ok('0.2 ETH to the friend: PASSED and executed', a.verdict === 'passed' && a.status === 'success');
ok('friend got 0.2 ETH', (await pub.getBalance({ address: friend.address })) === E(0.2));
const b = await sendEth(cfg, stranger.address, '0.1');
ok('ETH to a stranger: TURNED BACK', b.verdict === 'turned back' && b.reasons.some((r) => r.includes('not on the recipient list')), b.reasons?.join('; '));
const c = await sendEth(cfg, friend.address, '0.7');
ok('0.7 ETH: TURNED BACK over the per move limit', c.verdict === 'turned back' && c.reasons.some((r) => r.includes('per move')), c.reasons?.join('; '));
const d = await sendToken(cfg, token, friend.address, '40');
ok('40 tokens to the friend: PASSED', d.verdict === 'passed' && d.status === 'success');
const tokenAbi = art('MockToken').abi;
const approve = (amt) => encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [router, E(amt)] });
ok('approve the router for 30: PASSED', (await call(cfg, token, approve(30))).verdict === 'passed');
const sell = (amt, back) => encodeFunctionData({ abi: art('MockRouter').abi, functionName: 'sell', args: [token, E(amt), E(back)] });
const s1 = await call(cfg, router, sell(10, 0.05));
ok('swap 10 tokens for 0.05 ETH: PASSED', s1.verdict === 'passed' && s1.status === 'success', s1.reasons?.join('; '));
const s2 = await call(cfg, router, sell(10, 0));
ok('a "swap" that pays out and returns nothing: TURNED BACK', s2.verdict === 'turned back' && s2.reasons.some((r) => r.includes('gets nothing back')), s2.reasons?.join('; '));
const s3 = await act(cfg, { to: safe, data: '0x0d582f13' + '0'.repeat(24) + agent.address.slice(2) + '0'.repeat(63) + '1' });
ok('adding itself as Safe owner: TURNED BACK', s3.verdict === 'turned back' && s3.reasons[0].includes('Safe or the module'), s3.reasons?.join('; '));
const s4 = await call(cfg, token, approve(9999));
ok('approve 9999: TURNED BACK over the token limits', s4.verdict === 'turned back', s4.reasons?.join('; '));

// a server that signs whatever: the module still holds the charter
const sig = await griffin.signTypedData({
  domain: { name: 'GRIFFIN', version: '1', chainId: 4663, verifyingContract: module },
  types: { Move: [{ name: 'safe', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'dataHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  primaryType: 'Move',
  message: { safe, to: stranger.address, value: E(0.4), dataHash: '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', nonce: await pub.readContract({ address: module, abi: MODULE_ABI, functionName: 'nonces', args: [safe] }), deadline: 9999999999n },
});
const leaked = await pub.call({ account: agent.address, to: module, data: encodeFunctionData({ abi: MODULE_ABI, functionName: 'execute', args: [safe, stranger.address, E(0.4), '0x', 9999999999n, sig] }) }).then(() => 'went through', () => 'reverted');
ok('even with Griffin\'s key leaked, the charter stops a payout to a stranger', leaked === 'reverted');

const f = await get('/v1/feed');
const stats = await get('/v1/stats');
ok('the gate records every verdict', f.verdicts.length === 9 && stats.passed === 4 && stats.turnedBack === 5, `${stats.passed} passed, ${stats.turnedBack} turned back`);

// a Safe that dismissed Griffin: the server says so instead of signing
const safe2 = await createSafe(owner, { module, agent: agent.address, griffin: zeroAddress, ethPerMove: E(0.5), ethPerDay: E(1), recipients: [friend.address] });
const r2 = await fetch(`${API}/v1/guard`, { method: 'POST', body: JSON.stringify({ safe: safe2, to: friend.address, value: '1' }) }).then((r) => r.json());
ok('a Safe without Griffin gets an explanation, not a signature', r2.verdict === 'turned back' && !r2.signature && r2.reasons[0].includes('without Griffin'));

// the app reports the creation transaction; Griffin keeps the lists from its CharterSet event
const safe3 = await createSafe(owner, { module, agent: agent.address, griffin: griffin.address, ethPerMove: E(0.1), ethPerDay: E(0.2), recipients: [friend.address, stranger.address] });
const rep = await fetch(`${API}/v1/charter`, { method: 'POST', body: JSON.stringify({ safe: safe3, tx: lastTx }) }).then((r) => r.json());
const kept = await get(`/v1/charter/${safe3}`);
ok('/v1/charter keeps the lists from the creation transaction', rep.kept === true && kept.known.recipients.length === 2 && kept.known.version === '1');
const wrong = await fetch(`${API}/v1/charter`, { method: 'POST', body: JSON.stringify({ safe: safe, tx: lastTx }) }).then((r) => r.status);
ok('a transaction that wrote another Safe charter is refused', wrong === 400);

// the stdio MCP server lists its tools
const mcp = spawn(process.execPath, [fileURLToPath(new URL('../agent/cli.mjs', import.meta.url)), 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
const tools = await new Promise((resolve) => {
  mcp.stdout.on('data', (b) => { for (const l of b.toString().split('\n').filter(Boolean)) { const m = JSON.parse(l); if (m.id === 2) resolve(m.result.tools.map((t) => t.name)); } });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
});
mcp.kill();
ok('agent MCP lists its four tools', tools.join() === 'griffin_status,griffin_send_eth,griffin_send_token,griffin_call');

const remote = await fetch(`${API}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'griffin_charter', arguments: { safe } } }) }).then((r) => r.json());
ok('hosted MCP reads the charter', remote.result.content[0].text.includes('0.5 ETH per move'), remote.result.content[0].text);

server.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
