import 'dotenv/config';
import { wallets } from './wallets.js';
import { fetchAllAssetsForWallet } from './heliusClient.js';

if (!process.env.HELIUS_API_KEY) {
  console.error('Missing HELIUS_API_KEY in environment. Create a .env with HELIUS_API_KEY=...');
  process.exit(1);
}

function summarizeAssets(assets) {
  const summary = { total: assets.length, tokens: 0, nfts: 0 };
  for (const a of assets) {
    const iface = a?.interface || a?.interfaceType || '';
    if (iface === 'FungibleToken') summary.tokens += 1;
    else if (iface === 'NonFungibleToken' || iface === 'ProgrammableNFT') summary.nfts += 1;
  }
  return summary;
}

(async () => {
  if (!wallets?.length) {
    console.error('wallets.js is empty. Please add wallet addresses to export const wallets = [ ... ]');
    process.exit(1);
  }

  for (const w of wallets) {
    console.log(`\n=== Wallet: ${w} ===`);
    try {
      const assets = await fetchAllAssetsForWallet(w, 1000, 5);
      const s = summarizeAssets(assets);
      console.log(`Assets: total=${s.total}, FT=${s.tokens}, NFT=${s.nfts}`);
      // Affiche un aperçu de quelques tokens fongibles
      const ft = assets.filter(a => a?.interface === 'FungibleToken').slice(0, 5);
      for (const t of ft) {
        const mint = t?.id || t?.token_info?.mint || t?.mint;
        const sym = t?.token_info?.symbol || t?.content?.metadata?.symbol || '';
        const name = t?.token_info?.name || t?.content?.metadata?.name || '';
        console.log(` - ${sym || name || 'token'} mint=${mint}`);
      }
    } catch (e) {
      console.error('Error fetching assets:', e.message);
    }
  }
})();
