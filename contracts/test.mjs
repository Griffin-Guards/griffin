// GriffinModule on a Hardhat fork of Robinhood Chain, with the real Safe v1.4.1 singleton and proxy factory.
// Start the fork first: npx hardhat node --config hardhat.config.cjs --port 8547
// Fresh wallets only: well-known Hardhat accounts carry EIP-7702 delegations on Robinhood Chain.
import {
  createPublicClient, createWalletClient, http, parseEther, encodeFunctionData, decodeErrorResult, decodeFunctionResult,
  decodeEventLog, keccak256, encodeAbiParameters, zeroAddress, pad, toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const RPC = process.env.RPC || 'http://127.0.0.1:8547';
const art = (n) => JSON.parse(readFileSync(new URL(`./build/${n}.json`, import.meta.url)));
const MOD = art('GriffinModule'), SIM = art('GriffinSim'), TOK = art('MockToken'), ROUTER = art('MockRouter');
const chain = { id: 4663, name: 'rh-fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const raw = (method, params = []) => pub.request({ method, params });

// Safe v1.4.1 on Robinhood Chain
const SAFE_L2 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const FALLBACK = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
const SAFE_ABI = [
  { type: 'function', name: 'setup', stateMutability: 'nonpayable', inputs: [{ type: 'address[]' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }], outputs: [] },
  { type: 'function', name: 'execTransaction', stateMutability: 'payable', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'isModuleEnabled', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'disableModule', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'addOwnerWithThreshold', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
];
const FACTORY_ABI = [
  { type: 'function', name: 'createProxyWithNonce', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bytes' }, { type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'event', name: 'ProxyCreation', inputs: [{ type: 'address', name: 'proxy', indexed: true }, { type: 'address', name: 'singleton' }] },
];

let fails = 0;
let lastWhy = '';
const ok = (name, good, detail = '') => { if (!good && !detail) detail = lastWhy; if (!good) fails++; console.log(`${good ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };
const wallet = async (eth = '10') => {
  const account = privateKeyToAccount(generatePrivateKey());
  await raw('hardhat_setBalance', [account.address, toHex(parseEther(eth))]);
  return { account, address: account.address, w: createWalletClient({ account, chain, transport: http(RPC) }) };
};
const send = async (who, to, data, value = 0n) => {
  const hash = await who.w.sendTransaction({ to, data, value, gas: 3_000_000n });
  return pub.waitForTransactionReceipt({ hash });
};
const deploy = async (who, a) => {
  const hash = await who.w.deployContract({ abi: a.abi, bytecode: a.bytecode });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
};
const errAbi = [...MOD.abi, ...SAFE_ABI];
const reason = async (who, to, data, value = 0n) => {
  try { await pub.call({ account: who.address, to, data, value }); return 'no revert'; }
  catch (e) {
    // Hardhat puts the revert data in the message: "...custom error (return data: 0x...)"
    const d = e?.walk?.((x) => typeof x?.data === 'string')?.data || JSON.stringify(e).match(/return data: (0x[0-9a-fA-F]+)/)?.[1];
    try { return decodeErrorResult({ abi: errAbi, data: d }).errorName; } catch { return (e.shortMessage || e.message).slice(0, 90); }
  }
};
const mod = (fn, args) => encodeFunctionData({ abi: MOD.abi, functionName: fn, args });
const tok = (fn, args) => encodeFunctionData({ abi: TOK.abi, functionName: fn, args });
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

// The owner's own Safe transaction: threshold 1, signature "approved by msg.sender" (v = 1).
const ownerTx = (owner, safe, to, data, value = 0n) => send(owner, safe, encodeFunctionData({
  abi: SAFE_ABI, functionName: 'execTransaction',
  args: [to, value, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, pad(owner.address, { size: 32 }) + '0'.repeat(64) + '01'],
}));

console.log('fork block', await pub.getBlockNumber());
const [deployer, owner, agent, friend, stranger] = await Promise.all([wallet(), wallet(), wallet(), wallet('0'), wallet('0')]);
const griffin = privateKeyToAccount(generatePrivateKey());
const module = await deploy(deployer, MOD);
const token = await deploy(deployer, TOK);
const router = await deploy(deployer, ROUTER);
await raw('hardhat_setBalance', [router, toHex(parseEther('5'))]);
ok('module deployed', !!module, module);

// ---- create a Safe that enables the module and writes its charter in one transaction
const E = (n) => parseEther(String(n));
const limits = [{ perMove: E(100), perDay: E(150) }];
const charterArgs = [agent.address, griffin.address, E(0.5), E(1), [friend.address], [token], limits, [router]];
const initializer = encodeFunctionData({ abi: SAFE_ABI, functionName: 'setup', args: [[owner.address], 1n, module, mod('setupSafe', charterArgs), FALLBACK, zeroAddress, 0n, zeroAddress] });
const created = await send(owner, FACTORY, encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createProxyWithNonce', args: [SAFE_L2, initializer, BigInt(Date.now())] }));
const safe = created.logs.map((l) => { try { return decodeEventLog({ abi: FACTORY_ABI, ...l }); } catch { return null; } }).find((e) => e?.eventName === 'ProxyCreation').args.proxy;
ok('Safe created through the real factory', created.status === 'success', safe);
ok('module enabled at creation', await read(safe, SAFE_ABI, 'isModuleEnabled', [module]));
const ch = await read(module, MOD.abi, 'charters', [safe]);
ok('charter written at creation', ch[0] === agent.address && ch[1] === griffin.address && ch[4] === 1n, `version ${ch[4]}`);
ok('owner is the only Safe owner', (await read(safe, SAFE_ABI, 'getOwners')).join() === owner.address);
ok('setupSafe refuses a direct call', (await reason(stranger, module, mod('setupSafe', charterArgs))) === 'OnlyDelegateCall');
await send(owner, safe, '0x', E(3));
await send(deployer, token, tok('mint', [safe, E(1000)]));

// ---- the agent's moves, each signed by Griffin
const types = { Move: [{ name: 'safe', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'dataHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
const domain = { name: 'GRIFFIN', version: '1', chainId: 4663, verifyingContract: module };
// from the chain's clock: the tests move it forward a day
const deadline = async () => (await pub.getBlock()).timestamp + 3600n;
const sign = async (to, value, data, opt = {}) => {
  const nonce = opt.nonce ?? (await read(module, MOD.abi, 'nonces', [safe]));
  const dl = opt.deadline ?? (await deadline());
  const sig = await (opt.signer || griffin).signTypedData({ domain, types, primaryType: 'Move', message: { safe, to, value, dataHash: keccak256(data), nonce, deadline: dl } });
  return { dl, sig, nonce };
};
const exec = async (to, value, data, opt = {}) => {
  const { dl, sig } = await sign(to, value, data, opt);
  return mod('execute', [safe, to, value, data, dl, sig]);
};
const move = async (to, value, data = '0x', opt = {}) => {
  const call = await exec(to, value, data, opt);
  const why = await reason(opt.from || agent, module, call);
  lastWhy = why;
  if (why !== 'no revert') return why;
  const r = await send(opt.from || agent, module, call);
  return r.status === 'success' ? 'ok' : 'reverted';
};

const digest = await read(module, MOD.abi, 'moveDigest', [safe, friend.address, 1n, '0x', 0n, 5n]);
const local = keccak256(`0x1901${(await read(module, MOD.abi, 'DOMAIN_SEPARATOR')).slice(2)}${keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }],
  [keccak256(new TextEncoder().encode('Move(address safe,address to,uint256 value,bytes32 dataHash,uint256 nonce,uint256 deadline)')), safe, friend.address, 1n, keccak256('0x'), 0n, 5n])).slice(2)}`);
ok('moveDigest matches EIP-712 off chain', digest === local);

ok('0.3 ETH to the listed friend', (await move(friend.address, E(0.3))) === 'ok');
ok('friend got it', (await pub.getBalance({ address: friend.address })) === E(0.3));
ok('0.1 ETH to a stranger is refused', (await move(stranger.address, E(0.1))) === 'NotRecipient');
ok('0.6 ETH is over the per move limit', (await move(friend.address, E(0.6))) === 'OverMove');
ok('0.4 more passes (0.7 of 1 today)', (await move(friend.address, E(0.4))) === 'ok');
ok('0.4 again is over the day', (await move(friend.address, E(0.4))) === 'OverDay');
ok('spentToday reads 0.7 ETH', (await read(module, MOD.abi, 'spentToday', [safe, zeroAddress])) === E(0.7));

ok('50 tokens to the friend', (await move(token, 0n, tok('transfer', [friend.address, E(50)]))) === 'ok');
ok('tokens to a stranger are refused', (await move(token, 0n, tok('transfer', [stranger.address, E(1)]))) === 'NotRecipient');
ok('120 tokens are over the per move limit', (await move(token, 0n, tok('transfer', [friend.address, E(120)]))) === 'OverMove');
ok('approve a stranger is refused', (await move(token, 0n, tok('approve', [stranger.address, E(1)]))) === 'NotAllowed');
ok('transferFrom on the token is refused', (await move(token, 0n, tok('transferFrom', [safe, stranger.address, E(1)]))) === 'NotAllowed');
ok('approve the listed router for 60', (await move(token, 0n, tok('approve', [router, E(60)]))) === 'ok');
ok('token day total is 110', (await read(module, MOD.abi, 'spentToday', [safe, token])) === E(110));
ok('approve 50 more is over the day (160 > 150)', (await move(token, 0n, tok('approve', [router, E(50)]))) === 'OverDay');
const sell = encodeFunctionData({ abi: ROUTER.abi, functionName: 'sell', args: [token, E(60), E(0.2)] });
const before = await pub.getBalance({ address: safe });
ok('a swap through the listed router', (await move(router, 0n, sell)) === 'ok');
ok('the swap paid ETH back to the Safe', (await pub.getBalance({ address: safe })) - before === E(0.2));
ok('a call to an unlisted contract is refused', (await move(stranger.address, 0n, '0x12345678')) === 'NotAllowed');

// ---- calls that would act as the Safe itself
const addOwner = encodeFunctionData({ abi: SAFE_ABI, functionName: 'addOwnerWithThreshold', args: [agent.address, 1n] });
ok('the agent cannot call the Safe (add itself as owner)', (await move(safe, 0n, addOwner)) === 'SelfCall');
ok('the agent cannot rewrite its charter through the module', (await move(module, 0n, mod('setGriffin', [zeroAddress]))) === 'SelfCall');

// ---- signatures
ok('a stranger cannot call execute', (await move(friend.address, E(0.01), '0x', { from: stranger })) === 'NotAgent');
ok('a move signed by another key is refused', (await move(friend.address, E(0.01), '0x', { signer: privateKeyToAccount(generatePrivateKey()) })) === 'BadSignature');
const n = await read(module, MOD.abi, 'nonces', [safe]);
ok('a signature for an old nonce is refused', (await move(friend.address, E(0.01), '0x', { nonce: n - 1n })) === 'BadSignature');
ok('an expired move is refused', (await move(friend.address, E(0.01), '0x', { deadline: 1n })) === 'Expired');
{
  const { dl, sig } = await sign(friend.address, E(0.01), '0x');
  const tampered = mod('execute', [safe, friend.address, E(0.02), '0x', dl, sig]);
  ok('changing the amount after Griffin signed is refused', (await reason(agent, module, tampered)) === 'BadSignature');
}

// ---- Griffin's simulation: GriffinSim placed by a state override, marked as a module of the Safe
const simAddr = '0x00000000000000000000000000000000006f1ff1';
const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [simAddr, 1n]));
const simulate = async (to, value, data, tokens) => {
  const r = await raw('eth_call', [{ from: agent.address, to: simAddr, data: encodeFunctionData({ abi: SIM.abi, functionName: 'simulate', args: [safe, to, value, data, tokens] }) }, 'latest',
    { [simAddr]: { code: SIM.deployedBytecode }, [safe]: { stateDiff: { [slot]: pad('0x01', { size: 32 }) } } }]);
  return decodeFunctionResult({ abi: SIM.abi, functionName: 'simulate', data: r });
};
{
  const [okSim, , ethDelta, deltas] = await simulate(router, 0n, encodeFunctionData({ abi: ROUTER.abi, functionName: 'sell', args: [token, 0n, E(0.1)] }), [token]);
  ok('simulation runs the move through the Safe', okSim && ethDelta === E(0.1) && deltas[0] === 0n, `eth ${ethDelta} token ${deltas[0]}`);
  const [okT, , , d2] = await simulate(token, 0n, tok('transfer', [friend.address, E(5)]), [token]);
  ok('simulation sees tokens leaving', okT && d2[0] === -E(5));
  const [okF] = await simulate(token, 0n, tok('transfer', [friend.address, E(10_000)]), [token]);
  ok('simulation reports a failing move', okF === false);
  ok('simulation left the chain as it was', (await read(token, TOK.abi, 'balanceOf', [safe])) === E(1000) - E(50) - E(60));
}

// ---- the owner's powers, as plain Safe transactions
await ownerTx(owner, safe, module, mod('setGriffin', [zeroAddress]));
ok('without Griffin the charter alone decides (1.1 > 1 a day)', (await move(friend.address, E(0.4), '0x', { signer: privateKeyToAccount(generatePrivateKey()) })) === 'OverDay');
await raw('evm_increaseTime', [86400]); await raw('evm_mine');
ok('next day: 0.1 ETH with no Griffin signature', (await move(friend.address, E(0.1), '0x', { signer: privateKeyToAccount(generatePrivateKey()) })) === 'ok');
const agent2 = await wallet();
await ownerTx(owner, safe, module, mod('setAgent', [agent2.address]));
ok('the old agent is out after the owner swaps the key', (await move(friend.address, E(0.01))) === 'NotAgent');
ok('the new agent can move', (await move(friend.address, E(0.01), '0x', { from: agent2 })) === 'ok');
await ownerTx(owner, safe, module, mod('setCharter', [agent2.address, griffin.address, E(0.5), E(1), [], [], [], []]));
ok('a new charter drops the old recipients', (await move(friend.address, E(0.01), '0x', { from: agent2 })) === 'NotRecipient');
ok('a new charter drops the old token limits', (await move(token, 0n, tok('transfer', [friend.address, E(1)]), { from: agent2 })) === 'NotAllowed');
await ownerTx(owner, safe, safe, encodeFunctionData({ abi: SAFE_ABI, functionName: 'disableModule', args: ['0x0000000000000000000000000000000000000001', module] }));
ok('owner disables the module alone', !(await read(safe, SAFE_ABI, 'isModuleEnabled', [module])));
await ownerTx(owner, safe, module, mod('setCharter', [agent2.address, griffin.address, E(0.5), E(1), [friend.address], [], [], []]));
const off = await reason(agent2, module, await exec(friend.address, E(0.01), '0x'));
ok('with the module disabled nothing moves', off !== 'no revert', off);
ok('only the Safe writes its own charter', (await read(module, MOD.abi, 'charters', [stranger.address]))[4] === 0n);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
