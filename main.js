import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';

const {
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_CHANNEL,
  TELEGRAM_STRING_SESSION
} = process.env;

if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
  console.error('❌ Renseigne TELEGRAM_API_ID et TELEGRAM_API_HASH dans .env');
  process.exit(1);
}
if (!TELEGRAM_CHANNEL) {
  console.error('❌ Renseigne TELEGRAM_CHANNEL (ex: @nom_du_channel) dans .env');
  process.exit(1);
}
console.log('API_ID =', (process.env.TELEGRAM_API_ID || '').trim());
console.log('API_HASH len =', (process.env.TELEGRAM_API_HASH || '').trim().length);

const client = new TelegramClient(
  new StringSession(TELEGRAM_STRING_SESSION || ''),
  parseInt(TELEGRAM_API_ID, 10),
  TELEGRAM_API_HASH,
  { connectionRetries: 5 }
);

function prompt(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      resolve(d.trim());
    });
  });
}

async function ensureLoggedIn() {
  if (!TELEGRAM_STRING_SESSION) {
    console.log('📲 Première connexion Telegram — suis les instructions ci-dessous.');
  }
  await client.start({
    phoneNumber: async () => await prompt('📞 Numéro de téléphone (+33…): '),
    phoneCode: async () => await prompt('🔐 Code reçu par Telegram: '),
    password: async () => await prompt('🔑 Mot de passe 2FA (si activé): '),
    onError: (e) => console.error('Erreur login:', e)
  });
  const saved = client.session.save();
  if (!TELEGRAM_STRING_SESSION) {
    console.log('\n✅ SESSION SAUVEGARDÉE : copie-la dans .env comme TELEGRAM_STRING_SESSION pour éviter de ressaisir:\n');
    console.log(saved, '\n');
  }
}

async function main() {
  await ensureLoggedIn();

  // Récupère l’entité du channel (handle ou ID)
  const entity = await client.getEntity(TELEGRAM_CHANNEL);
  console.log(`📡 Connecté. Écoute des nouveaux messages de: ${TELEGRAM_CHANNEL}`);

  // Affiche les 5 derniers messages du channel (pour vérifier l’accès)
  const history = await client.getMessages(entity, { limit: 5 });
  console.log('🕘 Derniers messages:');
  history.forEach((m, i) => {
    const text = (m?.message || '').replace(/\n/g, ' ⏎ ');
    console.log(`  ${i + 1}. ${text}`);
  });

  // Abonnement aux nouveaux messages
  client.addEventHandler(async (update) => {
    if (!(update instanceof Api.UpdateNewMessage)) return;
    const msg = update.message;
    if (!msg || !msg.message) return;

    // Filtrer: uniquement le channel ciblé
    try {
      const peer = await client.getInputEntity(msg.peerId);
      const isSameChannel =
        (peer.channelId && entity.channelId && peer.channelId.eq(entity.channelId)) ||
        (peer.userId && entity.userId && peer.userId.eq(entity.userId)) ||
        (peer.chatId && entity.chatId && peer.chatId.eq(entity.chatId));

      if (!isSameChannel) return;
    } catch {
      // ignore si résolution impossible
    }

    const text = msg.message;
    console.log('🆕 Nouveau message:');
    console.log(text);
    console.log('—'.repeat(40));
  });

console.log('▶️ En écoute… (Ctrl+C pour quitter)');
await new Promise(() => {}); // garde le process vivant
  console.log('▶️ En écoute… (Ctrl+C pour quitter)');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
