// Offline checks of the policy engine. node test.mjs
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  normalizePolicy, policyHash, policyMessage, judge, balanceDelta, parseTokenAccount, resolveKeys,
  guardable, solToLamports, fmtSol, WSOL, JUPITER,
} from './griffin.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok', name); };
const pk = () => Keypair.generate().publicKey.toBase58();
const vault = pk(), owner = pk(), agent = pk(), friend = pk(), stranger = pk(), mint = pk();
const SYSTEM = SystemProgram.programId.toBase58();
const TOKEN = TOKEN_PROGRAM_ID.toBase58();

const le = (n, bytes) => { const b = new Uint8Array(bytes); let v = BigInt(n); for (let i = 0; i < bytes; i++) { b[i] = Number(v & 255n); v >>= 8n; } return b; };
const solIx = (from, to, lamports) => ({ program: SYSTEM, accounts: [from, to], data: Uint8Array.from([...le(2, 4), ...le(lamports, 8)]) });
const tokenIx = (kind, accounts, amount) => ({ program: TOKEN, accounts, data: Uint8Array.from([kind, ...le(amount, 8), 6]) });
const move = (instructions, creator = agent) => ({ vault, creator, ephemeral: 0, instructions });
const tokenData = ({ mint: m, owner: o, amount, delegate = null }) => {
  const d = new Uint8Array(165);
  d.set(new PublicKey(m).toBytes(), 0);
  d.set(new PublicKey(o).toBytes(), 32);
  d.set(le(amount, 8), 64);
  if (delegate) { d.set(le(1, 4), 72); d.set(new PublicKey(delegate).toBytes(), 76); }
  d[108] = 1;
  return d;
};
const policy = normalizePolicy({ solPerTx: '500000000', solPerDay: '1000000000', recipients: [friend], tokens: { [mint]: { perTx: '100', perDay: '150' } } });
const noDelta = (sol = 0n, tokens = {}) => ({ sol, tokens, owners: {}, problems: [] });

t('policy normalizes and hashes the same either way', () => {
  const a = normalizePolicy({ recipients: [friend, friend], solPerTx: 5 });
  assert.deepEqual(a.recipients, [friend]);
  assert.equal(a.solPerTx, '5');
  assert.equal(policyHash({ solPerTx: 5, recipients: [friend] }), policyHash({ recipients: [friend], solPerTx: '5' }));
  assert.throws(() => normalizePolicy({ recipients: ['nope'] }));
  assert.match(policyMessage(vault, a, 'n1'), /^GRIFFIN policy\nwallet: /);
});

t('owner moves always pass', () => {
  const r = judge({ move: move([solIx(vault, stranger, 9e9)], owner), policy, delta: noDelta(-9000000000n), owner });
  assert.equal(r.verdict, 'passed');
});

t('a small payment to a listed friend passes', () => {
  const r = judge({ move: move([solIx(vault, friend, 100000000)]), policy, delta: noDelta(-100000000n), owner });
  assert.equal(r.verdict, 'passed', r.reasons.join('; '));
  assert.equal(r.out.sol, 100000000n);
});

t('SOL to a stranger is turned back', () => {
  const r = judge({ move: move([solIx(vault, stranger, 100000000)]), policy, delta: noDelta(-100000000n), owner });
  assert.equal(r.verdict, 'turned back');
  assert.ok(r.reasons.some((x) => x.includes('not on the recipient list')));
});

