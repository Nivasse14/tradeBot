import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_STRING_SESSION || '');

const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

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
  await client.start({
    phoneNumber: async () => await prompt('📞 Numéro (+33…): '),
    phoneCode: async () => await prompt('🔐 Code Telegram: '),
    password: async () => await prompt('🔑 2FA (si activé, sinon Entrée): '),
    onError: (e) => console.error('Login error:', e)
  });
  const saved = client.session.save();
  if (!process.env.TELEGRAM_STRING_SESSION) {
    console.log('\n✅ TELEGRAM_STRING_SESSION (à mettre dans .env) :\n' + saved + '\n');
  }
}

(async () => {
  await ensureLoggedIn();
  const dialogs = await client.getDialogs({ limit: 200 });
  console.log('📋 Vos chats/canaux (copiez l’ID voulu) :');
  for (const d of dialogs) {
    const name = d.name || '';
    const id = d.id?.toString?.() || '';
    const username = d.entity?.username || '';
    const kind =
      d.isChannel ? 'CHANNEL' : d.isGroup ? 'GROUP' : d.isUser ? 'USER' : 'OTHER';
    console.log(`${kind} | name="${name}" | id=${id} | username=${username}`);
  }
  process.exit(0);
})();
