import admZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, '../public');

// 1. Build Quick Test Bot ZIP
const testZip = new admZip();
const indexJs = `
console.log('=======================================================');
console.log('🤖 KP Host Test Bot is ONLINE and running 24/7!');
console.log('⚡ Container Allocation: 128MB RAM Tier Active');
console.log('=======================================================');

setInterval(() => {
  console.log('🟢 [KP Host Worker] Test Bot heartbeat - ' + new Date().toLocaleTimeString());
}, 5000);
`;

const pkgJson = JSON.stringify({
  name: 'kp-test-bot',
  version: '1.0.0',
  main: 'index.js',
  scripts: { start: 'node index.js' }
}, null, 2);

testZip.addFile('index.js', Buffer.from(indexJs));
testZip.addFile('package.json', Buffer.from(pkgJson));
testZip.writeZip(path.join(publicDir, 'test-bot.zip'));
console.log('✅ Created test-bot.zip in public folder!');

// 2. Build Translator Bot ZIP
const translatorZip = new admZip();
const sourceDir = 'c:/Users/patri/.gemini/antigravity/scratch/discord-bots/translator-bot';
if (fs.existsSync(sourceDir)) {
  translatorZip.addLocalFolder(sourceDir, '', (filename) => !filename.includes('node_modules') && !filename.includes('.git'));
  translatorZip.writeZip(path.join(publicDir, 'translator-bot.zip'));
  console.log('✅ Created translator-bot.zip in public folder!');
}
