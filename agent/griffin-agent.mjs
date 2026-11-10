// GRIFFIN agent kit for Robinhood Chain. Holds the agent key locally, asks Griffin for each move and sends
// GriffinModule.execute itself. The calldata is built here from the agent's own move and Griffin's signature,
// so a server that answered with something else could not slip in another move.
import fs from 'node:fs';
import { createWalletClient, http, parseEther, parseUnits, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { client, chain, addr, executeData, fmtEth, ERC20_ABI } from '../core/griffin-rh.mjs';

export function loadConfig(env = process.env) {
  const raw = env.GRIFFIN_AGENT_KEY;
  if (!raw) throw new Error('Set GRIFFIN_AGENT_KEY (hex private key, or a file that holds one)');
  if (!env.GRIFFIN_SAFE) throw new Error('Set GRIFFIN_SAFE (the Safe the agent spends from)');
  const key = (fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : raw).trim();
  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
  const rpc = env.RH_RPC_URL;
  return {
    account,
    safe: addr(env.GRIFFIN_SAFE),
    api: (env.GRIFFIN_API || 'https://griffinguard.fun').replace(/\/+$/, ''),
    pub: client(rpc),
    wallet: createWalletClient({ account, chain, transport: http(rpc || chain.rpcUrls.default.http[0]) }),
  };
}

async function api(cfg, path, body) {
  const res = await fetch(cfg.api + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Griffin answered ${res.status}`);
  return data;
}

export async function status(cfg) {
  const [charter, balance] = await Promise.all([api(cfg, `/v1/safe/${cfg.safe}`), cfg.pub.getBalance({ address: cfg.safe })]);
  return { safe: cfg.safe, agent: cfg.account.address, balanceEth: fmtEth(balance), charter };
}

/// Ask Griffin, then send the move through the module from the agent key.
export async function act(cfg, move) {
  const m = { to: addr(move.to), value: BigInt(move.value || 0), data: move.data || '0x' };
  const r = await api(cfg, '/v1/guard', { safe: cfg.safe, to: m.to, value: m.value.toString(), data: m.data });
  if (r.verdict !== 'passed') return { verdict: r.verdict, reasons: r.reasons };
  const { module } = await api(cfg, '/v1/griffin');
  const hash = await cfg.wallet.sendTransaction({ to: addr(module), data: executeData(cfg.safe, m, BigInt(r.deadline), r.signature) });
  const receipt = await cfg.pub.waitForTransactionReceipt({ hash });
  return { verdict: 'passed', reasons: r.reasons, hash, status: receipt.status };
}

export const sendEth = (cfg, to, eth) => act(cfg, { to, value: parseEther(String(eth)) });

export async function sendToken(cfg, token, to, amount) {
  const decimals = await cfg.pub.readContract({ address: addr(token), abi: ERC20_ABI, functionName: 'decimals' });
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [addr(to), parseUnits(String(amount), decimals)] });
  return act(cfg, { to: token, data });
}

/// Any call to a contract the charter lists, e.g. a DEX router. value in ETH.
export const call = (cfg, to, data, eth = '0') => act(cfg, { to, data, value: parseEther(String(eth)) });
