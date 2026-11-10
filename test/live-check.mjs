// Mainnet run with throwaway keys from .live-keys.json against a Griffin API (default the local dev server).
// node live-check.mjs            full run: create, policy, moves, dismiss, sweep back to the funder
// node live-check.mjs sweep      only the way out: dismiss Griffin and send everything back
import fs from 'node:fs';
import {
  Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction, bs58, buildCreate, buildDismiss, compile,
  normalizePolicy, policyMessage, readWallet, vaultOf, fmtSol, multisig, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, TOKEN_PROGRAM_ID,
} from '../core/griffin.mjs';
import { act, sendSol, swap } from '../agent/griffin-agent.mjs';
import { ed25519 } from '../core/griffin.mjs';

const USDC = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
const API = process.env.GRIFFIN_API || 'http://localhost:8799';
const connection = new Connection(process.env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const K = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(new URL('./.live-keys.json', import.meta.url)))).map(([n, s]) => [n, Keypair.fromSecretKey(bs58.decode(s))]));
const STATE = new URL('./.live-state.json', import.meta.url);
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
const sol = (n) => BigInt(Math.round(n * 1e9));
const log = (...a) => console.log(...a);
const results = [];
const expect = (name, got, want) => { const ok = got === want; results.push([ok, name, got]); log(ok ? 'PASS' : 'FAIL', name, '->', got); };

async function send(ixs, payer, signers, tables = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = compile(payer.publicKey, blockhash, ixs, tables);
  tx.sign(signers);
  const sig = await connection.sendRawTransaction(tx.serialize());
  const r = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (r.value.err) throw new Error(`${sig} failed ${JSON.stringify(r.value.err)}`);
  return sig;
}
const transfer = (from, to, lamports) => send([SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })], from, [from]);
const cfgFor = (member) => ({ agent: member, multisig: new PublicKey(state.multisig), api: API, connection });

async function post(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

async function setup(budget = { owner: 0.006, agent: 0.026, vault: 0.007 }) {
  const balance = await connection.getBalance(K.funder.publicKey);
  log('funder', K.funder.publicKey.toBase58(), fmtSol(balance), 'SOL');
  const need = budget.owner + budget.agent + budget.vault + 0.001;
  if (balance < sol(need)) throw new Error(`Fund the funder with at least ${need} SOL`);
  await transfer(K.funder, K.owner.publicKey, Number(sol(budget.owner)));
  await transfer(K.funder, K.agent.publicKey, Number(sol(budget.agent)));
  const griffin = (await (await fetch(`${API}/v1/griffin`)).json()).griffin;
  if (griffin !== K.griffin.publicKey.toBase58()) throw new Error('The API runs another Griffin key');
  const c = await buildCreate({ connection, owner: K.owner.publicKey, agent: K.agent.publicKey, griffin });
  log('create', await send(c.ixs, K.owner, [K.owner, c.createKey]));
  state.multisig = c.multisigPda.toBase58();
  state.vault = c.vault.toBase58();
  save();
  await transfer(K.funder, c.vault, Number(sol(budget.vault)));
  log('wallet', state.multisig, 'vault', state.vault);
}

async function policy() {
  const p = normalizePolicy({ solPerTx: sol(0.004).toString(), solPerDay: sol(0.006).toString(), recipients: [K.friend.publicKey.toBase58()] });
  const nonce = String(Date.now());
  const msg = policyMessage(state.multisig, p, nonce);
  const sign = (kp) => bs58.encode(ed25519.sign(new TextEncoder().encode(msg), kp.secretKey.slice(0, 32)));
  const forged = await post('/v1/policy', { multisig: state.multisig, policy: p, nonce, signature: sign(K.agent) });
  expect('agent cannot set the policy', forged.status, 401);
  const r = await post('/v1/policy', { multisig: state.multisig, policy: p, nonce, signature: sign(K.owner) });
  expect('owner sets the policy', r.status, 201);
}

async function moves() {
  const agent = cfgFor(K.agent);
  const friend = K.friend.publicKey.toBase58();
  const resume = mode === 'resume'; // second pass on the same wallet: skip the moves that already ran
  if (!resume) {
    const a = await sendSol(agent, friend, '0.002');
    expect('0.002 SOL to the listed friend', a.verdict, 'passed');
    log('  executed', a.executed);
  }
  const f = await swap(agent, 'So11111111111111111111111111111111111111112', USDC.toBase58(), 1000000, 300).catch((e) => ({ verdict: `error: ${e.message}` }));
  expect('swap 0.001 SOL to USDT', f.verdict, 'passed');
  log('  ', f.reasons || '', f.executed || '');
  if (!resume) {
    const b = await sendSol(agent, K.stranger.publicKey.toBase58(), '0.002');
    expect('0.002 SOL to a stranger', b.verdict, 'turned back');
    log('  ', b.reasons);
    const c = await sendSol(agent, friend, '0.005');
    expect('0.005 SOL over the per move limit', c.verdict, 'turned back');
    log('  ', c.reasons);
  }
  if (f.verdict !== 'passed') log('SKIP daily limit check: it counts on the swap having passed');
  else {
  const e = await sendSol(agent, friend, '0.004');
  expect('0.004 SOL over the daily limit', e.verdict, 'turned back');
  log('  ', e.reasons);
  }
  const vault = vaultOf(state.multisig);
  const usdcAta = getAssociatedTokenAddressSync(USDC, vault, true);
  const data = Buffer.alloc(9); data[0] = 4; data.writeBigUInt64LE(1000000n, 1);
  const approve = { programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: usdcAta, isSigner: false, isWritable: true }, { pubkey: K.stranger.publicKey, isSigner: false, isWritable: false }, { pubkey: vault, isSigner: true, isWritable: false }], data };
  const g = await act(agent, [approve], [], 'approve test');
  expect('approve a stranger to spend USDT', g.verdict, 'turned back');
  log('  ', g.reasons);
  const o = await act(cfgFor(K.owner), [SystemProgram.transfer({ fromPubkey: vault, toPubkey: K.owner.publicKey, lamports: Number(sol(0.008)) })], [], 'owner move');
  expect('owner takes 0.008 SOL, no policy check', o.verdict, 'passed');
}

