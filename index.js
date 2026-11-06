import { ethers } from "ethers";

const CONFIG = {
  RPC_URL: process.env.BASE_RPC_URL || "https://base-mainnet.g.alchemy.com/v2/alch_xGpsTWPEHzlsZl1ynhV6m",
  EXECUTOR_ADDRESS: "0xc7467c2cc9200a1437ba32d4647be3dfd4f1a72d",
  MIN_SPREAD_THRESHOLD: 0.60, // 0.60% total DEX fee hurdle
  SCAN_AMOUNT_USD: 2500,
};

// Verified Base Token Addresses
const TOKENS = {
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  DEGEN: "0x4ed4E862860be51aC13657b875920a4C83B60441",
  VIRTUAL: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
  BRETT: "0x532f27101965dd16442E59d40670FaF5eBB142E4"
};

// Verified Pools on Base
const POOLS = [
  { symbol: "AERO/USDC", token0: TOKENS.AERO, token1: TOKENS.USDC, aeroPool: "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d", uniPool: "0x2223F9FE6246881345E6e65a5857fab8Fe03885d" },
  { symbol: "VIRTUAL/WETH", token0: TOKENS.VIRTUAL, token1: TOKENS.WETH, aeroPool: "0x47B0d1Ac461E38c35E17e923eFa7A9dCd766b4A2", uniPool: "0xB203Fe1E9646b10705E10aFF8C1d1A86A8f6153e" },
  { symbol: "DEGEN/WETH", token0: TOKENS.DEGEN, token1: TOKENS.WETH, aeroPool: "0xC9034c3E7FdeE47458F635d9685e1302A093D6f7", uniPool: "0xc9034c3e7fdee47458f635d9685e1302a093d6f7" },
  { symbol: "BRETT/WETH", token0: TOKENS.BRETT, token1: TOKENS.WETH, aeroPool: "0x47228834d8e57930811eC36154564883ea57E94B", uniPool: "0x25a9594e5088f1ce3dfdf232b6fb5684ce6efd64" }
];

const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
];

async function main() {
  console.log("==================================================");
  console.log("   BASE FLASH LOAN DEX ARB SCANNER (24/7 ACTIVE)  ");
  console.log("==================================================");
  console.log(`RPC Endpoint: Alchemy Base`);
  console.log(`Executor Contract: ${CONFIG.EXECUTOR_ADDRESS}`);
  console.log(`Fee Hurdle: ${CONFIG.MIN_SPREAD_THRESHOLD}% (0.3% Aero + 0.3% Uni)`);
  console.log(`Simulated Trade Size: $${CONFIG.SCAN_AMOUNT_USD}`);
  console.log(`Monitoring 4 core token pairs across Base blocks...\n`);

  const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);

  let isScanning = false;

  provider.on("block", async (blockNumber) => {
    if (isScanning) return; // Prevent overlapping scans
    isScanning = true;

    try {
      const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
      let bestSpread = 0;
      let topPair = "";
      let topRoute = "";

      for (const pool of POOLS) {
        try {
          const aeroContract = new ethers.Contract(pool.aeroPool, PAIR_ABI, provider);
          const uniContract = new ethers.Contract(pool.uniPool, PAIR_ABI, provider);

          const [aeroRes, uniSlot] = await Promise.all([
            aeroContract.getReserves().catch(() => null),
            uniContract.slot0().catch(() => null)
          ]);

          if (!aeroRes || !uniSlot) continue;

          // Price derivation
          const r0 = Number(aeroRes.reserve0);
          const r1 = Number(aeroRes.reserve1);
          if (r0 === 0 || r1 === 0) continue;
          const aeroPrice = r1 / r0;

          const sqrtPrice = Number(uniSlot.sqrtPriceX96);
          const uniPrice = (sqrtPrice / (2 ** 96)) ** 2;

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
            const estNetUsd = ((spreadPct - CONFIG.MIN_SPREAD_THRESHOLD) / 100 * CONFIG.SCAN_AMOUNT_USD - 0.15).toFixed(2);
            console.log(`🔥 [PROFIT DISLOCATION] ${pool.symbol} Spread: ${spreadPct.toFixed(2)}% | Net: +${netPct}% (~+$${estNetUsd}) | Route: ${topRoute}`);
          }
        } catch (e) {
          // ignore single pool read errors
        }
      }

      console.log(`[${timestamp} | Block ${blockNumber}] Best: ${topPair || "scanning"} (${bestSpread.toFixed(2)}%) | Spread hurdle: 0.60%`);
    } catch (err) {
      console.error(`Scan error:`, err.message);
    } finally {
      isScanning = false;
    }
  });
}

main().catch(console.error);
