import 'dotenv/config';

// Birdeye prix spot & historique léger
// Env attendu: BIRDEYE_API_KEY
// Fonctions:
//  - getCurrentPrices(mints: string[]): Promise<Map<mint, price>>
//  - getPriceAt(mint: string, timestamp: number): Promise<number>
// Caching simple en mémoire pour éviter rate limit.

const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY;
const BIRDEYE_BASE = 'https://public-api.birdeye.so';

if (!BIRDEYE_KEY) {
  console.warn('WARN: Missing BIRDEYE_API_KEY; price calls will fail.');
}

const spotCache = new Map(); // mint -> { price, ts }
const historicalCache = new Map(); // key mint@minute -> price

async function birdeyeGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BIRDEYE_BASE}${path}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: { 'X-API-KEY': BIRDEYE_KEY }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Birdeye error ${res.status}: ${text}`);
  }
  return res.json();
}

export async function getCurrentPrices(mints) {
  const map = new Map();
  const now = Date.now();
  for (const mint of mints) {
    const cached = spotCache.get(mint);
    if (cached && now - cached.ts < 15_000) { // 15s cache
      map.set(mint, cached.price);
      continue;
    }
    try {
      const data = await birdeyeGet('/public/price', { address: mint });
      const price = data?.data?.value || 0;
      spotCache.set(mint, { price, ts: now });
      map.set(mint, price);
    } catch (e) {
      map.set(mint, 0);
    }
  }
  return map;
}

// Approx historique: Birdeye OHLC (candles). On prend la proche candle précédente.
export async function getPriceAt(mint, timestamp) {
  // Round timestamp to minute
  const minute = Math.floor(timestamp / 60_000) * 60_000;
  const key = `${mint}@${minute}`;
  if (historicalCache.has(key)) return historicalCache.get(key);
  try {
    // 1h range around timestamp for a candle close approximation
    const from = minute - 30 * 60_000;
    const to = minute + 30 * 60_000;
    const data = await birdeyeGet('/public/candles', {
      address: mint,
      interval: '1m',
      startTime: Math.floor(from / 1000),
      endTime: Math.floor(to / 1000)
    });
    const candles = data?.data || [];
    // Pick candle with time <= minute closest to minute
    let chosen = null;
    for (const c of candles) {
      const ctMs = c.time * 1000;
      if (ctMs <= minute) {
        if (!chosen || ctMs > chosen.time * 1000) chosen = c;
      }
    }
    const price = chosen ? chosen.close : 0;
    historicalCache.set(key, price);
    return price;
  } catch (e) {
    historicalCache.set(key, 0);
    return 0;
  }
}