// The way out: owner drops Griffin, closes spent moves, pulls USDC and SOL back to the funder.
async function sweep() {
  const ms = new PublicKey(state.multisig);
  const vault = vaultOf(ms);
  let w = await readWallet(connection, ms);
  if (w.threshold !== 1) {
    log('dismiss', await send(buildDismiss({ multisigPda: ms, owner: K.owner.publicKey, griffin: K.griffin.publicKey }), K.owner, [K.owner]));
    w = await readWallet(connection, ms);
    expect('owner alone can dismiss Griffin', `${w.threshold}/${w.members.length}`, '1/2');
  }
  const close = [];
  for (let i = 1; i <= w.last; i++) {
    const [tx] = multisig.getTransactionPda({ multisigPda: ms, index: BigInt(i) });
    if (await connection.getAccountInfo(tx)) close.push(multisig.instructions.vaultTransactionAccountsClose({ multisigPda: ms, transactionIndex: BigInt(i), rentCollector: vault }));
  }
  for (const ix of close) await send([ix], K.owner, [K.owner]).then((s) => log('closed', s)).catch((e) => log('close skipped', e.message.slice(0, 80)));
  const usdcAta = getAssociatedTokenAddressSync(USDC, vault, true);
  const usdc = await connection.getTokenAccountBalance(usdcAta).catch(() => null);
  const owner = cfgFor(K.owner);
  const ownerAct = (ixs, memo) => ownerMove(ms, ixs, memo);
  if (usdc) {
    const dst = getAssociatedTokenAddressSync(USDC, K.funder.publicKey);
    const ixs = [createAssociatedTokenAccountIdempotentInstruction(vault, dst, K.funder.publicKey, USDC)];
    if (usdc.value.amount !== '0') ixs.push(createTransferCheckedInstruction(usdcAta, USDC, dst, vault, BigInt(usdc.value.amount), 6));
    ixs.push({ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: usdcAta, isSigner: false, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: true }, { pubkey: vault, isSigner: true, isWritable: false }], data: Buffer.from([9]) });
    log('usdc out', await ownerAct(ixs, 'sweep usdc'));
  }
  const left = await connection.getBalance(vault);
  if (left > 0) log('sol out', fmtSol(left), await ownerAct([SystemProgram.transfer({ fromPubkey: vault, toPubkey: K.funder.publicKey, lamports: left })], 'sweep sol'));
  for (const k of [K.agent, K.owner, K.friend]) {
    const b = await connection.getBalance(k.publicKey);
    if (b > 35000) await transfer(k, K.funder.publicKey, b - 35000).catch((e) => log('sweep', k.publicKey.toBase58().slice(0, 6), e.message.slice(0, 60)));
  }
  log('funder now', fmtSol(await connection.getBalance(K.funder.publicKey)), 'SOL');
  void owner;
}

// With threshold 1 the owner proposes, votes and executes in one go.
async function ownerMove(ms, ixs, memo) {
  const { buildPropose } = await import('../core/griffin.mjs');
  const { index, ixs: p } = await buildPropose({ connection, multisigPda: ms, member: K.owner.publicKey, ixs, memo });
  await send(p, K.owner, [K.owner]);
  const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({ connection, multisigPda: ms, transactionIndex: index, member: K.owner.publicKey });
  return send([instruction], K.owner, [K.owner], lookupTableAccounts);
}

const mode = process.argv[2];
try {
  if (mode === 'swap') {
    // fresh wallet, only the Jupiter swap, then the way out
    for (const k of Object.keys(state)) delete state[k];
    await setup({ owner: 0.014, agent: 0.009, vault: 0.007 });
    await policy();
    const f = await swap(cfgFor(K.agent), 'So11111111111111111111111111111111111111112', USDC.toBase58(), 1000000, 300).catch((e) => ({ verdict: `error: ${e.message}` }));
    expect('swap 0.001 SOL to USDT', f.verdict, 'passed');
    log('  ', f.reasons || '', f.executed || '', f.excluded || '');
  } else if (mode !== 'sweep') {
    if (!state.multisig) await setup();
    await policy();
    await moves();
  }
  await sweep();
} catch (e) {
  console.error('STOPPED', e.message);
  process.exitCode = 1;
}
log(`\n${results.filter((r) => r[0]).length}/${results.length} checks passed`);
void VersionedTransaction;
