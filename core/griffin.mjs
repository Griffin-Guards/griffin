// GRIFFIN core. Works in Node, in the worker and in the browser bundle.
// An agent wallet is a Squads v4 multisig, 2 of 3: owner (full), agent (full), griffin (vote only).
// The owner is also the config authority, so the owner can always rotate the agent or drop Griffin.
import * as multisig from '@sqds/multisig';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';

const { Permission, Permissions } = multisig.types;
const { accounts, instructions } = multisig;

export const THRESHOLD = 2;
export const MAX_TX_BYTES = 1232;
export const WSOL = 'So11111111111111111111111111111111111111112';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SYSTEM = SystemProgram.programId.toBase58();
const TOKEN = TOKEN_PROGRAM_ID.toBase58();
const TOKEN22 = TOKEN_2022_PROGRAM_ID.toBase58();
const ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
// Programs the agent may call with no extra line in the policy. Anything else must be listed by the owner.
export const BASE_PROGRAMS = [SYSTEM, TOKEN, TOKEN22, ATA, COMPUTE_BUDGET, MEMO, JUPITER];
// Moving value out with nothing back below this is ATA rent and fees, not a payment.
export const DUST = 3000000n;
const PRIORITY_MICROLAMPORTS = 50000;
const COMPUTE_LIMIT = 600000;

const key = (k) => (k instanceof PublicKey ? k : new PublicKey(k));
export const voteOnly = () => Permissions.fromPermissions([Permission.Vote]);
export const fullAccess = () => Permissions.all();
export const vaultOf = (multisigPda) => multisig.getVaultPda({ multisigPda: key(multisigPda), index: 0 })[0];

// ---------- wallet ----------

export async function buildCreate({ connection, owner, agent, griffin }) {
  const keys = [owner, agent, griffin].map((k) => key(k).toBase58());
  if (new Set(keys).size !== 3) throw new Error('Owner, agent and Griffin must be three different keys');
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [configPda] = multisig.getProgramConfigPda({});
  const config = await accounts.ProgramConfig.fromAccountAddress(connection, configPda);
  const ix = instructions.multisigCreateV2({
    treasury: config.treasury,
    creator: key(owner),
    multisigPda,
    configAuthority: key(owner),
    threshold: THRESHOLD,
    members: [
      { key: key(owner), permissions: fullAccess() },
      { key: key(agent), permissions: fullAccess() },
      { key: key(griffin), permissions: voteOnly() },
    ],
    timeLock: 0,
    createKey: createKey.publicKey,
    rentCollector: vaultOf(multisigPda),
    memo: 'GRIFFIN agent wallet',
  });
  return { createKey, multisigPda, vault: vaultOf(multisigPda), ixs: [ix] };
}

// Owner moves that need no vote: the config authority signs them alone.
export function buildSwapAgent({ multisigPda, owner, oldAgent, newAgent }) {
  const args = { multisigPda: key(multisigPda), configAuthority: key(owner), rentPayer: key(owner) };
  return [
    instructions.multisigAddMember({ ...args, newMember: { key: key(newAgent), permissions: fullAccess() }, memo: 'GRIFFIN new agent' }),
    instructions.multisigRemoveMember({ ...args, oldMember: key(oldAgent), memo: 'GRIFFIN old agent out' }),
  ];
}

// The way out if Griffin ever stops answering: threshold 1, then the owner signs alone.
export function buildDismiss({ multisigPda, owner, griffin }) {
  const args = { multisigPda: key(multisigPda), configAuthority: key(owner), rentPayer: key(owner) };
  return [
    instructions.multisigRemoveMember({ ...args, oldMember: key(griffin), memo: 'GRIFFIN dismissed' }),
    instructions.multisigChangeThreshold({ ...args, newThreshold: 1, memo: 'GRIFFIN dismissed' }),
  ];
}

export async function nextIndex(connection, multisigPda) {
  const ms = await accounts.Multisig.fromAccountAddress(connection, key(multisigPda));
  return BigInt(ms.transactionIndex.toString()) + 1n;
}

