// Compiles GriffinModule (deployed), GriffinSim (eth_call only) and the test mocks with solc 0.8.24
// (optimizer 200, viaIR, cancun) into build/*.json, plus the Standard JSON input of the module for Sourcify.
import solc from 'solc';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const src = (p) => ({ content: readFileSync(new URL(p, import.meta.url), 'utf8') });
const settings = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun' };
const input = {
  language: 'Solidity',
  sources: { 'GriffinModule.sol': src('./GriffinModule.sol'), 'GriffinSim.sol': src('./GriffinSim.sol'), 'test/MockToken.sol': src('./test/MockToken.sol') },
  settings: { ...settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.methodIdentifiers'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors || []) if (e.severity === 'error' || !/SPDX|unreachable/.test(e.message)) console.log(e.severity, e.formattedMessage);
if ((out.errors || []).some((e) => e.severity === 'error')) process.exit(1);
mkdirSync(new URL('./build/', import.meta.url), { recursive: true });
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    writeFileSync(new URL(`./build/${name}.json`, import.meta.url), JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object, selectors: c.evm.methodIdentifiers }, null, 1));
    console.log(name, 'runtime', c.evm.deployedBytecode.object.length / 2, 'bytes', file);
  }
}
writeFileSync(new URL('./GriffinModule.standard-input.json', import.meta.url), JSON.stringify({
  language: 'Solidity', sources: { 'GriffinModule.sol': src('./GriffinModule.sol') },
  settings: { ...settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } } },
}, null, 2));
// the one-button deploy page, served by deploy-server.mjs
const mod = JSON.parse(readFileSync(new URL('./build/GriffinModule.json', import.meta.url)));
writeFileSync(new URL('./deploy.html', import.meta.url), readFileSync(new URL('./deploy.template.html', import.meta.url), 'utf8').replace('__BYTECODE__', mod.bytecode));
console.log('wrote deploy.html');
