// Local Cancun runtime only. No remote networks or private keys are configured.
module.exports = { solidity: '0.8.26', networks: { hardhat: { chainId: 31337, hardfork: 'cancun', allowUnlimitedContractSize: false, blockGasLimit: 30000000 } } };
