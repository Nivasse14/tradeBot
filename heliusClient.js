import 'dotenv/config';

const API_BASE = 'https://api.helius.xyz';
const DAS_RPC = 'https://mainnet.helius-rpc.com';
const API_KEY = process.env.HELIUS_API_KEY;
const DEBUG_HELIUS = process.env.DEBUG_HELIUS === '1' || process.env.DEBUG === '1';

function requireApiKey() {
  if (!API_KEY) {
    throw new Error('Missing HELIUS_API_KEY in environment. Add it to your .env file.');
  }
}

async function httpJson(url, { method = 'GET', headers = {}, body } = {}, attempt = 1) {
  if (DEBUG_HELIUS) {
    console.log(`[helius] ${method} ${url}${body ? ' body=' + JSON.stringify(body) : ''}`);
  }
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    // Simple retry for transient errors
    if ((res.status >= 500 || res.status === 429) && attempt < 3) {
      const backoff = 250 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, backoff));
      return httpJson(url, { method, headers, body }, attempt + 1);
    }
    const text = await res.text();
    throw new Error(`Helius API error ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Récupère les assets (tokens, NFTs, etc.) d'un wallet via Helius.
 * Preferred: DAS JSON-RPC getAssetsByOwner at https://mainnet.helius-rpc.com/?api-key=...
 * Fallback: REST balances at /v0/addresses/{address}/balances
 * @param {string} address - Adresse publique Solana (base58)
 * @param {{page?: number, limit?: number}} opts
 * @returns {Promise<{ items: any[] }>} – format Helius brut
 */
export async function fetchAssetsForWallet(address, opts = {}) {
  requireApiKey();
  const { page = 1, limit = 1000 } = opts;
  // 1) Try DAS JSON-RPC getAssetsByOwner
  try {
    const url = `${DAS_RPC}/?api-key=${API_KEY}`;
    const body = {
      jsonrpc: '2.0',
      id: 'assets',
      method: 'getAssetsByOwner',
      params: {
        ownerAddress: address,
        page,
        limit,
        displayOptions: { showFungible: true }
      }
    };
    const res = await httpJson(url, { method: 'POST', body });
    if (res?.result?.items) return res.result;
    if (Array.isArray(res?.items)) return res; // tolerate already-shaped
  } catch (e) {
    if (DEBUG_HELIUS) console.warn('[helius] DAS getAssetsByOwner failed:', e.message);
  }

  // 2) Fallback to REST balances and map to assets-like structure for FT
  try {
    const getUrl = new URL(`${API_BASE}/v0/addresses/${address}/balances`);
    getUrl.searchParams.set('api-key', API_KEY);
    const data = await httpJson(getUrl.toString(), { method: 'GET' });
    const tokens = Array.isArray(data?.tokens) ? data.tokens : [];
    const items = tokens.map(t => {
      const mint = t.mint || t.address || t.tokenAddress || t.id;
      const decimals = Number(t.decimals ?? t.tokenAmount?.decimals ?? 0);
      const raw = Number(t.amount ?? t.tokenAmount?.tokenAmount ?? 0);
      return {
        interface: 'FungibleToken',
        id: mint,
        token_info: { decimals, balance: raw }
      };
    });
    return { items };
  } catch (e) {
    if (DEBUG_HELIUS) console.warn('[helius] balances fallback failed:', e.message);
    throw e;
  }
}

/**
 * Récupère toutes les pages d'assets pour un wallet (jusqu'à maxPages)
 * @param {string} address
 * @param {number} pageSize
 * @param {number} maxPages
 * @returns {Promise<any[]>}
 */
export async function fetchAllAssetsForWallet(address, pageSize = 1000, maxPages = 10) {
  let page = 1;
  const all = [];
  while (page <= maxPages) {
    const data = await fetchAssetsForWallet(address, { page, limit: pageSize });
    const items = Array.isArray(data?.items) ? data.items : [];
    all.push(...items);
    if (items.length < pageSize) break; // pas d'autre page
    page += 1;
  }
  return all;
}

/**
 * Récupère les assets pour une liste de wallets.
 * @param {string[]} addresses
 * @param {{pageSize?: number, maxPages?: number}} opts
 * @returns {Promise<Map<string, any[]>>}
 */
export async function fetchAssetsForWallets(addresses, opts = {}) {
  const { pageSize = 1000, maxPages = 5 } = opts;
  const map = new Map();
  for (const addr of addresses) {
    const assets = await fetchAllAssetsForWallet(addr, pageSize, maxPages);
    map.set(addr, assets);
  }
  return map;
}

/**
 * Récupère le solde SOL natif (lamports) via RPC getBalance
 * @param {string} address
 * @returns {Promise<number>} lamports
 */
export async function fetchNativeSolBalance(address) {
  requireApiKey();
  const url = `${DAS_RPC}/?api-key=${API_KEY}`;
  const body = {
    jsonrpc: '2.0',
    id: 'balance',
    method: 'getBalance',
    params: [address, { commitment: 'confirmed' }]
  };
  try {
    const res = await httpJson(url, { method: 'POST', body });
    const lamports = Number(res?.result?.value ?? 0);
    return lamports;
  } catch (e) {
    if (DEBUG_HELIUS) console.warn('[helius] getBalance failed:', e.message);
    return 0;
  }
}
