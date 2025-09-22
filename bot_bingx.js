import 'dotenv/config';
import ccxt from 'ccxt';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';

/* =========================
   ENV & PARAMS
   ========================= */

const p = process.env;

const API_ID   = parseInt(p.TELEGRAM_API_ID || '', 10);
const API_HASH = (p.TELEGRAM_API_HASH || '').trim();
const STR_SESS = p.TELEGRAM_STRING_SESSION || '';
const CH_ID    = p.TELEGRAM_CHANNEL_ID || '';   // ex: -1002919838823
const CH_HANDLE= p.TELEGRAM_CHANNEL || '';      // ex: @baptiste_crypto

const EXCHANGE_ID = (p.EXCHANGE || 'bingx').toLowerCase();
const DRY         = (p.DRY_RUN || 'true').toLowerCase() === 'true';
const RISK        = parseFloat(p.RISK_PER_TRADE || '0.01'); // 1% par défaut
const POS_MODE    = (p.POSITION_MODE || 'oneway').toLowerCase(); // oneway|hedge
const V_BAL       = parseFloat(p.VIRTUAL_BALANCE_USDT || '1000'); // solde virtuel DRY
const SYMBOL_MAP  = p.SYMBOL_MAP || ''; // "LINK:LINK/USDT:USDT BTC:BTC/USDT:USDT"

if (!API_ID || !API_HASH || (!CH_ID && !CH_HANDLE)) {
  console.error('❌ .env incomplet (TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_CHANNEL_ID ou TELEGRAM_CHANNEL)');
  process.exit(1);
}
if (!DRY && (!p.BINGX_API_KEY || !p.BINGX_API_SECRET)) {
  console.error('❌ Clés API BingX manquantes (requis quand DRY_RUN=false)');
  process.exit(1);
}

/* =========================
   TELEGRAM CLIENT
   ========================= */

const client = new TelegramClient(
  new StringSession(STR_SESS),
  API_ID,
  API_HASH,
  { connectionRetries: 5 }
);

function prompt(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => { process.stdin.pause(); resolve(d.trim()); });
  });
}

async function ensureLoggedIn() {
  if (STR_SESS) {
    // déjà une session
    await client.connect();
    return;
  }
  await client.start({
    phoneNumber: async () => await prompt('📞 Numéro (+33…): '),
    phoneCode:   async () => await prompt('🔐 Code Telegram: '),
    password:    async () => await prompt('🔑 2FA (si activé, sinon Entrée): '),
    onError: (e) => console.error('Login error:', e)
  });
  const saved = client.session.save();
  console.log('\n✅ TELEGRAM_STRING_SESSION (à mettre dans .env):\n' + saved + '\n');
}

/* =========================
   EXCHANGE (ccxt BingX)
   ========================= */

const exOpts = {
  enableRateLimit: true,
  options: { defaultType: 'swap' } // perp USDT
};
if (!DRY) {
  exOpts.apiKey = p.BINGX_API_KEY;
  exOpts.secret = p.BINGX_API_SECRET;
}
const exchange = new ccxt[EXCHANGE_ID](exOpts);
await exchange.loadMarkets();

async function setPositionMode(mode = 'oneway') {
  try {
    if (exchange.has.setPositionMode) {
      await exchange.setPositionMode(mode === 'hedge');
      console.log('⚙️ Position mode =', mode);
    }
  } catch (e) {
    console.log('⚠️ setPositionMode:', e.message);
  }
}
await setPositionMode(POS_MODE);

/* =========================
   UTILS & PARSING
   ========================= */

const mapPairs = SYMBOL_MAP
  ? Object.fromEntries(SYMBOL_MAP.split(/\s+/).filter(Boolean).map(s => s.split(':')))
  : {};

function resolveBingxSymbolFromBase(base) {
  base = base.toUpperCase();
  const candidates = Object.values(exchange.markets).filter(m =>
    m.swap && m.linear === true && m.base === base && m.quote === 'USDT'
  );
  const withTag = candidates.find(m => m.symbol.includes(':USDT'));
  return (withTag || candidates[0] || {})?.symbol;
}
function normSymbol(symRaw) {
  const sym = symRaw.toUpperCase().replace('$', '');
  if (mapPairs[sym]) return mapPairs[sym];
  return resolveBingxSymbolFromBase(sym) || `${sym}/USDT:USDT`;
}

