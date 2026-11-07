import { ethers } from "ethers";

const CONFIG = {
  RPC_URL: process.env.BASE_RPC_URL || "https://base-mainnet.g.alchemy.com/v2/alch_xGpsTWPEHzlsZl1ynhV6m",
  EXECUTOR_ADDRESS: "0x2aEd98DC6B27B9d2f815F6Bf4a27B069d8E565e6",
  BURNER_PRIVATE_KEY: process.env.BURNER_PRIVATE_KEY || "",
  BENEFICIARY: "0x8e4bfc7253c7d5584d9b13fa786a3a78c243cebe",
  MIN_PROFIT_USD: 0.20,
  REFRESH_INTERVAL_MS: 2 * 60 * 60 * 1000 // auto-rotate fleet every 2 hours
};

const UNI_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const UNI_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const AERO_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const AERO_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

const WETH = "0x4200000000000000000000000000000000000006";

// Core high-volume anchors (always scanned)
const CORE_TOKENS = [
  { symbol: "USDC", addr: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", feeUni: 500 },
  { symbol: "VIRTUAL", addr: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", feeUni: 3000 },
  { symbol: "AERO", addr: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", feeUni: 3000 },
  { symbol: "DEGEN", addr: "0x4ED4e862860Be51AC13657B875920A4C83b60441", feeUni: 3000 },
  { symbol: "TOSHI", addr: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", feeUni: 3000 },
  { symbol: "BRETT", addr: "0x532f27101965dd16442e59d40670faf5ebb142e4", feeUni: 10000 },
  { symbol: "BNKR", addr: "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b", feeUni: 10000 }
];

// Active scanning fleet in memory (starts with core, refreshed dynamically)
let ACTIVE_TOKENS = [...CORE_TOKENS];

const TEST_SIZES_ETH = ["0.02", "0.05", "0.1", "0.25", "0.5"];

const EXECUTOR_ABI = [
  "function owner() external view returns (address)",
  "function caller() external view returns (address)",
  "function executeArb((address tokenBorrowed, uint256 amountBorrowed, address routerBuy, bytes buyCalldata, address tokenIntermediate, address routerSell, bytes sellCalldata, uint256 minProfit) params) external"
];
const UNI_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
];
const UNI_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];
const AERO_ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, (address from, address to, bool stable, address factory)[] routes) external view returns (uint[] amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, (address from, address to, bool stable)[] routes, address toAddress, uint deadline) external returns (uint[] amounts)"
];

// Autonomous market discovery: finds trending high-volume Base tokens paired with WETH
async function refreshDynamicFleet() {
  try {
    const res = await fetch("https://api.dexscreener.com/tokens/v1/base/0x4200000000000000000000000000000000000006");
    if (!res.ok) return;
    const pairs = await res.json();

    if (!Array.isArray(pairs)) return;

    // Filter for high volume (> $100k 24h), liquid (> $50k liquidity) WETH pairs on Base
    const candidateMap = new Map();
    for (const p of pairs) {
      if (!p.baseToken || !p.quoteToken) continue;
      const otherToken = p.baseToken.address.toLowerCase() === WETH.toLowerCase() ? p.quoteToken : p.baseToken;
      const addr = otherToken.address;
      const symbol = otherToken.symbol;

      if (addr.toLowerCase() === WETH.toLowerCase()) continue;
      if (CORE_TOKENS.some(c => c.addr.toLowerCase() === addr.toLowerCase())) continue;

      const vol = p.volume?.h24 || 0;
      const liq = p.liquidity?.usd || 0;

      if (vol > 100000 && liq > 50000) {
        if (!candidateMap.has(addr.toLowerCase())) {
          candidateMap.set(addr.toLowerCase(), {
            symbol,
            addr,
            feeUni: 3000,
            volume: vol
          });
        }
      }
    }

    const trending = Array.from(candidateMap.values())
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 2);

    ACTIVE_TOKENS = [...CORE_TOKENS, ...trending];
    console.log(`📡 [AUTONOMOUS ROTATOR] Fleet updated (${ACTIVE_TOKENS.length} tokens): ${ACTIVE_TOKENS.map(t => t.symbol).join(", ")}`);
  } catch (err) {
    console.log(`[AUTONOMOUS ROTATOR] Notice: Kept anchor fleet (${err.message})`);
  }
}

