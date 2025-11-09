// FIFO cost basis engine per mint
// API:
//  - class CostBasis
//    - buy(mint, qty, costUSD)
//    - sell(mint, qty, priceUSD) -> returns realized PnL for this sale
//    - realized(): total realized PnL
//    - unrealized(currentPrices: Map<mint, price>): { total, byMint }

export class CostBasis {
  constructor() {
    this.lots = new Map(); // mint -> [{ qty, costUSD }]
    this.realizedPnl = 0;
  }

  buy(mint, qty, costUSD) {
    if (qty <= 0 || costUSD < 0) return;
    if (!this.lots.has(mint)) this.lots.set(mint, []);
    this.lots.get(mint).push({ qty, costUSD });
  }

  sell(mint, qty, priceUSD) {
    if (qty <= 0 || priceUSD < 0) return 0;
    const arr = this.lots.get(mint) || [];
    let remaining = qty;
    let realized = 0;

    while (remaining > 1e-12 && arr.length) {
      const lot = arr[0];
      const take = Math.min(remaining, lot.qty);
      const costPart = lot.costUSD * (take / lot.qty);
      const proceedsPart = priceUSD * take;
      realized += proceedsPart - costPart;
      lot.qty -= take;
      lot.costUSD -= costPart;
      remaining -= take;
      if (lot.qty <= 1e-12) arr.shift();
    }

    // if we sold more than we had (short) ignore excess silently
    this.lots.set(mint, arr);
    this.realizedPnl += realized;
    return realized;
  }

  realized() {
    return this.realizedPnl;
  }

  unrealized(currentPrices) {
    let total = 0;
    const byMint = {};
    for (const [mint, arr] of this.lots.entries()) {
      const price = currentPrices.get(mint) || 0;
      let u = 0;
      for (const lot of arr) {
        u += price * lot.qty - lot.costUSD;
      }
      byMint[mint] = u;
      total += u;
    }
    return { total, byMint };
  }
}
