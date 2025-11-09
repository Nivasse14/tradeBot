import 'dotenv/config';
import { wallets } from './wallets.js';
import { fetchAllAssetsForWallet, fetchNativeSolBalance } from './heliusClient.js';
import { getCurrentPrices, getPriceAt } from './priceClient.js';
import { fetchTransactions, extractSwapDeltas } from './tradeHistory.js';
import { CostBasis } from './costBasis.js';

// Base mint (pivot) to treat USDC as stable 1 USD
const STABLE_MINTS = new Set([
  // Common USDC / USDT mints (may adjust for mainnet changes)
  'Es9vMFrzaCERD4bYvfhijAbF4dVQVwQ851qw9YJz8F7', // USDT
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
]);

function tokenBalanceMap(assets) {
  const map = new Map(); // mint -> { qty, decimals }
  for (const a of assets) {
    if (a?.interface !== 'FungibleToken') continue;
    const mint = a.id;
    const decimals = a?.token_info?.decimals || a?.rawTokenAmount?.decimals || 0;
    const balanceRaw = a?.token_info?.balance || a?.rawTokenAmount?.tokenAmount || 0;
    const qty = Number(balanceRaw) / 10 ** decimals;
    map.set(mint, { qty, decimals });
  }
  return map;
}

async function buildCostBasisForWallet(wallet) {
  const txs = await fetchTransactions(wallet, 200, 5);
  const swaps = extractSwapDeltas(txs, wallet); // [{timestamp, deltas}]
  const basis = new CostBasis();

  for (const s of swaps) {
    // Separate inputs (negative) and outputs (positive)
    const outputs = s.deltas.filter(d => d.amount > 0);
    const inputs = s.deltas.filter(d => d.amount < 0);

    // For valuation we convert input and output legs to USD.
    // Strategy: find stable side; else if SOL involved, fetch SOL price at timestamp; else skip USD cost.

    const legs = [...inputs, ...outputs];
    // Collect mints that need historical price (non stable)
    const nonStableMints = legs.map(l => l.mint).filter(m => !STABLE_MINTS.has(m));
    const priceCache = new Map();
    for (const mint of nonStableMints) {
      if (!priceCache.has(mint)) {
        const p = await getPriceAt(mint, s.timestamp);
        priceCache.set(mint, p);
      }
    }

    // Compute total USD value of inputs and outputs
    const totalInUSD = inputs.reduce((acc, d) => {
      const absQty = Math.abs(d.amount) / 10 ** d.decimals;
      const price = STABLE_MINTS.has(d.mint) ? 1 : (priceCache.get(d.mint) || 0);
      return acc + absQty * price;
    }, 0);

    const totalOutUSD = outputs.reduce((acc, d) => {
      const qty = d.amount / 10 ** d.decimals;
      const price = STABLE_MINTS.has(d.mint) ? 1 : (priceCache.get(d.mint) || 0);
      return acc + qty * price;
    }, 0);

    // Treat outputs as buys (acquired tokens) with cost distributed proportionally from inputs USD.
    // Inputs act as sells for cost basis (realizing PnL relative to their stored cost).

    // First, register sells for input legs using their USD proceeds.
    for (const d of inputs) {
      const qty = Math.abs(d.amount) / 10 ** d.decimals;
      const priceUSD = STABLE_MINTS.has(d.mint) ? 1 : (priceCache.get(d.mint) || 0);
      basis.sell(d.mint, qty, priceUSD);
    }

    // Then, register buys for outputs distributing input USD value. If totalInUSD=0, skip (airdrop / unknown).
    if (totalInUSD > 0 && outputs.length) {
      for (const d of outputs) {
        const qty = d.amount / 10 ** d.decimals;
        const price = STABLE_MINTS.has(d.mint) ? 1 : (priceCache.get(d.mint) || 0);
        // cost proportion = (qty * price) / totalOutUSD * totalInUSD
        const legUSD = (qty * price / (totalOutUSD || 1)) * totalInUSD;
        basis.buy(d.mint, qty, legUSD);
      }
    }
  }

  return basis;
}

async function main() {
  if (!wallets?.length) {
    console.error('No wallets configured in wallets.js');
    process.exit(1);
  }
  for (const w of wallets) {
    console.log(`\n=== Portfolio for ${w} ===`);
    try {
      const assets = await fetchAllAssetsForWallet(w, 1000, 3);
      const balanceMap = tokenBalanceMap(assets); // mint -> {qty, decimals}
      // Inject native SOL balance as pseudo fungible asset if not already present
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      if (!balanceMap.has(SOL_MINT)) {
        const lamports = await fetchNativeSolBalance(w);
        const solQty = lamports / 1_000_000_000; // 1 SOL = 1e9 lamports
        if (solQty > 0) {
          balanceMap.set(SOL_MINT, { qty: solQty, decimals: 9 });
        }
      }
      const mints = [...balanceMap.keys()];
      const prices = await getCurrentPrices(mints);

      // Current value
      let currentValue = 0;
      for (const [mint, { qty }] of balanceMap.entries()) {
        const p = prices.get(mint) || 0;
        currentValue += qty * p;
      }

      // Cost basis & PnL
      const cb = await buildCostBasisForWallet(w);
      const unreal = cb.unrealized(prices);
      const realized = cb.realized();

      console.log(`Current Value USD: ${currentValue.toFixed(2)}`);
      console.log(`Realized PnL USD: ${realized.toFixed(2)}`);
      console.log(`Unrealized PnL USD: ${unreal.total.toFixed(2)}`);

      // Show top 5 positions by value
      const positions = mints.map(m => ({ mint: m, qty: balanceMap.get(m).qty, price: prices.get(m) || 0 }));
      positions.sort((a,b) => (b.qty * b.price) - (a.qty * a.price));
      console.log('Top positions:');
      for (const p of positions.slice(0,5)) {
        console.log(` - ${p.mint} qty=${p.qty.toFixed(4)} valueUSD=${(p.qty*p.price).toFixed(2)}`);
      }
      // If any positions have zero price, hint at missing price data.
      const zeroPrice = positions.filter(p => p.price === 0).slice(0,3).map(p => p.mint);
      if (zeroPrice.length) {
        console.log(`(Missing Birdeye price for: ${zeroPrice.join(', ')})`);
      }
    } catch (e) {
      console.error('Error computing portfolio:', e.message);
    }
  }
}

main();
