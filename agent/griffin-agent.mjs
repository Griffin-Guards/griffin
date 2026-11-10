// GRIFFIN agent SDK. Holds the agent key locally, proposes moves on the guarded wallet and asks Griffin for the second vote.
import fs from 'node:fs';
import {
  Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction, bs58, buildPropose, compile, readWallet, vaultOf, fmtSol, solToLamports,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from '../core/griffin.mjs';

const JUP = 'https://lite-api.jup.ag/swap/v1';

export function loadConfig(env = process.env) {
  const raw = env.GRIFFIN_AGENT_KEY;
  if (!raw) throw new Error('Set GRIFFIN_AGENT_KEY (path to a keypair JSON, or a base58 secret key)');
  if (!env.GRIFFIN_WALLET) throw new Error('Set GRIFFIN_WALLET (the Squads wallet address from the Griffin site)');
  const secret = fs.existsSync(raw) ? Uint8Array.from(JSON.parse(fs.readFileSync(raw, 'utf8'))) : bs58.decode(raw);
  return {
    agent: Keypair.fromSecretKey(secret),
    multisig: new PublicKey(env.GRIFFIN_WALLET),
    api: (env.GRIFFIN_API || 'https://griffinguard.fun').replace(/\/+$/, ''),
    connection: new Connection(env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed'),
  };
}

async function api(cfg, path, body) {
  const res = await fetch(cfg.api + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Griffin answered ${res.status}`);
  return data;
}

async function sendSigned(connection, tx) {
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const r = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (r.value.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(r.value.err)}`);
  return sig;
}

export async function status(cfg) {
  const w = await api(cfg, `/v1/wallet/${cfg.multisig.toBase58()}`);
  const lamports = await cfg.connection.getBalance(vaultOf(cfg.multisig));
  const agentLamports = await cfg.connection.getBalance(cfg.agent.publicKey);
  return {
    wallet: cfg.multisig.toBase58(), vault: w.vault, vaultSol: fmtSol(lamports), agent: cfg.agent.publicKey.toBase58(), agentSol: fmtSol(agentLamports),
    problem: w.problem, policy: w.policy?.policy || null, spent24h: fmtSol(w.spent24h || 0), recent: w.verdicts.slice(0, 5),
  };
}

// Propose the instructions, then ask Griffin. A passed move is executed right away.
export async function act(cfg, ixs, tables = [], memo) {
  const { connection, agent, multisig } = cfg;
  const { index, ixs: proposeIxs } = await buildPropose({ connection, multisigPda: multisig, member: agent.publicKey, ixs, tables, memo });
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = compile(agent.publicKey, blockhash, proposeIxs);
  tx.sign([agent]);
  const proposed = await sendSigned(connection, tx);
  const verdict = await api(cfg, '/v1/guard', { multisig: multisig.toBase58(), index: Number(index) });
  if (verdict.verdict !== 'passed') return { index: Number(index), proposed, verdict: verdict.verdict, reasons: verdict.reasons };
  const release = VersionedTransaction.deserialize(Buffer.from(verdict.transaction, 'base64'));
  release.sign([agent]);
  const executed = await sendSigned(connection, release);
  return { index: Number(index), proposed, executed, verdict: 'passed', reasons: verdict.reasons };
}

export async function sendSol(cfg, to, amount) {
  const vault = vaultOf(cfg.multisig);
  return act(cfg, [SystemProgram.transfer({ fromPubkey: vault, toPubkey: new PublicKey(to), lamports: solToLamports(amount) })], [], 'GRIFFIN send SOL');
}

export async function sendToken(cfg, mint, to, amount) {
  const vault = vaultOf(cfg.multisig);
  mint = new PublicKey(mint); to = new PublicKey(to);
  const info = await cfg.connection.getAccountInfo(mint);
  if (!info) throw new Error('Mint not found');
  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const decimals = info.data[44];
  const [whole, part = ''] = String(amount).split('.');
  if (part.length > decimals) throw new Error('Too many decimals for this token');
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(part.padEnd(decimals, '0') || 0);
  const src = getAssociatedTokenAddressSync(mint, vault, true, program);
  const dst = getAssociatedTokenAddressSync(mint, to, true, program);
  return act(cfg, [
    createAssociatedTokenAccountIdempotentInstruction(vault, dst, to, mint, program),
    createTransferCheckedInstruction(src, mint, dst, vault, raw, decimals, [], program),
  ], [], 'GRIFFIN send token');
}

const toIx = (ix) => ({
  programId: new PublicKey(ix.programId),
  keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
  data: Buffer.from(ix.data, 'base64'),
});

// Swap through Jupiter with the vault as the trader. amount is in the input token's base units.
// Jupiter sometimes puts a DEX's own instructions at the top of the route. Griffin only lets listed programs through,
// so ask again without those DEXes until every top-level program is on the wallet's list.
async function allowedPrograms(cfg) {
  const [g, w] = await Promise.all([api(cfg, '/v1/griffin'), api(cfg, `/v1/wallet/${cfg.multisig.toBase58()}`)]);
  return new Set([...(g.programs || []), ...(w.policy?.policy?.programs || [])]);
}

export async function swap(cfg, inputMint, outputMint, amount, slippageBps = 100) {
  const vault = vaultOf(cfg.multisig);
  const allowed = await allowedPrograms(cfg);
  const exclude = new Set();
  let labels = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const q = new URLSearchParams({ inputMint, outputMint, amount: String(amount), slippageBps: String(slippageBps), maxAccounts: '24' });
    if (exclude.size) q.set('excludeDexes', [...exclude].join(','));
    const quote = await (await fetch(`${JUP}/quote?${q}`)).json();
    if (quote.error || !quote.outAmount) throw new Error(`No route: ${quote.error || 'empty quote'}`);
    const res = await fetch(`${JUP}/swap-instructions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: vault.toBase58(), wrapAndUnwrapSol: true }),
    });
    const s = await res.json();
    if (s.error) throw new Error(`Jupiter: ${s.error}`);
    const raw = [...(s.setupInstructions || []), s.swapInstruction, ...(s.cleanupInstruction ? [s.cleanupInstruction] : [])];
    const off = [...new Set(raw.map((i) => i.programId).filter((id) => !allowed.has(id)))];
    if (off.length) {
      labels ||= await (await fetch(`${JUP}/program-id-to-label`)).json();
      const named = off.map((id) => labels[id]).filter(Boolean);
      if (named.length < off.length) throw new Error(`Jupiter route calls programs Griffin will not pass: ${off.join(', ')}`);
      named.forEach((n) => exclude.add(n));
      continue;
    }
    const tables = (await Promise.all((s.addressLookupTableAddresses || []).map((a) => cfg.connection.getAddressLookupTable(new PublicKey(a))))).map((r) => r.value).filter(Boolean);
    const r = await act(cfg, raw.map(toIx), tables, 'GRIFFIN swap');
    return { ...r, quote: { inAmount: quote.inAmount, outAmount: quote.outAmount, priceImpactPct: quote.priceImpactPct }, excluded: [...exclude] };
  }
  throw new Error(`No Jupiter route inside the program list (left out: ${[...exclude].join(', ')})`);
}

export { readWallet };
