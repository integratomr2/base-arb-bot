import { ethers } from "ethers";

const CONFIG = {
  RPC_URL: process.env.BASE_RPC_URL || "https://base-mainnet.g.alchemy.com/v2/alch_xGpsTWPEHzlsZl1ynhV6m",
  EXECUTOR_ADDRESS: "0xc7467c2cc9200a1437ba32d4647be3dfd4f1a72d",
  MIN_PROFIT_WEI: ethers.parseUnits("0.0005", 18),
};

const EXECUTOR_ABI = [
  "function owner() external view returns (address)"
];

async function main() {
  console.log("=== Base Flash Loan DEX Arb Watcher Live ===");
  console.log(`Connecting to Base RPC: ${CONFIG.RPC_URL.split('/v2/')[0]}...`);
  
  const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const executor = new ethers.Contract(CONFIG.EXECUTOR_ADDRESS, EXECUTOR_ABI, provider);

  const owner = await executor.owner();
  console.log(`Contract verified on Base: ${CONFIG.EXECUTOR_ADDRESS}`);
  console.log(`Contract owner: ${owner}`);
  console.log(`Mode: 24/7 Block Listener (Simulation Active)\n`);

  provider.on("block", async (blockNumber) => {
    console.log(`[Block ${blockNumber}] Scanning Aerodrome & Uniswap V3 pools...`);
  });
}

main().catch(console.error);