// Wraps the agent's instructions into a vault transaction, opens the proposal and casts the agent's vote.
export async function buildPropose({ connection, multisigPda, member, ixs, tables = [], memo = 'GRIFFIN move' }) {
  multisigPda = key(multisigPda); member = key(member);
  const vault = vaultOf(multisigPda);
  const index = await nextIndex(connection, multisigPda);
  const { blockhash } = await connection.getLatestBlockhash();
  const createIx = instructions.vaultTransactionCreate({
    multisigPda, transactionIndex: index, creator: member, vaultIndex: 0, ephemeralSigners: 0,
    transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: ixs }),
    addressLookupTableAccounts: tables,
    memo,
  });
  return {
    index,
    ixs: [
      createIx,
      instructions.proposalCreate({ multisigPda, transactionIndex: index, creator: member }),
      instructions.proposalApprove({ multisigPda, transactionIndex: index, member }),
    ],
  };
}

// Griffin's vote, then the agent executes and the spent accounts close back into the vault.
export async function buildRelease({ connection, multisigPda, index, griffin, member, close = true }) {
  multisigPda = key(multisigPda);
  const transactionIndex = BigInt(index);
  const { instruction, lookupTableAccounts } = await instructions.vaultTransactionExecute({
    connection, multisigPda, transactionIndex, member: key(member),
  });
  const ixs = [instructions.proposalApprove({ multisigPda, transactionIndex, member: key(griffin) }), instruction];
  if (close) ixs.push(instructions.vaultTransactionAccountsClose({ multisigPda, transactionIndex, rentCollector: vaultOf(multisigPda) }));
  return { ixs, tables: lookupTableAccounts };
}

export function withBudget(ixs, units = COMPUTE_LIMIT) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }),
    ...ixs,
  ];
}

export function compile(payer, blockhash, ixs, tables = []) {
  const message = new TransactionMessage({ payerKey: key(payer), recentBlockhash: blockhash, instructions: withBudget(ixs) }).compileToV0Message(tables);
  return new VersionedTransaction(message);
}

export const txBytes = (tx) => tx.serialize().length;

// ---------- reading a move ----------

// Static keys first, then each table's writable and read-only picks, the order Squads executes in.
export function resolveKeys(message, tables) {
  const keys = message.accountKeys.map((k, i) => ({
    key: k.toBase58(),
    writable: i < message.numWritableSigners || (i >= message.numSigners && i < message.numSigners + message.numWritableNonSigners),
  }));
  // Same order as a v0 message: static keys, then the writable addresses of every table, then the readonly ones.
  const loaded = { writable: [], readonly: [] };
  for (const lookup of message.addressTableLookups) {
    const table = tables.find((t) => t.key.equals(lookup.accountKey));
    if (!table) throw new Error(`Lookup table ${lookup.accountKey.toBase58()} not found`);
    for (const i of lookup.writableIndexes) loaded.writable.push({ key: table.state.addresses[i].toBase58(), writable: true });
    for (const i of lookup.readonlyIndexes) loaded.readonly.push({ key: table.state.addresses[i].toBase58(), writable: false });
  }
  keys.push(...loaded.writable, ...loaded.readonly);
  return keys;
}

export async function readMove(connection, multisigPda, index) {
  multisigPda = key(multisigPda);
  const transactionIndex = BigInt(index);
  const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex });
  const [transactionPda] = multisig.getTransactionPda({ multisigPda, index: transactionIndex });
  const [msInfo, proposalInfo, txInfo] = await connection.getMultipleAccountsInfo([multisigPda, proposalPda, transactionPda]);
  if (!msInfo) throw new Error('No Squads wallet at that address');
  const ms = accounts.Multisig.fromAccountInfo(msInfo)[0];
  if (!txInfo) throw new Error('No move at that number');
  let tx;
  try { tx = accounts.VaultTransaction.fromAccountInfo(txInfo)[0]; } catch { throw new Error('That move is a config change, not a vault move'); }
  const proposal = proposalInfo ? accounts.Proposal.fromAccountInfo(proposalInfo)[0] : null;
  const tables = await Promise.all(tx.message.addressTableLookups.map(async (l) => {
    const { value } = await connection.getAddressLookupTable(l.accountKey);
    if (!value) throw new Error(`Lookup table ${l.accountKey.toBase58()} not found`);
    return value;
  }));
  const keys = resolveKeys(tx.message, tables);
  return {
    multisigPda: multisigPda.toBase58(),
    vault: vaultOf(multisigPda).toBase58(),
    index: Number(transactionIndex),
    creator: tx.creator.toBase58(),
    ephemeral: tx.ephemeralSignerBumps.length,
    status: proposal?.status.__kind ?? 'NoProposal',
    approved: proposal?.approved.map(String) ?? [],
    stale: Number(transactionIndex) <= Number(ms.staleTransactionIndex.toString()),
    wallet: walletOf(ms),
    keys,
    instructions: tx.message.instructions.map((ix) => ({
      program: keys[ix.programIdIndex].key,
      accounts: [...ix.accountIndexes].map((i) => keys[i].key),
      data: Uint8Array.from(ix.data),
    })),
  };
}

