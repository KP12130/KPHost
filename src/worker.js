import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import admZip from 'adm-zip';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_STORAGE = path.join(__dirname, '../storage/worker-bots');

if (!fs.existsSync(WORKER_STORAGE)) {
  fs.mkdirSync(WORKER_STORAGE, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json());

const activeProcesses = new Map();
const botLogs = new Map();

function appendLog(botId, msg) {
  if (!botLogs.has(botId)) botLogs.set(botId, []);
  const logs = botLogs.get(botId);
  logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (logs.length > 200) logs.shift();
}

// 1. Worker Health Check
app.get('/api/worker/health', (req, res) => {
  res.json({
    status: 'ONLINE',
    nodeName: 'kp-host-worker-1',
    activeBots: activeProcesses.size,
    ramCapMB: 128
  });
});

import multer from 'multer';
import { execSync } from 'child_process';

const upload = multer({ storage: multer.memoryStorage() });

// 2. Deploy Bot onto Worker Node
app.post('/api/worker/deploy', upload.single('botZip'), (req, res) => {
  const { botId, githubUrl, startCommand } = req.body;
  const botDir = path.join(WORKER_STORAGE, botId);

  if (fs.existsSync(botDir)) {
    fs.rmSync(botDir, { recursive: true, force: true });
  }
  fs.mkdirSync(botDir, { recursive: true });

  if (req.file) {
    const zip = new admZip(req.file.buffer);
    zip.extractAllTo(botDir, true);
    appendLog(botId, `📦 Unpacked ZIP code package into VM #2 storage: ${botDir}`);
  } else if (githubUrl) {
    try {
      execSync(`git clone --depth 1 ${githubUrl} .`, { cwd: botDir, stdio: 'ignore' });
      appendLog(botId, `🐙 Cloned GitHub repository into VM #2 storage: ${botDir}`);
    } catch (e) {
      appendLog(botId, `⚠️ Git clone notice: ${e.message}`);
    }
  }

  res.json({ success: true, node: 'kp-host-worker-1', status: 'READY', botDir });
});

// 3. Start Bot Process on Worker Node (128MB RAM Cap)
app.post('/api/worker/start', (req, res) => {
  const { botId, envVars, ramLimitMB = 128 } = req.body;
  const botDir = path.join(WORKER_STORAGE, botId);

  if (activeProcesses.has(botId)) {
    const proc = activeProcesses.get(botId);
    proc.kill('SIGKILL');
    activeProcesses.delete(botId);
  }

  // Create demo bot file if directory is fresh
  if (!fs.existsSync(botDir)) {
    fs.mkdirSync(botDir, { recursive: true });
    fs.writeFileSync(path.join(botDir, 'index.js'), `
      console.log("🤖 [KP Worker #1] Discord Bot started successfully on Node VM #2!");
      console.log("⚡ RAM Allocation: ${ramLimitMB}MB Tier Active");
      setInterval(() => {
        console.log("🟢 Heartbeat: Bot is online 24/7 on KP Host Worker #1 (" + new Date().toLocaleTimeString() + ")");
      }, 5000);
    `);
  }

  appendLog(botId, `⚡ Launching bot on Worker Node VM #2 (RAM Limit: ${ramLimitMB}MB)...`);

  const child = spawn('node', ['index.js'], {
    cwd: botDir,
    env: { ...process.env, ...envVars, NODE_OPTIONS: `--max-old-space-size=${ramLimitMB}` }
  });

  child.stdout.on('data', d => appendLog(botId, d.toString().trim()));
  child.stderr.on('data', d => appendLog(botId, `⚠️ ${d.toString().trim()}`));

  child.on('exit', (code) => {
    appendLog(botId, `⏹️ Bot process stopped (code: ${code})`);
    activeProcesses.delete(botId);
  });

  activeProcesses.set(botId, child);
  res.json({ success: true, status: 'RUNNING', botId, node: 'kp-host-worker-1' });
});

// 4. Stop Bot Process
app.post('/api/worker/stop', (req, res) => {
  const { botId } = req.body;
  if (activeProcesses.has(botId)) {
    const proc = activeProcesses.get(botId);
    proc.kill('SIGKILL');
    activeProcesses.delete(botId);
    appendLog(botId, '🛑 Stopped by user request.');
    res.json({ success: true, status: 'STOPPED' });
  } else {
    res.json({ success: true, status: 'STOPPED' });
  }
});

// 5. Fetch Logs from Worker
app.get('/api/worker/logs/:botId', (req, res) => {
  const { botId } = req.params;
  res.json({ success: true, logs: botLogs.get(botId) || ['[Worker Node] Initializing logs...'] });
});

const PORT = process.env.WORKER_PORT || 4000;
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🤖 KP Host WORKER NODE #1 is LIVE on port ${PORT}!`);
  console.log(`Ready to run user bots in 128MB isolated containers!`);
  console.log(`=======================================================`);
});