async function main() {
  console.log("==================================================");
  console.log(" BASE FLASH ARB ENGINE — AUTONOMOUS FLEET ROTATION");
  console.log("==================================================");
  console.log(`Executor V2: ${CONFIG.EXECUTOR_ADDRESS}`);
  console.log(`Beneficiary: ${CONFIG.BENEFICIARY}`);
  console.log(`Dynamic Sizing: $45 - $1,120 across all active pairs`);

  const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);

  let burnerSigner = null;
  if (CONFIG.BURNER_PRIVATE_KEY) {
    burnerSigner = new ethers.Wallet(CONFIG.BURNER_PRIVATE_KEY, provider);
    console.log(`Burner Wallet: ${burnerSigner.address}`);
    const balance = await provider.getBalance(burnerSigner.address);
    console.log(`Gas Reserve: ${ethers.formatEther(balance)} ETH`);
  }

  const executor = new ethers.Contract(CONFIG.EXECUTOR_ADDRESS, EXECUTOR_ABI, burnerSigner || provider);
  const quoter = new ethers.Contract(UNI_QUOTER, UNI_QUOTER_ABI, provider);
  const aeroRouter = new ethers.Contract(AERO_ROUTER, AERO_ROUTER_ABI, provider);
  const uniRouter = new ethers.Contract(UNI_ROUTER, UNI_ROUTER_ABI);

  await refreshDynamicFleet();
  setInterval(refreshDynamicFleet, CONFIG.REFRESH_INTERVAL_MS);

  console.log(`\nEngine live on Base. Listening for block events...\n`);

  let isScanning = false;

  provider.on("block", async (blockNumber) => {
    if (isScanning) return;
    isScanning = true;

    try {
      const timestamp = new Date().toISOString().split("T")[1].split(".")[0];

      for (const t of ACTIVE_TOKENS) {
        let bestProfitUsd = 0;
        let bestSizeWeth = null;
        let bestDirection = "";

        for (const sizeEth of TEST_SIZES_ETH) {
          const borrowAmt = ethers.parseEther(sizeEth);

          // Route 1: Uni -> Aero
          try {
            const q = await quoter.quoteExactInputSingle.staticCall({
              tokenIn: WETH, tokenOut: t.addr, amountIn: borrowAmt, fee: t.feeUni, sqrtPriceLimitX96: 0
            });
            const route = [{ from: t.addr, to: WETH, stable: false, factory: AERO_FACTORY }];
            const out = await aeroRouter["getAmountsOut(uint,(address,address,bool,address)[])"](q.amountOut, route);
            const netWeth = Number(ethers.formatEther(out[1])) - Number(sizeEth);
            const netUsd = netWeth * 2245;

            if (netUsd > bestProfitUsd) {
              bestProfitUsd = netUsd;
              bestSizeWeth = borrowAmt;
              bestDirection = "Uni->Aero";
            }
          } catch (_) {}

          // Route 2: Aero -> Uni
          try {
            const route = [{ from: WETH, to: t.addr, stable: false, factory: AERO_FACTORY }];
            const out = await aeroRouter["getAmountsOut(uint,(address,address,bool,address)[])"](borrowAmt, route);
            const q = await quoter.quoteExactInputSingle.staticCall({
              tokenIn: t.addr, tokenOut: WETH, amountIn: out[1], fee: t.feeUni, sqrtPriceLimitX96: 0
            });
            const netWeth = Number(ethers.formatEther(q.amountOut)) - Number(sizeEth);
            const netUsd = netWeth * 2245;

            if (netUsd > bestProfitUsd) {
              bestProfitUsd = netUsd;
              bestSizeWeth = borrowAmt;
              bestDirection = "Aero->Uni";
            }
          } catch (_) {}
        }

        if (bestProfitUsd > CONFIG.MIN_PROFIT_USD && burnerSigner) {
          console.log(`🔥 [OPPORTUNITY FOUND] ${t.symbol} | Optimal Size: ${ethers.formatEther(bestSizeWeth)} WETH | Net: +$${bestProfitUsd.toFixed(2)} | Route: ${bestDirection}`);

          const deadline = Math.floor(Date.now() / 1000) + 120;
          let routerBuy, buyCalldata, routerSell, sellCalldata;

          if (bestDirection === "Uni->Aero") {
            routerBuy = UNI_ROUTER;
            buyCalldata = uniRouter.interface.encodeFunctionData("exactInputSingle", [{
              tokenIn: WETH,
              tokenOut: t.addr,
              fee: t.feeUni,
              recipient: CONFIG.EXECUTOR_ADDRESS,
              amountIn: bestSizeWeth,
              amountOutMinimum: 0,
              sqrtPriceLimitX96: 0
            }]);
            routerSell = AERO_ROUTER;
            sellCalldata = aeroRouter.interface.encodeFunctionData("swapExactTokensForTokens", [
              0,
              0,
              [{ from: t.addr, to: WETH, stable: false }],
              CONFIG.EXECUTOR_ADDRESS,
              deadline
            ]);
          } else {
            routerBuy = AERO_ROUTER;
            buyCalldata = aeroRouter.interface.encodeFunctionData("swapExactTokensForTokens", [
              bestSizeWeth,
              0,
              [{ from: WETH, to: t.addr, stable: false }],
              CONFIG.EXECUTOR_ADDRESS,
              deadline
            ]);
            routerSell = UNI_ROUTER;
            sellCalldata = uniRouter.interface.encodeFunctionData("exactInputSingle", [{
              tokenIn: t.addr,
              tokenOut: WETH,
              fee: t.feeUni,
              recipient: CONFIG.EXECUTOR_ADDRESS,
              amountIn: 0,
              amountOutMinimum: 0,
              sqrtPriceLimitX96: 0
            }]);
          }

          const params = {
            tokenBorrowed: WETH,
            amountBorrowed: bestSizeWeth,
            routerBuy,
            buyCalldata,
            tokenIntermediate: t.addr,
            routerSell,
            sellCalldata,
            minProfit: ethers.parseEther("0.00005")
          };

          try {
            await executor.executeArb.staticCall(params);
            console.log(`✅ Simulation passed! Broadcasting live flash loan arb...`);
            const tx = await executor.executeArb(params, { gasLimit: 600000 });
            console.log(`🚀 Tx Broadcast: https://basescan.org/tx/${tx.hash}`);
            await tx.wait(1);
            console.log(`🎉 Flash arb filled & profit swept to ${CONFIG.BENEFICIARY}!`);
          } catch (simErr) {
            console.log(`Simulation safety check: aborted before gas spend (${simErr.reason || "slippage delta"})`);
          }
        }
      }

      console.log(`[${timestamp} | Block ${blockNumber}] Monitoring ${ACTIVE_TOKENS.length} pairs (${ACTIVE_TOKENS.map(t => t.symbol).join(",")}) with dynamic auto-sizing...`);
    } catch (err) {
      console.error("Scan loop error:", err.message);
    } finally {
      isScanning = false;
    }
  });
}

main().catch(console.error);