export function walletOf(ms) {
  return {
    threshold: ms.threshold,
    timeLock: ms.timeLock,
    configAuthority: ms.configAuthority.toBase58(),
    members: ms.members.map((m) => ({
      key: m.key.toBase58(),
      role: Permissions.has(m.permissions, Permission.Initiate) ? 'full' : Permissions.has(m.permissions, Permission.Vote) ? 'vote' : 'none',
    })),
  };
}

export async function readWallet(connection, multisigPda) {
  const ms = await accounts.Multisig.fromAccountAddress(connection, key(multisigPda));
  return { ...walletOf(ms), last: Number(ms.transactionIndex.toString()), vault: vaultOf(multisigPda).toBase58() };
}

// A wallet Griffin will guard: 2 of 3, no wait, Griffin votes only, the owner holds the config.
export function guardable(wallet, griffin) {
  const g = wallet.members.find((m) => m.key === griffin);
  if (!g) return 'Griffin is not a member of this wallet';
  if (wallet.threshold !== THRESHOLD) return 'The wallet must need 2 votes';
  if (wallet.timeLock !== 0) return 'The wallet must have no time lock';
  if (wallet.configAuthority === SYSTEM || wallet.configAuthority === griffin) return 'The owner must hold the wallet config';
  return null;
}

// ---------- policy ----------

const U = (v) => { try { const n = BigInt(String(v ?? 0)); return n < 0n ? 0n : n; } catch { throw new Error(`Not a whole number: ${v}`); } };
const isKey = (s) => { try { return new PublicKey(s).toBase58() === s; } catch { return false; } };

// Every number is in base units (lamports, raw token units) and kept as a string.
export function normalizePolicy(p = {}) {
  const list = (a, what) => {
    const out = [...new Set((Array.isArray(a) ? a : []).map(String))];
    for (const k of out) if (!isKey(k)) throw new Error(`Not an address in ${what}: ${k}`);
    if (out.length > 50) throw new Error(`At most 50 entries in ${what}`);
    return out.sort();
  };
  const tokens = {};
  for (const [mint, l] of Object.entries(p.tokens || {}).sort()) {
    if (!isKey(mint)) throw new Error(`Not a mint: ${mint}`);
    tokens[mint] = { perTx: String(U(l?.perTx)), perDay: String(U(l?.perDay)) };
  }
  if (Object.keys(tokens).length > 30) throw new Error('At most 30 token limits');
  return {
    v: 1,
    solPerTx: String(U(p.solPerTx)),
    solPerDay: String(U(p.solPerDay)),
    tokens,
    recipients: list(p.recipients, 'recipients'),
    programs: list(p.programs, 'programs'),
    buyOnly: list(p.buyOnly, 'buy only'),
  };
}

export const policyHash = (policy) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(normalizePolicy(policy)))));

// The text the owner signs. Short and readable in a wallet popup.
export function policyMessage(multisigPda, policy, nonce) {
  return `GRIFFIN policy\nwallet: ${key(multisigPda).toBase58()}\nhash: ${policyHash(policy)}\nnonce: ${nonce}`;
}

export function verifySigned(message, signature, signer) {
  try {
    const sig = typeof signature === 'string' ? bs58.decode(signature) : signature;
    return ed25519.verify(sig, new TextEncoder().encode(message), new PublicKey(signer).toBytes());
  } catch { return false; }
}

// ---------- the check ----------

const u32 = (d, at) => d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24);
const u64 = (d, at) => { let n = 0n; for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(d[at + i]); return n; };

// Reads a token account (both token programs share the first 165 bytes).
export function parseTokenAccount(data) {
  if (!data || data.length < 165) return null;
  const pk = (at) => new PublicKey(data.subarray(at, at + 32)).toBase58();
  return {
    mint: pk(0),
    owner: pk(32),
    amount: u64(data, 64),
    delegate: u32(data, 72) === 1 ? pk(76) : null,
    closeAuthority: u32(data, 129) === 1 ? pk(133) : null,
  };
}

