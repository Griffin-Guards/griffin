// GRIFFIN app for Robinhood Chain. Bundled by build.mjs into site/app/app.js (IIFE, viem inside).
// Reads the chain straight from the browser; asks Griffin's API only for what it keeps (charter lists, verdicts).
// Every owner action is an ordinary Safe transaction the owner sends (threshold 1, signature "approved by sender").
import {
  createPublicClient, createWalletClient, custom, http, encodeFunctionData, decodeEventLog, parseEther, parseUnits,
  formatUnits, isAddress, getAddress, zeroAddress, pad,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { chain, SAFE, MODULE_ABI, ERC20_ABI, readCharter, setupCalldata, fmtEth, short } from '../core/griffin-rh.mjs';

const MODULE = '0x991948aCCf7C5d76e21c189136A0B19D7BBC7527';
const FROM_BLOCK = 110748909n;
const pub = createPublicClient({ chain, transport: http() });
const SAFE_ABI = [
  { type: 'function', name: 'execTransaction', stateMutability: 'payable', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isModuleEnabled', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'enableModule', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] },
  { type: 'function', name: 'disableModule', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [] },
  { type: 'function', name: 'getModulesPaginated', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'address[]' }, { type: 'address' }] },
];
const FACTORY_ABI = [
  { type: 'function', name: 'createProxyWithNonce', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bytes' }, { type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'event', name: 'ProxyCreation', inputs: [{ type: 'address', name: 'proxy', indexed: true }, { type: 'address', name: 'singleton' }] },
];
const SENTINEL = '0x0000000000000000000000000000000000000001';

const $ = (q) => document.querySelector(q);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get: () => { try { return JSON.parse(localStorage.getItem('griffin-rh.safes') || '[]'); } catch { return []; } },
  add(a) { try { const l = store.get().filter((x) => x.toLowerCase() !== a.toLowerCase()); l.unshift(a); localStorage.setItem('griffin-rh.safes', JSON.stringify(l.slice(0, 20))); } catch { /* private mode */ } },
};
const S = { account: null, wallet: null, griffin: null, safe: null, view: 'home', busy: '', err: '', note: '' };

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Griffin answered ${r.status}`);
  return j;
}

// ---- wallet ----
async function connect() {
  if (!window.ethereum) throw new Error('No wallet found. Open this page in a browser with MetaMask, Rabby or another EVM wallet.');
  const [a] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] }); }
  catch (e) {
    if (e.code !== 4902) throw e;
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x1237', chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] }] });
  }
  S.account = getAddress(a);
  S.wallet = createWalletClient({ account: S.account, chain, transport: custom(window.ethereum) });
}
async function sendTx(to, data, value = 0n) {
  const hash = await S.wallet.sendTransaction({ to, data, value });
  S.busy = 'Waiting for the transaction…'; draw();
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('The transaction reverted.');
  return r;
}
// a Safe transaction from its only owner: signature type "approved by msg.sender"
const ownerSafeTx = (safe, to, data, value = 0n) => sendTx(safe, encodeFunctionData({
  abi: SAFE_ABI, functionName: 'execTransaction',
  args: [to, value, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, `${pad(S.account, { size: 32 })}${'0'.repeat(64)}01`],
}));

// ---- forms ----
const lines = (t) => String(t || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
function addresses(t, what) {
  return lines(t).map((x) => { if (!isAddress(x)) throw new Error(`${what}: ${x} is not an address`); return getAddress(x); });
}
async function tokenLimits(t) {
  const out = [];
  for (const l of String(t || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
    const [token, perMove, perDay] = l.split(/[\s,]+/);
    if (!isAddress(token || '') || !perMove || !perDay) throw new Error(`Token line "${l}": address, per move, per day`);
    const decimals = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => { throw new Error(`${token} does not answer decimals(): is it a token?`); });
    out.push({ token: getAddress(token), perMove: parseUnits(perMove, decimals), perDay: parseUnits(perDay, decimals) });
  }
  return out;
}
async function readForm() {
  const f = (n) => $(`[name="${n}"]`)?.value?.trim() || '';
  if (!isAddress(f('agent'))) throw new Error('The agent address is missing or wrong.');
  const ethPerMove = parseEther(f('perMove') || '0'), ethPerDay = parseEther(f('perDay') || '0');
  if (ethPerMove > ethPerDay) throw new Error('ETH per move is bigger than ETH per day.');
  return {
    agent: getAddress(f('agent')),
    griffin: $('[name="cosign"]').checked ? S.griffin : zeroAddress,
    ethPerMove, ethPerDay,
    recipients: addresses(f('recipients'), 'Recipients'),
    tokens: await tokenLimits($('[name="tokens"]').value),
    targets: addresses(f('targets'), 'Contracts'),
  };
}
const charterArgs = (c) => [c.agent, c.griffin, c.ethPerMove, c.ethPerDay, c.recipients, c.tokens.map((t) => t.token), c.tokens.map((t) => ({ perMove: t.perMove, perDay: t.perDay })), c.targets];

// ---- actions ----
async function run(label, fn) {
  S.err = ''; S.note = ''; S.busy = label; draw();
  try { await fn(); } catch (e) { S.err = e.shortMessage || e.message || String(e); }
  S.busy = ''; draw();
}
async function create() {
  if (!S.account) await connect();
  const c = await readForm();
  const r = await sendTx(SAFE.factory, encodeFunctionData({
    abi: FACTORY_ABI, functionName: 'createProxyWithNonce',
    args: [SAFE.singletonL2, setupCalldata({ owner: S.account, module: MODULE, ...c }), BigInt(Date.now())],
  }));
  const ev = r.logs.map((l) => { try { return decodeEventLog({ abi: FACTORY_ABI, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === 'ProxyCreation');
  const safe = getAddress(ev.args.proxy);
  store.add(safe);
  await api('/v1/charter', { safe, tx: r.transactionHash }).catch(() => {});
  S.note = `Safe ${short(safe)} is made, the module is on and the charter is written. Fund it next.`;
  await open(safe);
}
async function saveCharter() {
  const c = await readForm();
  const r = await ownerSafeTx(S.safe.address, MODULE, encodeFunctionData({ abi: MODULE_ABI, functionName: 'setCharter', args: charterArgs(c) }));
  await api('/v1/charter', { safe: S.safe.address, tx: r.transactionHash }).catch(() => {});
  S.note = 'New charter written. The old lists no longer count.';
  await open(S.safe.address);
}
async function fund() {
  const v = parseEther($('[name="fund"]').value.trim() || '0');
  if (v <= 0n) throw new Error('How much ETH?');
  await sendTx(S.safe.address, '0x', v);
  S.note = `${fmtEth(v)} ETH sent to the Safe.`;
  await open(S.safe.address);
}
async function withdraw() {
  const v = parseEther($('[name="withdraw"]').value.trim() || '0');
  if (v <= 0n) throw new Error('How much ETH?');
  await ownerSafeTx(S.safe.address, S.account, '0x', v);
  S.note = `${fmtEth(v)} ETH back to your wallet. Your own moves need no one's signature.`;
  await open(S.safe.address);
}
async function setAgent() {
  const a = $('[name="newAgent"]').value.trim();
  if (!isAddress(a)) throw new Error('New agent address?');
  await ownerSafeTx(S.safe.address, MODULE, encodeFunctionData({ abi: MODULE_ABI, functionName: 'setAgent', args: [getAddress(a)] }));
  S.note = 'Agent key swapped. The old key can do nothing now.';
  await open(S.safe.address);
}
async function setGriffin(on) {
  await ownerSafeTx(S.safe.address, MODULE, encodeFunctionData({ abi: MODULE_ABI, functionName: 'setGriffin', args: [on ? S.griffin : zeroAddress] }));
  S.note = on ? 'Griffin co-signs again.' : 'Griffin is out. The on-chain charter alone decides now.';
  await open(S.safe.address);
}
async function setModule(on) {
  if (on) await ownerSafeTx(S.safe.address, S.safe.address, encodeFunctionData({ abi: SAFE_ABI, functionName: 'enableModule', args: [MODULE] }));
  else {
    const [mods] = await pub.readContract({ address: S.safe.address, abi: SAFE_ABI, functionName: 'getModulesPaginated', args: [SENTINEL, 50n] });
    const i = mods.findIndex((m) => m.toLowerCase() === MODULE.toLowerCase());
    const prev = i <= 0 ? SENTINEL : mods[i - 1];
    await ownerSafeTx(S.safe.address, S.safe.address, encodeFunctionData({ abi: SAFE_ABI, functionName: 'disableModule', args: [prev, MODULE] }));
  }
  S.note = on ? 'Module enabled: the agent can move inside the charter.' : 'Module disabled: the agent can move nothing.';
  await open(S.safe.address);
}
function agentKey() {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const blob = new Blob([`${key}\n`], { type: 'text/plain' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `griffin-agent-${address.slice(2, 8)}.key` });
  a.click();
  $('[name="agent"]').value = address;
  S.note = `Agent key saved as ${a.download}. Put it on the agent's machine; it never leaves your browser otherwise.`;
  draw(true);
}
async function open(address) {
  const safe = getAddress(address);
  const known = await api(`/v1/charter/${safe}`).then((r) => r.known).catch(() => null);
  const [charter, balance, owners, threshold, verdicts] = await Promise.all([
    readCharter(pub, MODULE, safe, { known, fromBlock: FROM_BLOCK }),
    pub.getBalance({ address: safe }),
    pub.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getOwners' }).catch(() => []),
    pub.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getThreshold' }).catch(() => 0n),
    api(`/v1/verdicts/${safe}`).then((r) => r.verdicts).catch(() => []),
  ]);
  if (!owners.length) throw new Error('No Safe at that address on Robinhood Chain.');
  const tokens = await Promise.all(charter.tokens.map(async (t) => {
    const [symbol, decimals, bal] = await Promise.all([
      pub.readContract({ address: t.token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => short(t.token)),
      pub.readContract({ address: t.token, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
      pub.readContract({ address: t.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [safe] }).catch(() => 0n),
    ]);
    return { ...t, symbol, decimals, bal };
  }));
  store.add(safe);
  S.safe = { address: safe, charter, balance, owners, threshold, verdicts, tokens };
  S.view = 'safe';
}

// ---- view ----
const ownerOf = () => S.account && S.safe?.owners.some((o) => o.toLowerCase() === S.account.toLowerCase());
const charterForm = (c) => `
  <label>Agent address <input name="agent" value="${esc(c?.agent && c.agent !== zeroAddress ? c.agent : '')}" placeholder="0x… the key your agent signs with" spellcheck="false"></label>
  ${S.safe ? '' : '<button class="ghost" data-do="agentKey" type="button">Make an agent key here</button>'}
  <div class="two"><label>ETH per move <input name="perMove" value="${c ? fmtEth(c.ethPerMove) : '0.05'}"></label><label>ETH per day <input name="perDay" value="${c ? fmtEth(c.ethPerDay) : '0.2'}"></label></div>
  <label>Recipients <span>one address per line; ETH and token transfers only reach these</span><textarea name="recipients" rows="3" spellcheck="false">${esc((c?.recipients || []).join('\n'))}</textarea></label>
  <label>Tokens <span>one per line: token address, per move, per day (whole tokens)</span><textarea name="tokens" rows="3" spellcheck="false">${esc((S.safe?.tokens || []).map((t) => `${t.token} ${formatUnits(t.perMove, t.decimals)} ${formatUnits(t.perDay, t.decimals)}`).join('\n'))}</textarea></label>
  <label>Contracts <span>the agent may call these and approve them to spend listed tokens (a DEX router, for example)</span><textarea name="targets" rows="2" spellcheck="false">${esc((c?.targets || []).join('\n'))}</textarea></label>
  <label class="check"><input type="checkbox" name="cosign" ${!c || c.griffin !== zeroAddress ? 'checked' : ''}> Griffin simulates and co-signs every move</label>`;

function homeView() {
  const saved = store.get();
  return `<div class="card"><h2>Make an agent Safe</h2>
    <p class="muted">One transaction makes a Safe with you as its only owner, enables GriffinModule and writes the charter. Gas only.</p>
    ${charterForm(null)}
    <button class="gold" data-do="create">${S.account ? 'Make the Safe' : 'Connect wallet & make the Safe'}</button></div>
    <div class="card"><h2>Open a Safe</h2>
    <div class="row"><input name="openAddr" placeholder="0x… Safe address" spellcheck="false"><button data-do="open">Open</button></div>
    ${saved.length ? `<ul class="saved">${saved.map((a) => `<li><a href="#${a}">${a}</a></li>`).join('')}</ul>` : ''}</div>`;
}
function safeView() {
  const s = S.safe, c = s.charter, own = ownerOf();
  const status = !c.enabled ? '<b class="no">module off</b>' : c.version === 0n ? '<b class="no">no charter</b>' : c.griffin === zeroAddress ? '<b>charter only, no co-signer</b>' : '<b class="ok">guarded</b>';
  return `<div class="card"><div class="between"><h2>Safe ${short(s.address)}</h2>${status}</div>
    <dl class="facts">
      <dt>Address</dt><dd class="mono"><a href="https://robinhoodchain.blockscout.com/address/${s.address}" target="_blank" rel="noopener">${s.address}</a></dd>
      <dt>Balance</dt><dd>${fmtEth(s.balance)} ETH${s.tokens.map((t) => ` · ${formatUnits(t.bal, t.decimals)} ${esc(t.symbol)}`).join('')}</dd>
      <dt>Owners</dt><dd class="mono">${s.owners.map(short).join(', ')} · ${s.threshold} to sign</dd>
      <dt>Agent</dt><dd class="mono">${c.agent === zeroAddress ? '—' : c.agent}</dd>
      <dt>Co-signer</dt><dd class="mono">${c.griffin === zeroAddress ? 'none' : c.griffin}${S.griffin && c.griffin.toLowerCase() === S.griffin.toLowerCase() ? ' (Griffin)' : ''}</dd>
      <dt>ETH</dt><dd>${fmtEth(c.ethPerMove)} per move · ${fmtEth(c.ethPerDay)} per day · ${fmtEth(c.spentEth)} spent today</dd>
      <dt>Recipients</dt><dd class="mono">${c.listsKnown ? (c.recipients.map(short).join(', ') || 'none') : 'unknown to this browser'}</dd>
      <dt>Tokens</dt><dd>${s.tokens.map((t) => `${esc(t.symbol)} ${formatUnits(t.perMove, t.decimals)} / ${formatUnits(t.perDay, t.decimals)}, ${formatUnits(t.spent, t.decimals)} today`).join(' · ') || 'none'}</dd>
      <dt>Contracts</dt><dd class="mono">${c.targets.map(short).join(', ') || 'none'}</dd>
    </dl></div>
    <div class="card"><h2>Fund</h2><div class="row"><input name="fund" placeholder="ETH"><button data-do="fund">Send to the Safe</button></div></div>
    ${own ? `<div class="card"><h2>Your moves</h2><p class="muted">You are the owner: these are plain Safe transactions, no Griffin, no limits.</p>
      <div class="row"><input name="withdraw" placeholder="ETH"><button data-do="withdraw">Withdraw to my wallet</button></div>
      <div class="row"><input name="newAgent" placeholder="0x… new agent key" spellcheck="false"><button data-do="setAgent">Swap the agent</button></div>
      <div class="row">${c.griffin === zeroAddress ? '<button data-do="griffinOn">Bring Griffin back</button>' : '<button data-do="griffinOff">Remove Griffin</button>'}
      ${c.enabled ? '<button class="danger" data-do="moduleOff">Disable the module</button>' : '<button data-do="moduleOn">Enable the module</button>'}</div></div>
    <div class="card"><h2>Charter</h2><p class="muted">Writing a new charter replaces the whole one.</p>${charterForm(c)}<button class="gold" data-do="saveCharter">Write the charter</button></div>`
    : `<div class="card"><p class="muted">${S.account ? 'This wallet is not an owner of the Safe.' : 'Connect the owner wallet to change anything.'}</p>${S.account ? '' : '<button data-do="connect">Connect wallet</button>'}</div>`}
    <div class="card"><h2>Verdicts</h2>${s.verdicts.length ? `<table class="ledger">${s.verdicts.map((v) => `<tr><td>#${v.nonce}</td><td class="${v.verdict === 'passed' ? 'ok' : 'no'}">${v.verdict === 'passed' ? 'SIGNED' : 'REFUSED'}</td><td>${v.value !== '0' ? `${fmtEth(v.value)} ETH → ` : ''}${short(v.to)}</td><td>${esc(v.reasons[0] || '')}</td></tr>`).join('')}</table>` : '<p class="muted">No moves asked yet.</p>'}</div>
    <button class="ghost" data-do="home">← All Safes</button>`;
}
function draw(keepForm) {
  if (keepForm) { $('.msg').innerHTML = msgs(); return; }
  $('#who').innerHTML = S.account ? `<span class="mono">${short(S.account)}</span>` : '<button data-do="connect">Connect wallet</button>';
  $('#main').innerHTML = `<div class="msg">${msgs()}</div>${S.view === 'safe' && S.safe ? safeView() : homeView()}`;
}
const msgs = () => `${S.busy ? `<div class="busy">${esc(S.busy)}</div>` : ''}${S.err ? `<div class="err">${esc(S.err)}</div>` : ''}${S.note ? `<div class="note">${esc(S.note)}</div>` : ''}`;

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-do]');
  if (!b || S.busy) return;
  const d = b.dataset.do;
  if (d === 'agentKey') return agentKey();
  if (d === 'home') { S.view = 'home'; S.safe = null; history.replaceState(null, '', '#'); return draw(); }
  const acts = {
    connect: ['Connecting…', connect], create: ['Making the Safe…', create], saveCharter: ['Writing the charter…', saveCharter],
    fund: ['Sending…', fund], withdraw: ['Withdrawing…', withdraw], setAgent: ['Swapping the agent…', setAgent],
    griffinOn: ['Updating…', () => setGriffin(true)], griffinOff: ['Removing Griffin…', () => setGriffin(false)],
    moduleOn: ['Enabling…', () => setModule(true)], moduleOff: ['Disabling…', () => setModule(false)],
    open: ['Reading the Safe…', async () => { const a = $('[name="openAddr"]').value.trim(); if (!isAddress(a)) throw new Error('That is not an address.'); await open(a); history.replaceState(null, '', `#${getAddress(a)}`); }],
  };
  if (d === 'moduleOff' && !confirm('Disable GriffinModule on this Safe? The agent will not be able to move anything until you enable it again.')) return;
  if (acts[d]) run(...acts[d]);
});
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (isAddress(h)) run('Reading the Safe…', () => open(h)); });

api('/v1/griffin').then((g) => { S.griffin = getAddress(g.griffin); }).catch(() => { S.err = 'Griffin\'s API did not answer; co-signing is unavailable right now.'; draw(); });
draw();
const h = location.hash.slice(1);
if (isAddress(h)) run('Reading the Safe…', () => open(h));