t('wrapping SOL into the wallet\'s own wSOL account is not a payment', () => {
  const wsolAcc = pk(), cleanup = pk();
  const ata = { program: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', accounts: [vault, wsolAcc, vault, WSOL, SYSTEM, TOKEN], data: Uint8Array.from([1]) };
  const r = judge({ move: move([ata, solIx(vault, wsolAcc, 1000000), { program: JUPITER, accounts: [vault, cleanup], data: new Uint8Array(8) }]), policy, delta: noDelta(-1000000n), owner });
  assert.equal(r.verdict, 'passed', r.reasons.join('; '));
  assert.equal(JUPITER, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
});

t('over the per move limit is turned back', () => {
  const r = judge({ move: move([solIx(vault, friend, 600000000)]), policy, delta: noDelta(-600000000n), owner });
  assert.ok(r.reasons.some((x) => x.includes('per move')));
});

t('over the daily limit is turned back', () => {
  const r = judge({ move: move([solIx(vault, friend, 400000000)]), policy, delta: noDelta(-400000000n), spent: { sol: 700000000n, tokens: {} }, owner });
  assert.ok(r.reasons.some((x) => x.includes('24h')));
});

t('approve and set authority are turned back', () => {
  const acc = pk();
  const r = judge({ move: move([tokenIx(4, [acc, stranger, vault], 1), tokenIx(6, [acc, vault], 0)]), policy, delta: noDelta(), owner });
  assert.equal(r.reasons.filter((x) => x.includes('approve') || x.includes('set authority')).length, 2);
});

t('unknown program is turned back, a listed one is not', () => {
  const prog = pk();
  const ix = { program: prog, accounts: [vault], data: new Uint8Array([1]) };
  assert.equal(judge({ move: move([ix]), policy, delta: noDelta(), owner }).verdict, 'turned back');
  const p2 = normalizePolicy({ ...policy, programs: [prog] });
  assert.equal(judge({ move: move([ix]), policy: p2, delta: noDelta(), owner }).verdict, 'passed');
});

t('a swap that brings a token back passes, one that brings nothing is turned back', () => {
  const swap = { program: JUPITER, accounts: [vault], data: new Uint8Array([7]) };
  const bought = pk();
  assert.equal(judge({ move: move([swap]), policy, delta: noDelta(-200000000n, { [bought]: 5000n }), owner }).verdict, 'passed');
  const r = judge({ move: move([swap]), policy, delta: noDelta(-200000000n, {}), owner });
  assert.ok(r.reasons.some((x) => x.includes('gets nothing back')));
});

t('buy list blocks other tokens', () => {
  const p2 = normalizePolicy({ ...policy, buyOnly: [mint] });
  const r = judge({ move: move([{ program: JUPITER, accounts: [], data: new Uint8Array([7]) }]), policy: p2, delta: noDelta(-1000n, { [pk()]: 5n }), owner });
  assert.ok(r.reasons.some((x) => x.includes('buy list')));
});

t('token limits and selling unlisted tokens for SOL', () => {
  const r = judge({ move: move([]), policy, delta: noDelta(0n, { [mint]: -120n }), owner });
  assert.ok(r.reasons.some((x) => x.includes('per move')));
  const other = pk();
  assert.equal(judge({ move: move([]), policy, delta: noDelta(50000000n, { [other]: -1000n }), owner }).verdict, 'passed');
  assert.ok(judge({ move: move([]), policy, delta: noDelta(0n, { [other]: -1000n }), owner }).reasons.some((x) => x.includes('nothing back')));
});

t('token transfer to a friend via a fresh ATA passes', () => {
  const ata = pk();
  const create = { program: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', accounts: [vault, ata, friend, mint], data: new Uint8Array([1]) };
  const send = tokenIx(12, [pk(), mint, ata, vault], 50);
  const r = judge({ move: move([create, send]), policy, delta: noDelta(-2039280n, { [mint]: -50n }), owner });
  assert.equal(r.verdict, 'passed', r.reasons.join('; '));
});

t('balance delta reads SOL, wSOL, tokens and a new spender', () => {
  const acc = pk(), wacc = pk();
  const keys = [vault, acc, wacc];
  const sys = (lamports) => ({ lamports, owner: SYSTEM, data: new Uint8Array() });
  const tok = (o) => ({ lamports: 2039280, owner: TOKEN, data: tokenData(o) });
  const before = [sys(1e9), tok({ mint, owner: vault, amount: 100 }), null];
  const after = [sys(5e8), tok({ mint, owner: vault, amount: 40, delegate: stranger }), tok({ mint: WSOL, owner: vault, amount: 4e8 })];
  const d = balanceDelta(vault, keys, before, after);
  assert.equal(d.sol, -100000000n);
  assert.equal(d.tokens[mint], -60n);
  assert.ok(d.problems.some((x) => x.includes('spender')));
  assert.equal(d.owners[acc], vault);
  assert.equal(parseTokenAccount(tokenData({ mint, owner: vault, amount: 7 })).amount, 7n);
});

t('lookup tables resolve in Squads order', () => {
  const s = [pk(), pk(), pk()], table = [pk(), pk(), pk(), pk()];
  const message = {
    numSigners: 1, numWritableSigners: 1, numWritableNonSigners: 1,
    accountKeys: s.map((k) => new PublicKey(k)),
    addressTableLookups: [{ accountKey: new PublicKey(table[0]), writableIndexes: [2], readonlyIndexes: [0, 3] }],
  };
  const keys = resolveKeys(message, [{ key: new PublicKey(table[0]), state: { addresses: table.map((k) => new PublicKey(k)) } }]);
  assert.deepEqual(keys.map((k) => [k.key, k.writable]), [[s[0], true], [s[1], true], [s[2], false], [table[2], true], [table[0], false], [table[3], false]]);
});

t('two lookup tables: all writable first, then all readonly', () => {
  const s = [pk()], a = [pk(), pk()], b = [pk(), pk()];
  const table = (k) => ({ key: new PublicKey(k[0]), state: { addresses: k.map((x) => new PublicKey(x)) } });
  const message = {
    numSigners: 1, numWritableSigners: 1, numWritableNonSigners: 0, accountKeys: s.map((k) => new PublicKey(k)),
    addressTableLookups: [
      { accountKey: new PublicKey(a[0]), writableIndexes: [0], readonlyIndexes: [1] },
      { accountKey: new PublicKey(b[0]), writableIndexes: [0], readonlyIndexes: [1] },
    ],
  };
  const keys = resolveKeys(message, [table(a), table(b)]);
  assert.deepEqual(keys.map((k) => k.key), [s[0], a[0], b[0], a[1], b[1]]);
});

t('guardable wallets', () => {
  const griffin = pk();
  const ok = { threshold: 2, timeLock: 0, configAuthority: owner, members: [{ key: owner }, { key: agent }, { key: griffin }] };
  assert.equal(guardable(ok, griffin), null);
  assert.ok(guardable({ ...ok, threshold: 1 }, griffin));
  assert.ok(guardable({ ...ok, members: [] }, griffin));
});

t('SOL amounts', () => {
  assert.equal(solToLamports('0.25'), 250000000n);
  assert.equal(fmtSol(250000000n), '0.25');
  assert.equal(fmtSol(3000000000n), '3');
});

console.log(`${passed} passed`);