// Looks at each top-level instruction of the move. Returns problems and the plain transfers it found.
export function checkInstructions(move, policy, owners = {}) {
  const vault = move.vault;
  const programs = new Set([...BASE_PROGRAMS, ...policy.programs]);
  const recipients = new Set(policy.recipients);
  const problems = [];
  const transfers = [];
  const ataOwner = new Map();
  for (const ix of move.instructions) {
    if (ix.program === ATA) ataOwner.set(ix.accounts[1], ix.accounts[2]);
  }
  move.instructions.forEach((ix, n) => {
    const at = `#${n + 1}`;
    const d = ix.data;
    if (!programs.has(ix.program)) return problems.push(`${at} calls a program not on the list (${ix.program})`);
    if (ix.program === SYSTEM) {
      const kind = d.length >= 4 ? u32(d, 0) : -1;
      if (kind !== 2) return problems.push(`${at} is a system call other than a plain transfer`);
      const to = ix.accounts[1];
      if (ix.accounts[0] === vault && to !== vault) transfers.push({ kind: 'sol', to, amount: u64(d, 4) });
      return;
    }
    if (ix.program === TOKEN || ix.program === TOKEN22) {
      const kind = d[0];
      if (kind === 3 || kind === 12) {
        const dest = kind === 3 ? ix.accounts[1] : ix.accounts[2];
        const authority = kind === 3 ? ix.accounts[2] : ix.accounts[3];
        if (authority === vault) transfers.push({ kind: 'token', account: dest, owner: ataOwner.get(dest) || owners[dest] || null, mint: kind === 12 ? ix.accounts[1] : null, amount: u64(d, 1) });
        return;
      }
      if (kind === 9) {
        if (ix.accounts[1] !== vault) problems.push(`${at} closes a token account into another wallet`);
        return;
      }
      if (kind === 17) return; // sync native
      if (kind === 4 || kind === 13) return problems.push(`${at} lets someone else spend the wallet's tokens (approve)`);
      if (kind === 6) return problems.push(`${at} changes who owns a token account (set authority)`);
      return problems.push(`${at} is a token call Griffin does not allow (${kind})`);
    }
    if (ix.program === ATA) {
      if (d.length && d[0] > 1) problems.push(`${at} is an associated token call Griffin does not allow`);
    }
  });
  for (const t of transfers) {
    // SOL sent into the wallet's own token account (wrapping to wSOL before a swap) stays with the wallet.
    const owner = t.kind === 'sol' ? (ataOwner.get(t.to) || owners[t.to] || t.to) : t.owner;
    t.ok = !!owner && (owner === vault || recipients.has(owner));
  }
  return { problems, transfers };
}

// What the move does to the vault, from account states before and after a simulation.
export function balanceDelta(vault, keys, before, after) {
  const sol = { before: 0n, after: 0n };
  const tokens = {};
  const owners = {};
  const problems = [];
  keys.forEach((k, i) => {
    const pre = before[i];
    const post = after[i];
    if (k === vault) {
      sol.before = BigInt(pre?.lamports ?? 0);
      sol.after = BigInt(post?.lamports ?? 0);
      if (post && post.owner !== SYSTEM) problems.push('the wallet account would change owner');
      return;
    }
    const tokenProgram = (a) => a && (a.owner === TOKEN || a.owner === TOKEN22);
    const a = tokenProgram(pre) ? parseTokenAccount(pre.data) : null;
    const b = tokenProgram(post) ? parseTokenAccount(post.data) : null;
    if (a || b) owners[k] = (b || a).owner;
    if (a?.owner !== vault && b?.owner !== vault) return;
    if (a?.owner === vault && b && b.owner !== vault) problems.push(`a token account would pass to ${b.owner}`);
    if (b && b.owner === vault && b.delegate && b.delegate !== a?.delegate) problems.push(`a token account would get a spender (${b.delegate})`);
    if (b && b.owner === vault && b.closeAuthority && b.closeAuthority !== a?.closeAuthority) problems.push('a token account would get a new close authority');
    const mint = (b || a).mint;
    const amountBefore = a?.owner === vault ? a.amount : 0n;
    const amountAfter = b?.owner === vault ? b.amount : 0n;
    tokens[mint] = (tokens[mint] || 0n) + amountAfter - amountBefore;
  });
  // Wrapped SOL counts as SOL, so wrapping is not a spend and a swap paid in wSOL is.
  const wsol = tokens[WSOL] || 0n;
  delete tokens[WSOL];
  return { sol: sol.after - sol.before + wsol, tokens, owners, problems };
}

