import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { wallets } from './wallets.js';
import { fetchTransactions, extractSwapDeltas } from './tradeHistory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function main() {
  const EXPORT_PARTIALS = process.env.EXPORT_PARTIALS === '1';
  const EXPORT_SWAPS = process.env.EXPORT_SWAPS === '1';
  console.log(`[export] partials=${EXPORT_PARTIALS ? 'on' : 'off'} swaps=${EXPORT_SWAPS ? 'on' : 'off'}`);
  if (!wallets?.length) {
    console.error('No wallets configured in wallets.js');
    process.exit(1);
  }
  const outDir = path.join(__dirname, 'out');
  await ensureDir(outDir);

  for (const w of wallets) {
    console.log(`\nFetching transactions for ${w} ...`);
    const all = [];
    let pageCount = 0;
    let before = undefined;
    const maxPages = 20; // allow deeper crawl with rate limit handling
    while (pageCount < maxPages) {
      // Build URL manually (similar to tradeHistory) to save incrementally.
      let url = new URL(`https://api.helius.xyz/v0/addresses/${w}/transactions`);
      url.searchParams.set('api-key', process.env.HELIUS_API_KEY || '');
      if (before) url.searchParams.set('before', before);
      url.searchParams.set('limit', '200');
      try {
        const res = await fetch(url.toString());
        if (!res.ok) {
          const txt = await res.text();
          if (/invalid query parameter limit/i.test(txt)) {
            // retry without limit
            url = new URL(`https://api.helius.xyz/v0/addresses/${w}/transactions`);
            url.searchParams.set('api-key', process.env.HELIUS_API_KEY || '');
            if (before) url.searchParams.set('before', before);
            const res2 = await fetch(url.toString());
            if (!res2.ok) {
              const txt2 = await res2.text();
              throw new Error(`Helius error ${res2.status}: ${txt2}`);
            }
            const page = await res2.json();
            if (!Array.isArray(page) || page.length === 0) break;
            all.push(...page);
            before = page[page.length - 1]?.signature;
          } else if (res.status === 429) {
            // Rate limited: exponential backoff then continue
            pageCount--; // do not count this attempt
            const delay = Math.min(2000 * Math.pow(2, pageCount), 15000);
            console.warn(`Rate limited (429). Backoff ${delay}ms ...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          } else {
            throw new Error(`Helius error ${res.status}: ${txt}`);
          }
        } else {
          const page = await res.json();
          if (!Array.isArray(page) || page.length === 0) break;
          all.push(...page);
          before = page[page.length - 1]?.signature;
        }
        pageCount++;
        // Periodic incremental save every 5 pages (optional)
        if (EXPORT_PARTIALS && pageCount % 5 === 0) {
          const partialPath = path.join(outDir, `${sanitize(w)}.transactions.partial.json`);
          await fs.writeFile(partialPath, JSON.stringify(all, null, 2), 'utf-8');
          console.log(`Partial save (${all.length} txs) -> ${partialPath}`);
        }
      } catch (e) {
        console.error(`Error page ${pageCount + 1} for ${w}:`, e.message);
        // If unrecoverable error, break to save what we have.
        break;
      }
    }
    try {
      const outPath = path.join(outDir, `${sanitize(w)}.transactions.json`);
      await fs.writeFile(outPath, JSON.stringify(all, null, 2), 'utf-8');
      console.log(`Saved ${all.length} transactions -> ${outPath}`);
      // Also save parsed swap-like deltas for easier comparison (optional)
      const swapsPath = path.join(outDir, `${sanitize(w)}.swaps.json`);
      if (EXPORT_SWAPS) {
        const swaps = extractSwapDeltas(all, w);
        await fs.writeFile(swapsPath, JSON.stringify(swaps, null, 2), 'utf-8');
        console.log(`Saved ${swaps.length} parsed swap entries -> ${swapsPath}`);
      } else {
        // If previously created, remove stale swaps file to keep only one canonical file
        try { await fs.unlink(swapsPath); } catch {}
      }
      // Clean up partial if disabled
      if (!EXPORT_PARTIALS) {
        const partialPath = path.join(outDir, `${sanitize(w)}.transactions.partial.json`);
        try { await fs.unlink(partialPath); } catch {}
      }
    } catch (e) {
      console.error(`Final save failed for ${w}:`, e.message);
    }
  }
}

main();