const HEAD_RE  = /^\s*(LONG|SHORT)\s+\$?([A-Z]+)\s*x?(\d+)\b/im;
const ENTRY_RE = /Entr[ée]e?\s*:\s*([0-9]+(?:\.[0-9]+)?(?:xx)?)/i;
const SL_RE    = /Stop\s*Loss\s*:\s*([0-9]+(?:\.[0-9]+)?)/i;
const TP_RE    = /TP\d+\s*:\s*([0-9]+(?:\.[0-9]+)?)/ig;

function pickPriceWithXX(template, mark) {
  if (!/xx$/i.test(template)) return parseFloat(template);
  const m = Number.isFinite(mark) && mark > 0 ? mark : 0;
  if (m === 0) return parseFloat(template.replace(/xx$/i, '00'));
  const s = m.toFixed(4);
  const last2 = s.split('.')[1]?.slice(0, 2) || '00';
  return parseFloat(template.replace(/xx$/i, last2));
}

function parseSignal(text, markPrice) {
  const h = text.match(HEAD_RE);
  if (!h) return null;
  const side = h[1].toUpperCase(); // LONG|SHORT
  const base = h[2].toUpperCase(); // ex: LINK
  const lev  = parseInt(h[3], 10); // leverage

  const e = text.match(ENTRY_RE);
  const s = text.match(SL_RE);
  const tps = [...text.matchAll(TP_RE)].map(m => parseFloat(m[1]));
  if (!e || !s || tps.length === 0) return null;

  const symbol = normSymbol(base);
  const entry  = pickPriceWithXX(e[1], markPrice);
  const sl     = parseFloat(s[1]);

  return { side, symbol, leverage: lev, entry, sl, tps };
}

/* =========================
   TRADING HELPERS
   ========================= */

async function getMarkPrice(symbol) {
  try {
    const t = await exchange.fetchTicker(symbol);
    return Number(t.last || t.close || 0);
  } catch { return 0; }
}
async function accountBalanceUSDT() {
  if (DRY) return V_BAL;
  const bal = await exchange.fetchBalance();
  return Math.max(bal.total?.USDT || 0, bal.total?.USD || 0);
}
function computeQty({ entry, sl }, balance, riskPct) {
  const risk = balance * riskPct;
  const dist = Math.abs(entry - sl);
  if (dist <= 0) throw new Error('Distance SL invalide');
  return Math.max(risk / dist, 0);
}
async function ensureLeverage(symbol, lev) {
  try {
    if (exchange.has.setLeverage) await exchange.setLeverage(lev, symbol);
  } catch (e) {
    console.log('⚠️ setLeverage:', e.message);
  }
}
function roundToMarket(symbol, { price, amount }) {
  const p = Number.isFinite(price) ? parseFloat(exchange.priceToPrecision(symbol, price)) : undefined;
  const a = Number.isFinite(amount) ? parseFloat(exchange.amountToPrecision(symbol, amount)) : undefined;
  return { price: p, amount: a };
}
function opposite(side) { return side === 'buy' ? 'sell' : 'buy'; }

async function placeStopLoss(symbol, sideOpp, qty, sl) {
  const trials = [
    { type: 'stop',    params: { stopPrice: sl, reduceOnly: true } },
    { type: 'market',  params: { stopPrice: sl, triggerPrice: sl, reduceOnly: true } },
    { type: 'market',  params: { stopLossPrice: sl, reduceOnly: true } },
  ];
  for (const t of trials) {
    try { await exchange.createOrder(symbol, t.type, sideOpp, qty, undefined, t.params); return true; }
    catch { /* try next */ }
  }
  console.log('⚠️ Stop-Loss: toutes les variantes ont échoué (vérifie permissions/position mode).');
  return false;
}