// The verdict. spent = what Griffin already passed in the last 24 hours.
export function judge({ move, policy, delta, spent = { sol: 0n, tokens: {} }, owner }) {
  const reasons = [];
  if (move.creator === owner) return { verdict: 'passed', reasons: ['the owner proposed it'], out: { sol: 0n, tokens: {} } };
  if (move.ephemeral) reasons.push('the move asks for extra signers');
  const { problems, transfers } = checkInstructions(move, policy, delta.owners || {});
  reasons.push(...problems, ...delta.problems);
  for (const t of transfers.filter((x) => !x.ok)) {
    reasons.push(t.kind === 'sol' ? `sends SOL to ${t.to}, not on the recipient list` : `sends tokens to ${t.owner || 'an account Griffin cannot place'}, not on the recipient list`);
  }
  const solOut = delta.sol < 0n ? -delta.sol : 0n;
  const out = { sol: solOut, tokens: {} };
  const inflow = delta.sol > 0n || Object.values(delta.tokens).some((v) => v > 0n);
  if (solOut > U(policy.solPerTx)) reasons.push(`spends ${fmtSol(solOut)} SOL, over ${fmtSol(U(policy.solPerTx))} per move`);
  if (spent.sol + solOut > U(policy.solPerDay)) reasons.push(`would bring 24h spend to ${fmtSol(spent.sol + solOut)} SOL, over ${fmtSol(U(policy.solPerDay))}`);
  for (const [mint, change] of Object.entries(delta.tokens)) {
    if (change > 0n && policy.buyOnly.length && !policy.buyOnly.includes(mint)) reasons.push(`buys ${mint}, not on the buy list`);
    if (change >= 0n) continue;
    const amount = -change;
    out.tokens[mint] = amount;
    const limit = policy.tokens[mint];
    if (limit) {
      if (amount > U(limit.perTx)) reasons.push(`moves ${amount} of ${mint}, over ${limit.perTx} per move`);
      if ((spent.tokens[mint] || 0n) + amount > U(limit.perDay)) reasons.push(`would bring 24h ${mint} to ${(spent.tokens[mint] || 0n) + amount}, over ${limit.perDay}`);
    } else if (!inflow) {
      reasons.push(`gives away ${mint} with nothing back`);
    }
  }
  const allowedOut = transfers.filter((t) => t.ok && t.kind === 'sol' && t.to !== move.vault).reduce((s, t) => s + t.amount, 0n);
  if (solOut > allowedOut + DUST && !inflow) reasons.push(`pays out ${fmtSol(solOut)} SOL and gets nothing back`);
  return { verdict: reasons.length ? 'turned back' : 'passed', reasons, out };
}

export function fmtSol(lamports) {
  const n = BigInt(lamports);
  const whole = n / 1000000000n;
  const part = (n % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return part ? `${whole}.${part}` : `${whole}`;
}

export function solToLamports(text) {
  const clean = String(text).trim();
  if (!/^\d+(\.\d{1,9})?$/.test(clean)) throw new Error('Enter an amount like 0.25');
  const [whole, part = ''] = clean.split('.');
  return BigInt(whole) * 1000000000n + BigInt(part.padEnd(9, '0'));
}

// Simulates Griffin's vote plus the execute, and returns the before/after of every writable account in the move.
export async function simulateMove({ connection, move, griffin }) {
  const watch = [...new Set([move.vault, ...move.keys.filter((k) => k.writable).map((k) => k.key)])].slice(0, 60);
  const { ixs, tables } = await buildRelease({ connection, multisigPda: move.multisigPda, index: move.index, griffin, member: move.creator, close: false });
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = compile(move.creator, blockhash, ixs, tables);
  const beforeInfos = await connection.getMultipleAccountsInfo(watch.map((k) => new PublicKey(k)));
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true,
    accounts: { encoding: 'base64', addresses: watch },
  });
  const v = sim.value;
  if (v.err) return { ok: false, err: v.err, logs: (v.logs || []).slice(-12) };
  const plain = (info) => info && { lamports: info.lamports, owner: info.owner.toBase58(), data: Uint8Array.from(info.data) };
  const fromSim = (a) => a && { lamports: a.lamports, owner: a.owner, data: Uint8Array.from(Buffer.from(a.data[0], 'base64')) };
  return {
    ok: true,
    units: v.unitsConsumed,
    delta: balanceDelta(move.vault, watch, beforeInfos.map(plain), v.accounts.map(fromSim)),
  };
}

export {
  multisig, Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction, bs58, ed25519,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync,
};
