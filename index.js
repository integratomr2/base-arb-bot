import { ethers } from "ethers";

const CONFIG = {
  RPC_URL: process.env.BASE_RPC_URL || "https://base-mainnet.g.alchemy.com/v2/alch_xGpsTWPEHzlsZl1ynhV6m",
  EXECUTOR_ADDRESS: "0xc7467c2cc9200a1437ba32d4647be3dfd4f1a72d",
  MIN_SPREAD_THRESHOLD: 0.60, // 0.60% total DEX fee hurdle
  SCAN_AMOUNT_USD: 2500,
};

const POOLS = [
  { 
    symbol: "WETH/USDC", 
    aeroPool: "0xcDAC0d6c6C59727a65F871236188350531885C43", 
    uniPool: "0x6c561B446416E1A00E8E93E221854d6eA4171372", 
    dec0: 18, 
    dec1: 6 
  },
  { 
    symbol: "VIRTUAL/WETH", 
    aeroPool: "0x21594b992F68495dD28d605834b58889d0a727c7", 
    uniPool: "0x1D4daB3f27C7F656b6323C1D6Ef713b48A8f72F1", 
    dec0: 18, 
    dec1: 18 
  }
];

const AERO_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"
];
const UNI_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
];

async function main() {
  console.log("==================================================");
  console.log("   BASE FLASH LOAN DEX ARB SCANNER (24/7 ACTIVE)  ");
  console.log("==================================================");
  console.log(`RPC Endpoint: Alchemy Base`);
  console.log(`Executor Contract: ${CONFIG.EXECUTOR_ADDRESS}`);
  console.log(`Fee Hurdle: ${CONFIG.MIN_SPREAD_THRESHOLD}%`);
  console.log(`Trade Size: $${CONFIG.SCAN_AMOUNT_USD}`);
  console.log(`Listening to Base blocks...\n`);

  const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  let isScanning = false;

  provider.on("block", async (blockNumber) => {
    if (isScanning) return;
    isScanning = true;

    try {
      const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
      let bestSpread = 0;
      let topPair = "";
      let topRoute = "";

      for (const pool of POOLS) {
        try {
          const aero = new ethers.Contract(pool.aeroPool, AERO_ABI, provider);
          const uni = new ethers.Contract(pool.uniPool, UNI_ABI, provider);

          const [res, slot] = await Promise.all([
            aero.getReserves().catch(() => null),
            uni.slot0().catch(() => null)
          ]);

          if (!res || !slot) continue;

          const r0 = Number(res[0]) / (10 ** pool.dec0);
          const r1 = Number(res[1]) / (10 ** pool.dec1);
          if (r0 <= 0 || r1 <= 0) continue;
          const aeroPrice = r1 / r0;

          const sqrtP = Number(slot[0]);
          const uniPrice = ((sqrtP / (2 ** 96)) ** 2) * (10 ** (pool.dec0 - pool.dec1));
          if (aeroPrice <= 0 || uniPrice <= 0) continue;

          const diff = Math.abs(aeroPrice - uniPrice);
          const minP = Math.min(aeroPrice, uniPrice);
          const spreadPct = (diff / minP) * 100;

          if (spreadPct > bestSpread) {
            bestSpread = spreadPct;
            topPair = pool.symbol;
            topRoute = aeroPrice < uniPrice ? "Buy Aero -> Sell Uni" : "Buy Uni -> Sell Aero";
          }

          if (spreadPct >= CONFIG.MIN_SPREAD_THRESHOLD) {
            const netPct = (spreadPct - CONFIG.MIN_SPREAD_THRESHOLD).toFixed(2);
            const estNetUsd = (((spreadPct - CONFIG.MIN_SPREAD_THRESHOLD) / 100) * CONFIG.SCAN_AMOUNT_USD - 0.15).toFixed(2);
            console.log(`🔥 [PROFIT DISLOCATION] ${pool.symbol} Spread: ${spreadPct.toFixed(2)}% | Net: +${netPct}% (~+$${estNetUsd}) | Route: ${topRoute}`);
          }
        } catch (_) {}
      }

      console.log(`[${timestamp} | Block ${blockNumber}] Best: ${topPair || "scanning"} (${bestSpread.toFixed(2)}%) | Hurdle: 0.60%`);
    } catch (err) {
      console.error("Scan loop error:", err.message);
    } finally {
      isScanning = false;
    }
  });
}

main().catch(console.error);
