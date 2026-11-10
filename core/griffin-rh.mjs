// GRIFFIN on Robinhood Chain: the shared engine for the worker, the agent kit and the tests.
// Reads a Safe's charter from GriffinModule, mirrors the module's own checks to explain a refusal, simulates the move
// through the Safe with GriffinSim in an eth_call state override, judges it, and signs the EIP-712 Move.
import {
  createPublicClient, http, encodeFunctionData, decodeFunctionResult, decodeFunctionData, keccak256, encodeAbiParameters,
  pad, getAddress, isAddress, formatEther, parseAbiItem, zeroAddress, decodeEventLog,
} from 'viem';
import MODULE_ART from '../contracts/build/GriffinModule.json' with { type: 'json' };
import SIM_ART from '../contracts/build/GriffinSim.json' with { type: 'json' };

export const CHAIN_ID = 4663;
export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const chain = { id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [PUBLIC_RPC] } } };
// Safe v1.4.1 on Robinhood Chain
export const SAFE = {
  singletonL2: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
  multiSend: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
};
export const MODULE_ABI = MODULE_ART.abi;
export const SIM_ABI = SIM_ART.abi;
export const SIM_CODE = SIM_ART.deployedBytecode;
// a spare address for GriffinSim inside eth_call; nothing lives there on chain
export const SIM_ADDRESS = '0x00000000000000000000000000000000006f1ff1';
export const SAFE_ABI = [
  { type: 'function', name: 'isModuleEnabled', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
export const ERC20_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];
export const MOVE_TYPES = {
  Move: [
    { name: 'safe', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'dataHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
};
const CHARTER_EVENT = parseAbiItem('event CharterSet(address indexed safe, uint64 version, address agent, address griffin, uint128 ethPerMove, uint128 ethPerDay, address[] recipients, address[] tokens, (uint128 perMove, uint128 perDay)[] limits, address[] targets)');
const SEL = { transfer: '0xa9059cbb', approve: '0x095ea7b3' };

export const client = (url) => createPublicClient({ chain, transport: http(url || PUBLIC_RPC, { retryCount: 2 }) });
export const fmtEth = (wei) => formatEther(BigInt(wei));
export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const addr = (a) => {
  if (typeof a !== 'string' || !isAddress(a)) throw Object.assign(new Error(`not an address: ${a}`), { status: 400 });
  return getAddress(a);
};

/// The lists of a charter from the CharterSet logs of a receipt (or any logs), for one Safe.
export function charterLists(logs, module, safe) {
  const found = [];
  for (const l of logs) {
    if (l.address?.toLowerCase() !== module.toLowerCase()) continue;
    try {
      const e = decodeEventLog({ abi: [CHARTER_EVENT], data: l.data, topics: l.topics });
      if (e.args.safe.toLowerCase() === safe.toLowerCase()) found.push(e.args);
    } catch { /* another event */ }
  }
  const last = found.pop();
  return last && {
    version: last.version, recipients: last.recipients, targets: last.targets,
    tokens: last.tokens.map((token, i) => ({ token, perMove: last.limits[i].perMove, perDay: last.limits[i].perDay })),
  };
}

/// The Safe's charter: the stored struct plus its lists. Lists come from `known` (cached from the CharterSet event of
/// the transaction that wrote them) when the version matches, else from logs of the recent `scan` blocks: free RPCs
/// refuse long log ranges. `listsKnown` is false when neither had them.
export async function readCharter(pub, module, safe, { known = null, fromBlock = 0n, scan = 9000n } = {}) {
  scan = BigInt(scan ?? 9000n);
  const [agent, griffin, ethPerMove, ethPerDay, version] = await pub.readContract({ address: module, abi: MODULE_ABI, functionName: 'charters', args: [safe] });
  const [enabled, nonce, spentEth] = await Promise.all([
    pub.readContract({ address: safe, abi: SAFE_ABI, functionName: 'isModuleEnabled', args: [module] }).catch(() => false),
    pub.readContract({ address: module, abi: MODULE_ABI, functionName: 'nonces', args: [safe] }),
    pub.readContract({ address: module, abi: MODULE_ABI, functionName: 'spentToday', args: [safe, zeroAddress] }),
  ]);
  const charter = { safe, enabled, agent, griffin, ethPerMove, ethPerDay, version, nonce, spentEth, recipients: [], tokens: [], targets: [], listsKnown: version === 0n };
  if (version === 0n) return charter;
  let lists = known && BigInt(known.version) === version ? known : null;
  if (!lists) {
    const latest = await pub.getBlockNumber();
    const from = latest - scan > BigInt(fromBlock) ? latest - scan : BigInt(fromBlock);
    const logs = await pub.getLogs({ address: module, event: CHARTER_EVENT, args: { safe }, fromBlock: from, toBlock: latest }).catch(() => []);
    const found = charterLists(logs, module, safe);
    if (found && found.version === version) lists = found;
  }
  if (!lists) return charter;
  charter.listsKnown = true;
  charter.recipients = lists.recipients;
  charter.targets = lists.targets;
  charter.tokens = await Promise.all(lists.tokens.map(async (t) => ({
    token: t.token, perMove: BigInt(t.perMove), perDay: BigInt(t.perDay),
    spent: await pub.readContract({ address: module, abi: MODULE_ABI, functionName: 'spentToday', args: [safe, t.token] }),
  })));
  return charter;
}

/// The module's own rules, in words. Anything listed here makes execute() revert.
export function checkRules(charter, module, move) {
  const { to, value, data } = move;
  const reasons = [];
  const has = (list, a) => list.some((x) => x.toLowerCase() === a.toLowerCase());
  if (!charter.enabled) reasons.push('the GRIFFIN module is not enabled on this Safe');
  if (charter.agent === zeroAddress) reasons.push('this Safe has no charter yet');
  if (!charter.listsKnown) reasons.push("Griffin has not read this charter's lists yet: report the transaction that wrote it to /v1/charter");
  if (to.toLowerCase() === charter.safe.toLowerCase() || to.toLowerCase() === module.toLowerCase()) {
    return [...reasons, 'calls the Safe or the module itself, which would act as the owner'];
  }
  if (value > 0n) {
    if (value > charter.ethPerMove) reasons.push(`sends ${fmtEth(value)} ETH, over ${fmtEth(charter.ethPerMove)} per move`);
    if (charter.spentEth + value > charter.ethPerDay) reasons.push(`would bring today's ETH to ${fmtEth(charter.spentEth + value)}, over ${fmtEth(charter.ethPerDay)}`);
  }
  if (!data || data === '0x') {
    if (!has(charter.recipients, to) && !has(charter.targets, to)) reasons.push(`sends ETH to ${to}, not on the recipient list`);
    return reasons;
  }
  const selector = data.slice(0, 10).toLowerCase();
  const limit = charter.tokens.find((t) => t.token.toLowerCase() === to.toLowerCase());
  if (limit) {
    let who, amount;
    try { [who, amount] = decodeFunctionData({ abi: ERC20_ABI, data }).args; } catch { /* other selector */ }
    if (selector === SEL.transfer) {
      if (!has(charter.recipients, who)) reasons.push(`sends tokens to ${who}, not on the recipient list`);
    } else if (selector === SEL.approve) {
      if (!has(charter.targets, who)) reasons.push(`lets ${who} spend the Safe's tokens, and it is not a listed contract`);
    } else {
      return [...reasons, `calls ${selector} on a listed token; only transfer and approve are allowed`];
    }
    if (amount > limit.perMove) reasons.push(`moves ${fmtEth(amount)} of ${short(to)}, over ${fmtEth(limit.perMove)} per move`);
    if (limit.spent + amount > limit.perDay) reasons.push(`would bring today's ${short(to)} to ${fmtEth(limit.spent + amount)}, over ${fmtEth(limit.perDay)}`);
    return reasons;
  }
  if (!has(charter.targets, to)) reasons.push(`calls ${to}, a contract not on the list`);
  return reasons;
}

/// Run the move through the Safe without sending anything: GriffinSim sits at SIM_ADDRESS and is marked as a module.
export async function simulate(pub, safe, move, tokens = []) {
  // Safe ModuleManager keeps `mapping(address => address) modules` at slot 1; any non-zero value enables a module.
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [SIM_ADDRESS, 1n]));
  const data = encodeFunctionData({ abi: SIM_ABI, functionName: 'simulate', args: [safe, move.to, move.value, move.data || '0x', tokens] });
  const result = await pub.request({
    method: 'eth_call',
    params: [{ to: SIM_ADDRESS, data, gas: '0x1c9c380' }, 'latest', {
      [SIM_ADDRESS]: { code: SIM_CODE },
      [safe]: { stateDiff: { [slot]: pad('0x01', { size: 32 }) } },
    }],
  });
  const [ok, ret, ethDelta, tokenDeltas] = decodeFunctionResult({ abi: SIM_ABI, functionName: 'simulate', data: result });
  return { ok, ret, ethDelta, tokenDeltas: Object.fromEntries(tokens.map((t, i) => [t, tokenDeltas[i]])) };
}

/// Rules first, then what the simulation shows. A move into a listed contract must bring something back.
export function judge(charter, module, move, sim) {
  const reasons = checkRules(charter, module, move);
  if (!sim.ok) reasons.push('the move fails when simulated');
  const isCall = move.data && move.data !== '0x';
  const listedToken = charter.tokens.some((t) => t.token.toLowerCase() === move.to.toLowerCase());
  if (sim.ok && isCall && !listedToken) {
    const deltas = [sim.ethDelta, ...Object.values(sim.tokenDeltas)];
    const out = deltas.some((d) => d < 0n), back = deltas.some((d) => d > 0n);
    if (out && !back) reasons.push('pays out of the Safe and gets nothing back');
  }
  return { verdict: reasons.length ? 'turned back' : 'passed', reasons };
}

export const moveMessage = (safe, move, nonce, deadline) => ({
  safe, to: move.to, value: move.value, dataHash: keccak256(move.data || '0x'), nonce, deadline,
});
export const moveDomain = (module) => ({ name: 'GRIFFIN', version: '1', chainId: CHAIN_ID, verifyingContract: module });

/// Griffin's signature over the move, valid for this nonce until the deadline.
export const signMove = (account, module, safe, move, nonce, deadline) =>
  account.signTypedData({ domain: moveDomain(module), types: MOVE_TYPES, primaryType: 'Move', message: moveMessage(safe, move, nonce, deadline) });

/// Calldata for GriffinModule.execute, sent by the agent.
export const executeData = (safe, move, deadline, signature) =>
  encodeFunctionData({ abi: MODULE_ABI, functionName: 'execute', args: [safe, move.to, move.value, move.data || '0x', deadline, signature] });

/// One guarded move end to end on the server side: charter, rules, simulation, verdict, signature.
export async function guardMove({ pub, module, fromBlock, known, scan, griffin, safe, move, ttl = 600 }) {
  const charter = await readCharter(pub, module, safe, { known, fromBlock, scan });
  const tokens = [...new Set([...charter.tokens.map((t) => t.token), ...(move.data && move.data !== '0x' ? [move.to] : [])])];
  const sim = await simulate(pub, safe, move, tokens).catch((e) => ({ ok: false, error: e.shortMessage || e.message, ethDelta: 0n, tokenDeltas: {} }));
  const result = judge(charter, module, move, sim);
  if (charter.griffin.toLowerCase() !== griffin.address.toLowerCase()) {
    result.reasons.unshift(charter.griffin === zeroAddress ? 'this Safe runs without Griffin: the agent sends with an empty signature' : `this Safe trusts another co-signer (${charter.griffin})`);
    result.verdict = 'turned back';
  }
  const out = { safe, nonce: charter.nonce, verdict: result.verdict, reasons: result.reasons, sim: { ok: sim.ok, ethDelta: sim.ethDelta, tokenDeltas: sim.tokenDeltas } };
  if (result.verdict !== 'passed') return out;
  const block = await pub.getBlock();
  const deadline = block.timestamp + BigInt(ttl);
  const signature = await signMove(griffin, module, safe, move, charter.nonce, deadline);
  return { ...out, deadline, signature, execute: { to: module, data: executeData(safe, move, deadline, signature) } };
}

/// Safe.setup calldata for a new Safe owned by `owner` that enables the module and writes the first charter.
export function setupCalldata({ owner, module, agent, griffin, ethPerMove, ethPerDay, recipients = [], tokens = [], targets = [] }) {
  const setupSafe = encodeFunctionData({
    abi: MODULE_ABI, functionName: 'setupSafe',
    args: [agent, griffin, ethPerMove, ethPerDay, recipients, tokens.map((t) => t.token), tokens.map((t) => ({ perMove: t.perMove, perDay: t.perDay })), targets],
  });
  return encodeFunctionData({
    abi: [{ type: 'function', name: 'setup', inputs: [{ type: 'address[]' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }], outputs: [] }],
    functionName: 'setup', args: [[owner], 1n, module, setupSafe, SAFE.fallbackHandler, zeroAddress, 0n, zeroAddress],
  });
}
