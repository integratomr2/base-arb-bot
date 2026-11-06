import { ethers } from "ethers";

const CONFIG = {
  RPC_URL: process.env.BASE_RPC_URL || "https://base-mainnet.g.alchemy.com/v2/alch_xGpsTWPEHzlsZl1ynhV6m",
  EXECUTOR_ADDRESS: "0x2aEd98DC6B27B9d2f815F6Bf4a27B069d8E565e6",
  BURNER_PRIVATE_KEY: process.env.BURNER_PRIVATE_KEY || "",
  MIN_SPREAD_THRESHOLD: 0.60, // 0.60% total DEX fee hurdle
  SCAN_AMOUNT_USD: 2500,
  BENEFICIARY: "0x8e4bfc7253c7d5584d9b13fa786a3a78c243cebe"
};

const UNI_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const AERO_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";

const POOLS = [
  { 
    symbol: "WETH/USDC", 
    tokenBorrowed: "0x4200000000000000000000000000000000000006", // WETH
    tokenIntermediate: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    aeroPool: "0xcDAC0d6c6C59727a65F871236188350531885C43", 
    uniPool: "0x6c561B446416E1A00E8E93E221854d6eA4171372", 
    dec0: 18, 
    dec1: 6,
    feeUni: 500
  },
  { 
    symbol: "VIRTUAL/WETH", 
    tokenBorrowed: "0x4200000000000000000000000000000000000006", // WETH
    tokenIntermediate: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", // VIRTUAL
    aeroPool: "0x21594b992F68495dD28d605834b58889d0a727c7", 
    uniPool: "0x1D4daB3f27C7F656b6323C1D6Ef713b48A8f72F1", 
    dec0: 18, 
    dec1: 18,
    feeUni: 3000
  }
];

const AERO_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"
];
const UNI_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
];
const EXECUTOR_ABI = [
  "function owner() external view returns (address)",
  "function caller() external view returns (address)",
  "function executeArb((address tokenBorrowed, uint256 amountBorrowed, address routerBuy, bytes buyCalldata, address tokenIntermediate, address routerSell, bytes sellCalldata, uint256 minProfit) params) external"
];
const UNI_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];
const AERO_ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, (address from, address to, bool stable)[] routes, address toAddress, uint deadline) external returns (uint[] amounts)"
];

async function main() {
  console.log("==================================================");
  console.log("   BASE FLASH LOAN DEX ARB SCANNER V2 (LIVE)      ");
  console.log("==================================================");
  console.log(`RPC Endpoint: Alchemy Base`);
  console.log(`Executor V2 Contract: ${CONFIG.EXECUTOR_ADDRESS}`);
  console.log(`Profit Beneficiary: ${CONFIG.BENEFICIARY}`);
  console.log(`Fee Hurdle: ${CONFIG.MIN_SPREAD_THRESHOLD}%`);
  console.log(`Trade Size: $${CONFIG.SCAN_AMOUNT_USD}`);

  const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);

  let burnerSigner = null;
  if (CONFIG.BURNER_PRIVATE_KEY) {
    burnerSigner = new ethers.Wallet(CONFIG.BURNER_PRIVATE_KEY, provider);
    console.log(`Burner Execution Wallet: ${burnerSigner.address}`);
    const balance = await provider.getBalance(burnerSigner.address);
    console.log(`Burner Gas Reserve: ${ethers.formatEther(balance)} ETH`);
  } else {
    console.log("Warning: No BURNER_PRIVATE_KEY set, execution disabled.");
  }

  const executor = new ethers.Contract(CONFIG.EXECUTOR_ADDRESS, EXECUTOR_ABI, burnerSigner || provider);
  const uniRouterContract = new ethers.Contract(UNI_ROUTER, UNI_ROUTER_ABI);
  const aeroRouterContract = new ethers.Contract(AERO_ROUTER, AERO_ROUTER_ABI);

  console.log(`Monitoring Base blocks for dislocations...\n`);

  let isScanning = false;

  provider.on("block", async (blockNumber) => {
    if (isScanning) return;
    isScanning = true;

    try {
      const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
      let bestSpread = 0;
      let topPair = "";

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
          }

          if (spreadPct >= CONFIG.MIN_SPREAD_THRESHOLD) {
            const netPct = (spreadPct - CONFIG.MIN_SPREAD_THRESHOLD).toFixed(2);
            const estNetUsd = (((spreadPct - CONFIG.MIN_SPREAD_THRESHOLD) / 100) * CONFIG.SCAN_AMOUNT_USD - 0.15).toFixed(2);
            console.log(`🔥 [PROFIT DISLOCATION] ${pool.symbol} Spread: ${spreadPct.toFixed(2)}% | Net: +${netPct}% (~+$${estNetUsd})`);

            if (burnerSigner && Number(estNetUsd) > 0.50) {
              const borrowWethAmount = ethers.parseEther((CONFIG.SCAN_AMOUNT_USD / 2240).toFixed(4));
              const buyOnUni = uniPrice < aeroPrice;

              let routerBuy = buyOnUni ? UNI_ROUTER : AERO_ROUTER;
              let routerSell = buyOnUni ? AERO_ROUTER : UNI_ROUTER;
              let buyCalldata = "";
              let sellCalldata = "";
              const deadline = Math.floor(Date.now() / 1000) + 120;

              if (buyOnUni) {
                buyCalldata = uniRouterContract.interface.encodeFunctionData("exactInputSingle", [{
                  tokenIn: pool.tokenBorrowed,
                  tokenOut: pool.tokenIntermediate,
                  fee: pool.feeUni,
                  recipient: CONFIG.EXECUTOR_ADDRESS,
                  amountIn: borrowWethAmount,
                  amountOutMinimum: 0,
                  sqrtPriceLimitX96: 0
                }]);
                sellCalldata = aeroRouterContract.interface.encodeFunctionData("swapExactTokensForTokens", [
                  0,
                  0,
                  [{ from: pool.tokenIntermediate, to: pool.tokenBorrowed, stable: false }],
                  CONFIG.EXECUTOR_ADDRESS,
                  deadline
                ]);
              }

              const params = {
                tokenBorrowed: pool.tokenBorrowed,
                amountBorrowed: borrowWethAmount,
                routerBuy,
                buyCalldata,
                tokenIntermediate: pool.tokenIntermediate,
                routerSell,
                sellCalldata,
                minProfit: ethers.parseEther("0.0001") // ~$0.22 min profit hurdle
              };

              console.log(`⚡ Simulating flash arb on-chain for ${pool.symbol}...`);
              try {
                // Static call simulates execution without broadcasting or spending gas
                await executor.executeArb.staticCall(params);
                console.log(`✅ Simulation passed! Broadcasting transaction...`);
                const tx = await executor.executeArb(params, { gasLimit: 550000 });
                console.log(`🚀 Tx Broadcast: https://basescan.org/tx/${tx.hash}`);
                await tx.wait(1);
                console.log(`🎉 Flash arb confirmed & profit swept to ${CONFIG.BENEFICIARY}!`);
              } catch (simErr) {
                console.log(`Simulation check reverted: ${simErr.reason || "insufficient profit at execution"}`);
              }
            }
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
