// Serves deploy.html on localhost (wallets do not inject into file:// pages) and waits for the page to report the new module.
// The address is checked on chain before it is written to deployed.json; then the server exits.
// Run: node deploy-server.mjs [port] [page]
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const port = Number(process.argv[2] || 47231);
const page = 'deploy.html';
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/deployed') {
    let body = '';
    for await (const c of req) body += c;
    try {
      const { address, tx, from } = JSON.parse(body);
      const receipt = await rpc('eth_getTransactionReceipt', [tx]);
      if (!receipt || receipt.status !== '0x1' || receipt.contractAddress?.toLowerCase() !== String(address).toLowerCase()) throw new Error('receipt does not match');
      writeFileSync(new URL('./deployed.json', import.meta.url), JSON.stringify({ address: receipt.contractAddress, tx, deployer: from, block: Number(BigInt(receipt.blockNumber)) }, null, 2));
      res.writeHead(200).end('ok');
      console.log('DEPLOYED', receipt.contractAddress, 'tx', tx, 'block', Number(BigInt(receipt.blockNumber)));
      setTimeout(() => process.exit(0), 300);
    } catch (e) { res.writeHead(400).end(e.message); console.log('bad report:', e.message); }
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(new URL('./' + page, import.meta.url)));
});
server.listen(port, () => console.log(`deploy page on http://localhost:${port}/`));
