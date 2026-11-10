// Local fork of Robinhood Chain for testing GriffinModule against the real Safe v1.4.1 contracts.
module.exports = {
  networks: {
    hardhat: {
      chainId: 4663,
      hardfork: 'cancun',
      chains: { 4663: { hardforkHistory: { cancun: 0 } } },
      forking: { url: process.env.FORK_RPC || 'https://rpc.mainnet.chain.robinhood.com' },
      mining: { auto: true },
    },
  },
};
