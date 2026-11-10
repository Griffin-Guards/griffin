// GRIFFIN app: create a guarded agent wallet, sign its policy, fund it, take funds out, swap the agent key, dismiss Griffin.
import {
  Connection, Keypair, PublicKey, SystemProgram, bs58, buildCreate, buildDismiss, buildPropose, buildSwapAgent,
  compile, fmtSol, solToLamports, normalizePolicy, policyMessage, readWallet, vaultOf, multisig,
} from '../core/griffin.mjs';

const STORE = 'griffin.wallets';
const connection = new Connection(`${location.origin}/rpc`, { commitment: 'confirmed', disableRetryOnRateLimit: true });
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (k) => `${String(k).slice(0, 4)}…${String(k).slice(-4)}`;
const state = { me: null, griffin: null, open: null, view: null, busy: '', error: '', note: '' };

const getProvider = () => window.phantom?.solana ?? window.solflare ?? window.solana ?? null;
const saved = () => { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; } };
const remember = (a) => { try { localStorage.setItem(STORE, JSON.stringify([a, ...saved().filter((x) => x !== a)].slice(0, 8))); } catch { /* the address still works by hand */ } };
const parseKey = (t, label) => { try { return new PublicKey(String(t).trim()); } catch { throw new Error(`${label} isn't a Solana address`); } };
const lines = (t) => String(t || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Griffin answered ${r.status}`);
  return data;
}

async function confirm(signature) {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    const { value } = await connection.getSignatureStatuses([signature]);
    if (value[0]?.err) throw new Error('The chain refused this transaction');
    if (['confirmed', 'finalized'].includes(value[0]?.confirmationStatus)) return signature;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Not confirmed yet. Check ${short(signature)} on an explorer before trying again`);
}

async function send(ixs, extra, tables = []) {
  const provider = getProvider();
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = compile(new PublicKey(state.me), blockhash, ixs, tables);
  if (extra) {
    // The wallet signs first: it may add instructions, which would void an earlier signature.
    const signed = await provider.signTransaction(tx);
    signed.sign([extra]);
    return confirm(await connection.sendRawTransaction(signed.serialize()));
  }
  const { signature } = await provider.signAndSendTransaction(tx);
  return confirm(signature);
}

async function run(label, fn) {
  state.busy = label; state.error = ''; state.note = ''; render();
  try { await fn(); } catch (e) {
    const t = e?.message || '';
    state.error = /reject|cancel/i.test(t) ? 'Cancelled in the wallet' : /insufficient/i.test(t) ? 'Not enough SOL in the connected wallet' : t || 'Something failed';
  }
  state.busy = ''; render();
}

async function connect() {
  const provider = getProvider();
  if (!provider) { state.error = 'No Solana wallet found. Install Phantom or Solflare.'; return render(); }
  const res = await provider.connect();
  state.me = (res?.publicKey ?? provider.publicKey).toString();
  render();
}

async function openWallet(address) {
  const ms = parseKey(address, 'The wallet');
  state.open = ms.toBase58();
  state.view = await api(`/v1/wallet/${state.open}`);
  state.view.lamports = await connection.getBalance(vaultOf(ms));
  remember(state.open);
  history.replaceState(null, '', `#${state.open}`);
}

async function create() {
  const agentText = $('agent').value.trim();
  if (!agentText) throw new Error('Paste the agent public key, or make one here');
  const agent = parseKey(agentText, 'The agent key');
  if (agent.toBase58() === state.me) throw new Error('The agent key must not be your own wallet');
  const c = await buildCreate({ connection, owner: state.me, agent, griffin: state.griffin });
  await send(c.ixs, c.createKey);
  await openWallet(c.multisigPda.toBase58());
  state.note = 'Wallet created. Sign a policy next: until then Griffin turns back every agent move.';
}