async function placeOrders(signal) {
  const symbol = signal.symbol;
  const side   = signal.side === 'LONG' ? 'buy' : 'sell';
  const sideOpp= opposite(side);

  await ensureLeverage(symbol, signal.leverage);

  const balance = await accountBalanceUSDT();
  let qty = computeQty(signal, balance, RISK);

  const entryR = roundToMarket(symbol, { price: signal.entry, amount: qty });
  qty = entryR.amount;
  const entryPx = entryR.price;

  const splits = [0.3, 0.3, 0.4];
  const tpQtys = splits.map(s => roundToMarket(symbol, { amount: qty * s }).amount);

  const report = {
    exchange: exchange.id,
    symbol,
    side,
    leverage: signal.leverage,
    qty,
    entry: entryPx,
    sl: signal.sl,
    tps: signal.tps
  };

  if (DRY) {
    console.log('🧪 [DRY-RUN] Orders:', JSON.stringify(report, null, 2));
    return report;
  }

  // Entrée LIMIT
  await exchange.createOrder(symbol, 'limit', side, qty, entryPx, {
    reduceOnly: false, timeInForce: 'GTC'
  });

  // Stop-Loss
  await placeStopLoss(symbol, sideOpp, qty, signal.sl);

  // Take Profits
  for (let i = 0; i < Math.min(signal.tps.length, tpQtys.length); i++) {
    const tpPx = roundToMarket(symbol, { price: signal.tps[i] }).price;
    try {
      await exchange.createOrder(symbol, 'limit', sideOpp, tpQtys[i], tpPx, {
        reduceOnly: true, timeInForce: 'GTC'
      });
    } catch (e) { console.log(`⚠️ TP${i+1} erreur:`, e.message); }
  }

  return report;
}

/* =========================
   MAIN
   ========================= */

async function main() {
  await ensureLoggedIn();

  // Résolution entité par ID ou handle
  let entity;
  if (CH_ID) {
    entity = await client.getEntity(BigInt(CH_ID));
  } else {
    entity = await client.getEntity(CH_HANDLE);
  }

  console.log(`📡 Écoute de ${CH_ID || CH_HANDLE} (DRY_RUN=${DRY})`);

  // Affiche les 5 derniers messages
  const history = await client.getMessages(entity, { limit: 5 });
  console.log('🕘 Derniers messages:');
  history.forEach((m, i) => console.log(`  ${i + 1}. ${(m?.message || '').replace(/\n/g, ' ⏎ ')}`));

  // Handler nouveaux messages
  const targetIdStr = entity.id?.toString?.();
  client.addEventHandler(async (update) => {
    if (!(update instanceof Api.UpdateNewMessage)) return;
    const msg = update.message;
    if (!msg || !msg.message) return;

    // Filtre par channel
    const pid = msg?.peerId?.channelId?.toString?.();
    if (targetIdStr && pid && pid !== targetIdStr) return;

    const text = msg.message;
    const head = text.match(HEAD_RE);
    if (!head) return;

    // mark price pour gérer 'xx'
    const base = (head[2] || '').toUpperCase();
    const symbolGuess = normSymbol(base);
    const mark = await getMarkPrice(symbolGuess);

    const signal = parseSignal(text, mark);
    if (!signal) { console.log('⏭️ Signal non reconnu:\n', text); return; }

    // Sanity check simple
    const maxTp = Math.max(...signal.tps), minTp = Math.min(...signal.tps);
    if (signal.side === 'LONG'  && !(signal.sl < signal.entry && signal.entry < maxTp)) { console.log('⚠️ Incohérence LONG:', signal); return; }
    if (signal.side === 'SHORT' && !(signal.sl > signal.entry && signal.entry > minTp)) { console.log('⚠️ Incohérence SHORT:', signal); return; }

    console.log('✅ Signal OK:', signal);
    try {
      const rep = await placeOrders(signal);
      console.log('✅ Placement OK:', rep);
    } catch (e) {
      console.log('❌ Erreur placement:', e.message);
    }
  });

  console.log('▶️ En écoute… (Ctrl+C pour quitter)');
  await new Promise(() => {}); // keep alive
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
