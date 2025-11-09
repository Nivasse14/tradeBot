import 'dotenv/config';

const API_BASE = 'https://api.helius.xyz';
const API_KEY = process.env.HELIUS_API_KEY;
const DEBUG_HELIUS = process.env.DEBUG_HELIUS === '1' || process.env.DEBUG === '1';

if (!API_KEY) {
  console.warn('WARN: Missing HELIUS_API_KEY; trade history calls will fail.');
}

async function httpJson(url, attempt = 1) {
  if (DEBUG_HELIUS) console.log(`[helius-tx] GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    // Retry transient/server errors
    if ((res.status >= 500 || res.status === 429) && attempt < 3) {
      const backoff = 250 * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, backoff));
      return httpJson(url, attempt + 1);
    }
    throw new Error(`Helius tx API error ${res.status}: ${text}`);
  }
  return res.json();
}

// Paginate transactions for a wallet using the 'before' signature method.
export async function fetchTransactions(address, limit = 200, maxPages = 5) {
  let before = undefined;
  const all = [];
  for (let i = 0; i < maxPages; i++) {
    // Build URL; some deployments may reject unrecognized 'limit' param.
    let url = new URL(`${API_BASE}/v0/addresses/${address}/transactions`);
    url.searchParams.set('api-key', API_KEY);
    if (before) url.searchParams.set('before', before);
    url.searchParams.set('limit', String(limit));
    let page;
    try {
      page = await httpJson(url.toString());
    } catch (e) {
      if (/invalid query parameter limit/i.test(e.message)) {
        // Retry without limit parameter (use API default)
        if (DEBUG_HELIUS) console.warn('[helius-tx] Removing limit param due to server rejection');
        url = new URL(`${API_BASE}/v0/addresses/${address}/transactions`);
        url.searchParams.set('api-key', API_KEY);
        if (before) url.searchParams.set('before', before);
        page = await httpJson(url.toString());
      } else {
        throw e;
      }
    }
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    before = page[page.length - 1]?.signature; // next page anchor
    if (!before) break;
  }
  return all;
}

// Extract swap-like events and produce token deltas per tx for the wallet
// Return: [{ timestamp, signature, deltas: [{ mint, amount, decimals }] }]
export function extractSwapDeltas(transactions, wallet) {
  const out = [];
  for (const tx of transactions) {
    const ts = (tx?.timestamp || tx?.blockTime || 0) * 1000;
    const signature = tx?.signature || tx?.transaction?.signatures?.[0];
    let deltas = [];

    // Prefer enhanced events.swap if present
    const swapEvents = tx?.events?.swap;
    if (Array.isArray(swapEvents) && swapEvents.length) {
      for (const ev of swapEvents) {
        // Helius swap event has tokenInputs/Outputs arrays with token metadata
        const inputs = ev?.tokenInputs || [];
        const outputs = ev?.tokenOutputs || [];
        for (const inp of inputs) {
          if (!inp?.mint) continue;
          deltas.push({ mint: inp.mint, amount: -Number(inp?.tokenAmount || inp?.rawTokenAmount?.tokenAmount || 0), decimals: Number(inp?.rawTokenAmount?.decimals || inp?.decimals || 0) });
        }
        for (const outp of outputs) {
          if (!outp?.mint) continue;
          deltas.push({ mint: outp.mint, amount: Number(outp?.tokenAmount || outp?.rawTokenAmount?.tokenAmount || 0), decimals: Number(outp?.rawTokenAmount?.decimals || outp?.decimals || 0) });
        }
      }
    }

    // Fallback: parse tokenBalanceChanges if available
    if (deltas.length === 0 && Array.isArray(tx?.tokenTransfers)) {
      // tokenTransfers often include source/destination and token info
      // We compute deltas for the specific wallet only
      for (const tr of tx.tokenTransfers) {
        const isRecv = tr?.toUserAccount === wallet;
        const isSend = tr?.fromUserAccount === wallet;
        if (!isRecv && !isSend) continue;
        const mint = tr?.mint || tr?.tokenAddress;
        const decimals = Number(tr?.tokenStandard?.decimals || tr?.decimals || tr?.tokenAmount?.decimals || 0);
        const amt = Number(tr?.tokenAmount || tr?.tokenAmount?.tokenAmount || tr?.amount || 0);
        if (!mint || !Number.isFinite(amt)) continue;
        deltas.push({ mint, amount: isRecv ? amt : -amt, decimals });
      }
    }

    if (deltas.length) out.push({ timestamp: ts, signature, deltas });
  }
  return out;
}