function makeAgent() {
  const kp = Keypair.generate();
  const blob = new Blob([JSON.stringify(Array.from(kp.secretKey))], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `griffin-agent-${kp.publicKey.toBase58().slice(0, 6)}.json`;
  a.click();
  $('agent').value = kp.publicKey.toBase58();
  state.note = 'Agent key saved as a file. Move it to the agent machine and keep no other copy. This page forgets it.';
  render();
}

async function decimalsOf(mint) {
  const info = await connection.getAccountInfo(new PublicKey(mint));
  if (!info || info.data.length < 45) throw new Error(`${short(mint)} is not a token mint`);
  return info.data[44];
}
const toUnits = (text, d) => {
  const [w, p = ''] = String(text).trim().split('.');
  if (!/^\d+$/.test(w) || !/^\d*$/.test(p) || p.length > d) throw new Error(`Bad amount ${text}`);
  return (BigInt(w) * 10n ** BigInt(d) + BigInt(p.padEnd(d, '0') || 0)).toString();
};

async function signPolicy() {
  const tokens = {};
  for (const row of String($('p-tokens').value).split('\n').map((r) => r.trim()).filter(Boolean)) {
    const [mint, perTx, perDay] = row.split(/[\s,]+/);
    if (!perDay) throw new Error('Token lines are: mint perMove perDay');
    const d = await decimalsOf(parseKey(mint, 'A token mint').toBase58());
    tokens[mint] = { perTx: toUnits(perTx, d), perDay: toUnits(perDay, d) };
  }
  const policy = normalizePolicy({
    solPerTx: solToLamports($('p-tx').value || '0').toString(),
    solPerDay: solToLamports($('p-day').value || '0').toString(),
    recipients: lines($('p-to').value), programs: lines($('p-prog').value), buyOnly: lines($('p-buy').value), tokens,
  });
  const nonce = String(Date.now());
  const { signature } = await getProvider().signMessage(new TextEncoder().encode(policyMessage(state.open, policy, nonce)), 'utf8');
  await api('/v1/policy', { multisig: state.open, policy, nonce, signature: bs58.encode(signature) });
  await openWallet(state.open);
  state.note = 'Policy signed and live.';
}

async function fund() {
  const lamports = solToLamports($('f-amt').value);
  await send([SystemProgram.transfer({ fromPubkey: new PublicKey(state.me), toPubkey: vaultOf(state.open), lamports })]);
  await openWallet(state.open);
  state.note = `Sent ${fmtSol(lamports)} SOL to the vault.`;
}

// Owner moves still need two votes: the owner proposes, Griffin votes (always yes for the owner), the owner executes.
async function withdraw() {
  const to = parseKey($('w-to').value || state.me, 'The destination');
  const lamports = solToLamports($('w-amt').value);
  const ms = new PublicKey(state.open);
  const { index, ixs } = await buildPropose({ connection, multisigPda: ms, member: new PublicKey(state.me), ixs: [SystemProgram.transfer({ fromPubkey: vaultOf(ms), toPubkey: to, lamports })], memo: 'GRIFFIN owner withdrawal' });
  await send(ixs);
  const v = await api('/v1/guard', { multisig: state.open, index: Number(index), submit: true });
  if (v.verdict !== 'passed') throw new Error(`Griffin turned it back: ${v.reasons.join('; ')}`);
  await confirm(v.voteSignature);
  const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({ connection, multisigPda: ms, transactionIndex: index, member: new PublicKey(state.me) });
  await send([instruction, multisig.instructions.vaultTransactionAccountsClose({ multisigPda: ms, transactionIndex: index, rentCollector: vaultOf(ms) })], null, lookupTableAccounts);
  await openWallet(state.open);
  state.note = `${fmtSol(lamports)} SOL sent to ${short(to)}.`;
}

async function swapAgent() {
  const next = parseKey($('s-new').value, 'The new agent key');
  const old = state.view.members.find((m) => m.role === 'full' && m.key !== state.view.configAuthority);
  if (!old) throw new Error('No agent key on this wallet');
  await send(buildSwapAgent({ multisigPda: state.open, owner: state.me, oldAgent: old.key, newAgent: next }));
  await openWallet(state.open);
  state.note = `Agent key is now ${short(next)}. Open moves from the old key are void.`;
}

async function dismiss() {
  if (!window.confirm('Remove Griffin and drop the wallet to 1 vote? Your agent key could then move funds alone. Do this only to take your funds out.')) return;
  await send(buildDismiss({ multisigPda: state.open, owner: state.me, griffin: state.griffin }));
  await openWallet(state.open);
  state.note = 'Griffin is off this wallet. Move your funds out with the Squads app or the agent key before you hand the agent this wallet again.';
}

function verdictRows(list) {
  if (!list.length) return '<p class="muted">No moves judged yet.</p>';
  return `<table class="verdicts"><tbody>${list.map((v) => `<tr class="${v.verdict === 'passed' ? 'ok' : 'no'}"><td class="mono">#${v.index}</td><td><b>${v.verdict.toUpperCase()}</b><div class="muted">${esc(v.reasons.join(' · '))}</div></td><td class="mono">${v.solOut !== '0' ? `${fmtSol(v.solOut)} SOL` : ''}</td><td class="mono muted">${new Date(v.at).toLocaleString()}</td></tr>`).join('')}</tbody></table>`;
}

function walletPanel() {
  const v = state.view;
  const isOwner = state.me && v.configAuthority === state.me;
  const p = v.policy?.policy;
  const role = (m) => (m.key === v.griffin ? 'Griffin' : m.key === v.configAuthority ? 'Owner' : m.role === 'full' ? 'Agent' : m.role);
  const fmtTok = (t) => Object.entries(t || {}).map(([m, l]) => `${m} ${l.perTx} ${l.perDay}`).join('\n');
  return `
  <div class="card">
    <div class="row between"><h2>Wallet ${short(v.multisig)}</h2><button data-act="refresh" class="ghost">Refresh</button></div>
    ${v.problem ? `<p class="warn">Not guarded: ${esc(v.problem)}</p>` : '<p class="okline">Guarded by Griffin · 2 votes needed · no wait</p>'}
    <dl class="facts">
      <dt>Squads wallet</dt><dd class="mono">${v.multisig}</dd>
      <dt>Vault (send funds here)</dt><dd class="mono">${v.vault}</dd>
      <dt>Vault balance</dt><dd>${fmtSol(v.lamports)} SOL</dd>
      <dt>Spent in 24h</dt><dd>${fmtSol(v.spent24h || 0)} SOL</dd>
      ${v.members.map((m) => `<dt>${role(m)}</dt><dd class="mono">${m.key}</dd>`).join('')}
    </dl>
  </div>
  <div class="card">
    <h2>Policy ${v.policy ? `<span class="mono muted small">${v.policy.hash.slice(0, 12)}</span>` : ''}</h2>
    ${p ? '' : '<p class="warn">No policy yet. Every agent move is turned back.</p>'}
    ${isOwner ? `
    <div class="grid2">
      <label>SOL per move<input id="p-tx" value="${p ? fmtSol(p.solPerTx) : '0.1'}"></label>
      <label>SOL per 24h<input id="p-day" value="${p ? fmtSol(p.solPerDay) : '0.5'}"></label>
    </div>
    <label>Recipients the agent may pay (one per line)<textarea id="p-to" rows="3">${esc((p?.recipients || []).join('\n'))}</textarea></label>
    <label>Extra programs, by address (System, token, ATA, memo, Jupiter are in already)<textarea id="p-prog" rows="2">${esc((p?.programs || []).join('\n'))}</textarea></label>
    <label>Buy list: only these tokens may come in (empty = any)<textarea id="p-buy" rows="2">${esc((p?.buyOnly || []).join('\n'))}</textarea></label>
    <label>Token limits: <span class="mono">mint perMove perDay</span> in whole tokens, one per line<textarea id="p-tokens" rows="2" placeholder="EPjFWdd5AufqSSqeM2qq1xzybapC8G4wGGkEZwyTDt1v 20 50"></textarea></label>
    ${p && Object.keys(p.tokens).length ? `<p class="muted small">Current token limits in base units:<br><span class="mono">${esc(fmtTok(p.tokens)).replace(/\n/g, '<br>')}</span><br>Signing a new policy replaces them, so list them again.</p>` : ''}
    <button data-act="policy" class="gold">Sign policy</button>` : `<pre class="policy">${esc(JSON.stringify(p, null, 2))}</pre><p class="muted">Connect the owner wallet to change it.</p>`}
  </div>
  ${isOwner ? `
  <div class="card">
    <h2>Funds</h2>
    <div class="grid2">
      <div><label>Add SOL to the vault<input id="f-amt" placeholder="0.5"></label><button data-act="fund">Send to vault</button></div>
      <div><label>Take SOL out<input id="w-amt" placeholder="0.5"></label><label>To (empty = you)<input id="w-to" placeholder="${state.me}"></label><button data-act="withdraw">Withdraw</button></div>
    </div>
    <p class="muted small">A withdrawal takes two wallet popups: propose, then execute after Griffin's vote. About 0.004 SOL rent goes back to the vault.</p>
  </div>
  <div class="card">
    <h2>Keys</h2>
    <label>Swap the agent key (one popup, no vote)<input id="s-new" placeholder="new agent public key"></label>
    <button data-act="swap">Swap agent key</button>
    <hr>
    <p class="muted small">If Griffin is ever down, you can remove it and drop the wallet to one vote. Only for taking your funds out.</p>
    <button data-act="dismiss" class="danger">Dismiss Griffin</button>
  </div>` : ''}
  <div class="card"><h2>Verdicts</h2>${verdictRows(v.verdicts)}</div>`;
}

function render() {
  const s = saved();
  $('root').innerHTML = `
  <aside>
    <div class="who">${state.me ? `<span class="mono">${short(state.me)}</span>` : '<button data-act="connect" class="gold">Connect wallet</button>'}</div>
    <button data-act="new" class="side ${state.open ? '' : 'on'}">+ New guarded wallet</button>
    <div class="ring">${s.map((a) => `<button data-open="${a}" class="side ${state.open === a ? 'on' : ''} mono">${short(a)}</button>`).join('')}</div>
    <label class="small">Open by address<input id="open-addr" placeholder="Squads wallet"></label>
    <button data-act="open">Open</button>
  </aside>
  <main>
    ${state.busy ? `<div class="busy">${esc(state.busy)}…</div>` : ''}
    ${state.error ? `<div class="err">${esc(state.error)}</div>` : ''}
    ${state.note ? `<div class="note">${esc(state.note)}</div>` : ''}
    ${state.open && state.view ? walletPanel() : `
    <div class="card">
      <h2>New guarded wallet</h2>
      <p class="muted">You become the owner. The agent gets one vote, Griffin gets one, and every move needs two. Costs about 0.003 SOL in rent plus a small Squads fee if any.</p>
      <label>Agent public key<input id="agent" placeholder="the key your bot signs with"></label>
      <div class="row"><button data-act="make" class="ghost">Make an agent key here</button><button data-act="create" class="gold" ${state.me ? '' : 'disabled'}>Create wallet</button></div>
      <p class="muted small">Griffin key: <span class="mono">${state.griffin || '…'}</span></p>
    </div>`}
  </main>`;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const act = b.dataset.act;
  if (b.dataset.open) return run('Opening', () => openWallet(b.dataset.open));
  if (act === 'connect') return run('Connecting', connect);
  if (act === 'new') { state.open = null; state.view = null; history.replaceState(null, '', location.pathname); return render(); }
  if (act === 'open') return run('Opening', () => openWallet($('open-addr').value));
  if (act === 'refresh') return run('Reading', () => openWallet(state.open));
  if (act === 'make') return makeAgent();
  const needMe = (fn) => async () => { if (!state.me) await connect(); return fn(); };
  if (act === 'create') return run('Creating the wallet', needMe(create));
  if (act === 'policy') return run('Signing the policy', needMe(signPolicy));
  if (act === 'fund') return run('Funding', needMe(fund));
  if (act === 'withdraw') return run('Withdrawing', needMe(withdraw));
  if (act === 'swap') return run('Swapping the agent key', needMe(swapAgent));
  if (act === 'dismiss') return run('Dismissing Griffin', needMe(dismiss));
});

(async () => {
  render();
  try { state.griffin = (await api('/v1/griffin')).griffin; } catch { state.error = 'Griffin is not answering right now'; }
  const provider = getProvider();
  try { const r = await provider?.connect({ onlyIfTrusted: true }); if (r?.publicKey) state.me = r.publicKey.toString(); } catch { /* not trusted yet */ }
  const hash = location.hash.slice(1);
  if (hash) await run('Opening', () => openWallet(hash));
  else render();
})();

void readWallet;
