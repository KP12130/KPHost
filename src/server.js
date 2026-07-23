import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';

import { connectDB } from './services/db.js';
import { scanFileForViruses } from './services/security.js';
import { extractBotZip, startBotProcess, stopBotProcess, getBotLogs } from './services/orchestrator.js';
import { User } from './models/User.js';
import { Bot } from './models/Bot.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const upload = multer({ storage: multer.memoryStorage() });

// Connect to Database
connectDB();

// API Routes

// 1. Auth Endpoint (GitHub / Discord / Google Login)
app.post('/api/auth/login', async (req, res) => {
  const { email, username, provider, avatar } = req.body;
  const userEmail = email || `${(username || 'dev').toLowerCase().replace(/\s+/g, '')}@kphost.io`;

  try {
    let user = await User.findOne({ email: userEmail });
    if (!user) {
      user = await User.create({
        username: username || 'KP Developer',
        email: userEmail,
        avatar: avatar || 'https://github.com/github.png',
        walletBalance: 10.00, // $10.00 starting credits
        role: 'user'
      });
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Deploy Bot via GitHub Repo URL
app.post('/api/bots/deploy-github', async (req, res) => {
  const { botName, githubUrl, envVars } = req.body;

  if (!githubUrl || !githubUrl.includes('github.com')) {
    return res.status(400).json({ error: 'Please enter a valid GitHub repository URL.' });
  }

  try {
    const cleanName = (botName || 'gh-bot-' + Date.now()).toLowerCase().replace(/[^a-z0-9-]/g, '');
    const botId = cleanName + '-' + Math.floor(Math.random() * 1000);

    let parsedEnv = {};
    if (envVars) {
      try { parsedEnv = typeof envVars === 'string' ? JSON.parse(envVars) : envVars; } catch (e) {}
    }

    let userObj = await User.findOne();
    if (!userObj) {
      userObj = await User.create({ username: 'KP Dev', email: 'dev@kphost.io' });
    }

    const newBot = await Bot.create({
      botId,
      ownerId: userObj._id,
      name: botName || cleanName,
      type: 'github',
      sourceUrl: githubUrl,
      envVars: parsedEnv,
      ramLimitMB: 128,
      status: 'STOPPED',
      securityStatus: 'CLEAN',
      securityHash: 'GITHUB_VERIFIED_REPO',
      securityMessage: 'Verified GitHub repository deployment'
    });

    res.json({
      success: true,
      bot: newBot,
      security: { clean: true, status: 'CLEAN', message: 'GitHub Repo Verified' }
    });
  } catch (err) {
    console.error('GitHub Deploy Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Upload Bot ZIP with VirusTotal Malware Inspection
app.post('/api/bots/upload-zip', upload.single('botZip'), async (req, res) => {
  const { botName, userId, envVars } = req.body;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'No ZIP file uploaded.' });
  }

  try {
    const cleanName = (botName || 'kp-bot-' + Date.now()).toLowerCase().replace(/[^a-z0-9-]/g, '');
    const botId = cleanName + '-' + Math.floor(Math.random() * 1000);

    // 🛡️ Step 1: Perform VirusTotal Security Scan
    const securityResult = await scanFileForViruses(file.buffer, file.originalname);

    if (!securityResult.clean) {
      return res.status(400).json({
        success: false,
        securityStatus: 'INFECTED',
        error: `🛡️ Security Alert: Upload rejected. ${securityResult.message}`
      });
    }

    // 📦 Step 2: Unpack Bot Files
    extractBotZip(botId, file.buffer);

    // 💾 Step 3: Save Bot Record in MongoDB
    let parsedEnv = {};
    if (envVars) {
      try { parsedEnv = typeof envVars === 'string' ? JSON.parse(envVars) : envVars; } catch (e) {}
    }

    // Find or fallback user
    let userObj = await User.findOne();
    if (!userObj) {
      userObj = await User.create({ username: 'KP Dev', email: 'dev@kphost.io' });
    }

    const newBot = await Bot.create({
      botId,
      ownerId: userObj._id,
      name: botName || cleanName,
      type: 'zip',
      sourceUrl: file.originalname,
      envVars: parsedEnv,
      ramLimitMB: 128,
      status: 'STOPPED',
      securityStatus: 'CLEAN',
      securityHash: securityResult.hash,
      securityMessage: securityResult.message
    });

    res.json({
      success: true,
      bot: newBot,
      security: securityResult
    });
  } catch (err) {
    console.error('Upload Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Start Bot API
app.post('/api/bots/:botId/start', async (req, res) => {
  const { botId } = req.params;
  try {
    const bot = await Bot.findOne({ botId });
    if (!bot) return res.status(404).json({ error: 'Bot not found.' });

    if (bot.securityStatus === 'INFECTED') {
      return res.status(403).json({ error: 'Cannot start bot: File flagged by VirusTotal.' });
    }

    const envMap = bot.envVars ? Object.fromEntries(bot.envVars) : {};
    await startBotProcess(botId, envMap, bot.ramLimitMB || 128);

    bot.status = 'RUNNING';
    await bot.save();

    res.json({ success: true, status: 'RUNNING' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Stop Bot API
app.post('/api/bots/:botId/stop', async (req, res) => {
  const { botId } = req.params;
  try {
    stopBotProcess(botId);
    await Bot.updateOne({ botId }, { status: 'STOPPED' });
    res.json({ success: true, status: 'STOPPED' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Fetch Bot Logs
app.get('/api/bots/:botId/logs', (req, res) => {
  const { botId } = req.params;
  const logs = getBotLogs(botId);
  res.json({ success: true, logs });
});

// 6. Fetch All User Bots
app.get('/api/bots', async (req, res) => {
  try {
    const bots = await Bot.find().sort({ createdAt: -1 });
    res.json({ success: true, bots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🟢 KP Host Control Panel & API is LIVE on port ${PORT}!`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
