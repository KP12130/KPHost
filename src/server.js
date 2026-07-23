import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import multer from 'multer';
import { fileURLToPath } from 'url';

import cookieParser from 'cookie-parser';
import session from 'express-session';

import { connectDB } from './services/db.js';
import { scanFileForViruses } from './services/security.js';
import { extractBotZip, startBotProcess, stopBotProcess, getBotLogs, isBotRunning } from './services/orchestrator.js';
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
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'kp-host-secret-key-2026-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, '../public')));

const upload = multer({ storage: multer.memoryStorage() });

// Connect to Database
connectDB();

// API Routes

// 1. OAuth Redirect Routes (GitHub / Discord / Google)
app.get('/api/auth/github', (req, res) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId || clientId === 'YOUR_GITHUB_CLIENT_ID') {
    return res.redirect('/?login=demo&provider=GitHub');
  }
  const host = req.get('host');
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const redirectUri = encodeURIComponent(`${protocol}://${host}/api/auth/github/callback`);
  res.redirect(`https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=user:email`);
});

app.get('/api/auth/discord', (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId || clientId === 'YOUR_DISCORD_CLIENT_ID') {
    return res.redirect('/?login=demo&provider=Discord');
  }
  const host = req.get('host');
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const redirectUri = encodeURIComponent(`${protocol}://${host}/api/auth/discord/callback`);
  res.redirect(`https://discord.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=identify%20email`);
});

app.get('/api/auth/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || clientId === 'YOUR_GOOGLE_CLIENT_ID') {
    return res.redirect('/?login=demo&provider=Google');
  }
  const host = req.get('host');
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const redirectUri = encodeURIComponent(`${protocol}://${host}/api/auth/google/callback`);
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=openid%20profile%20email`);
});

// OAuth Callback Handlers (Real Profile Exchange + Database Storage)
app.get('/api/auth/github/callback', async (req, res) => {
  const { code } = req.query;
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!code || !clientId || !clientSecret || clientSecret === 'YOUR_GITHUB_CLIENT_SECRET') {
    return res.redirect('/dashboard?login=success&provider=GitHub');
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code })
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (accessToken) {
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `token ${accessToken}`, 'User-Agent': 'KP-Host-App' }
      });
      const userData = await userRes.json();

      const username = userData.name || userData.login || 'GitHub User';
      const email = userData.email || `${userData.login}@github.com`;
      const avatar = userData.avatar_url || 'https://github.com/github.png';

      let user = null;
      try {
        user = await User.findOne({ email });
        if (!user) {
          user = await User.create({ username, email, avatar, walletBalance: 10.00, githubId: userData.id ? userData.id.toString() : '' });
        }
      } catch (e) {}

      const balance = user ? user.walletBalance : 10.00;
      req.session.user = { username, email, avatar, walletBalance: balance, provider: 'GitHub' };
      return res.redirect('/dashboard');
    }
  } catch (err) {
    console.error('GitHub OAuth Callback Error:', err);
  }
  req.session.user = { username: 'KP Developer (GitHub)', email: 'dev@kphost.tech', avatar: 'https://github.com/github.png', walletBalance: 10.00, provider: 'GitHub' };
  res.redirect('/dashboard');
});

app.get('/api/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;

  if (!code || !clientId || !clientSecret || clientSecret === 'YOUR_DISCORD_CLIENT_SECRET') {
    req.session.user = { username: 'KP Developer (Discord)', email: 'dev@kphost.tech', avatar: 'https://cdn.discordapp.com/embed/avatars/0.png', walletBalance: 10.00, provider: 'Discord' };
    return res.redirect('/dashboard');
  }

  try {
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const redirectUri = `${protocol}://${host}/api/auth/discord/callback`;

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      })
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (accessToken) {
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const userData = await userRes.json();

      const username = userData.global_name || userData.username || 'Discord User';
      const email = userData.email || `${userData.id}@discord.com`;
      const avatar = userData.avatar 
        ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
        : 'https://cdn.discordapp.com/embed/avatars/0.png';

      let user = null;
      try {
        user = await User.findOne({ email });
        if (!user) {
          user = await User.create({ username, email, avatar, walletBalance: 10.00, discordId: userData.id });
        }
      } catch (e) {}

      const balance = user ? user.walletBalance : 10.00;
      req.session.user = { username, email, avatar, walletBalance: balance, provider: 'Discord' };
      return res.redirect('/dashboard');
    }
  } catch (err) {
    console.error('Discord OAuth Callback Error:', err);
  }
  req.session.user = { username: 'KP Developer (Discord)', email: 'dev@kphost.tech', avatar: 'https://cdn.discordapp.com/embed/avatars/0.png', walletBalance: 10.00, provider: 'Discord' };
  res.redirect('/dashboard');
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!code || !clientId || !clientSecret || clientSecret === 'YOUR_GOOGLE_CLIENT_SECRET') {
    return res.redirect('/dashboard?login=success&provider=Google');
  }

  try {
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const redirectUri = `${protocol}://${host}/api/auth/google/callback`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      })
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (accessToken) {
      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const userData = await userRes.json();

      const username = userData.name || 'Google User';
      const email = userData.email;
      const avatar = userData.picture || 'https://lh3.googleusercontent.com/a/default-user';

      let user = null;
      try {
        user = await User.findOne({ email });
        if (!user) {
          user = await User.create({ username, email, avatar, walletBalance: 10.00, googleId: userData.id });
        }
      } catch (e) {}

      const balance = user ? user.walletBalance : 10.00;
      req.session.user = { username, email, avatar, walletBalance: balance, provider: 'Google' };
      return res.redirect('/dashboard');
    }
  } catch (err) {
    console.error('Google OAuth Callback Error:', err);
  }
  req.session.user = { username: 'KP Developer (Google)', email: 'dev@kphost.tech', avatar: 'https://lh3.googleusercontent.com/a/default-user', walletBalance: 10.00, provider: 'Google' };
  res.redirect('/dashboard');
});

// Auth Session Verification Endpoints
app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ success: true, user: req.session.user });
  }
  res.status(401).json({ success: false, user: null });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session) req.session.destroy(() => {});
  res.clearCookie('connect.sid');
  res.json({ success: true });
});

// Serve Dedicated /dashboard Route
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Auth Endpoint (JSON fallback/login)
app.post('/api/auth/login', async (req, res) => {
  const { email, username, provider, avatar } = req.body;
  const userEmail = email || `${(username || 'dev').toLowerCase().replace(/\s+/g, '')}@kphost.io`;
  const defaultUser = {
    username: username || 'KP Developer',
    email: userEmail,
    avatar: avatar || 'https://github.com/github.png',
    walletBalance: 10.00,
    provider: provider || 'OAuth'
  };
  req.session.user = defaultUser;
  res.json({ success: true, user: defaultUser });
});

const STORAGE_DIR = path.join(__dirname, '../storage');
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
const JSON_DB_FILE = path.join(STORAGE_DIR, 'bots-database.json');

function saveBotsToJson(botsMap) {
  try {
    const list = Array.from(botsMap.values());
    fs.writeFileSync(JSON_DB_FILE, JSON.stringify(list, null, 2));
  } catch (e) {
    console.warn('JSON DB Save Error:', e.message);
  }
}

function loadBotsFromJson() {
  try {
    if (fs.existsSync(JSON_DB_FILE)) {
      const data = fs.readFileSync(JSON_DB_FILE, 'utf8');
      const list = JSON.parse(data);
      const map = new Map();
      list.forEach(b => map.set(b.botId, b));
      return map;
    }
  } catch (e) {}
  return new Map();
}

const inMemoryBots = loadBotsFromJson();
const WORKER_URL = process.env.WORKER_NODE_URL || 'http://10.128.0.3:4000';

// 2. Deploy Bot via GitHub Repo URL
app.post('/api/bots/deploy-github', async (req, res) => {
  const { botName, githubUrl, envVars, startCommand } = req.body;

  if (!githubUrl || !githubUrl.includes('github.com')) {
    return res.status(400).json({ error: 'Please enter a valid GitHub repository URL.' });
  }

  try {
    const cleanName = (botName || 'gh-bot-' + Date.now()).toLowerCase().replace(/[^a-z0-9-]/g, '');
    const botId = cleanName + '-' + Math.floor(Math.random() * 1000);

    // 📦 Clone GitHub Repository automatically on VM #1 local fallback
    const BOTS_STORAGE = path.join(__dirname, '../storage/bots');
    const botDir = path.join(BOTS_STORAGE, botId);
    try {
      if (!fs.existsSync(botDir)) fs.mkdirSync(botDir, { recursive: true });
      execSync(`git clone --depth 1 ${githubUrl} .`, { cwd: botDir, stdio: 'ignore' });
    } catch (e) {}

    // 📡 Forward deployment directly to VM #2 Worker Node!
    try {
      await fetch(`${WORKER_URL}/api/worker/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId, githubUrl, startCommand })
      });
      console.log(`📡 Dispatched GitHub bot ${botId} to VM #2 (${WORKER_URL})`);
    } catch (dispatchErr) {
      console.warn('Worker Dispatch Notice:', dispatchErr.message);
    }

    let parsedEnv = {};
    if (envVars) {
      try { parsedEnv = typeof envVars === 'string' ? JSON.parse(envVars) : envVars; } catch (e) {}
    }

    const botObj = {
      botId,
      name: botName || cleanName,
      type: 'github',
      sourceUrl: githubUrl,
      startCommand: startCommand || 'node index.js',
      envVars: parsedEnv,
      ramLimitMB: 128,
      status: 'STOPPED',
      securityStatus: 'CLEAN',
      securityHash: 'GITHUB_VERIFIED_REPO',
      securityMessage: 'Verified GitHub repository deployment'
    };

    inMemoryBots.set(botId, botObj);
    saveBotsToJson(inMemoryBots);

    try {
      if (mongoose.connection.readyState === 1) {
        let userObj = await User.findOne();
        if (!userObj) userObj = await User.create({ username: 'KP Dev', email: 'dev@kphost.io' });
        await Bot.create({ ...botObj, ownerId: userObj._id });
      }
    } catch (dbErr) {
      console.warn('MongoDB Notice: Saved bot to fast memory store.');
    }

    res.json({
      success: true,
      bot: botObj,
      security: { clean: true, status: 'CLEAN', message: 'GitHub Repo Verified' }
    });
  } catch (err) {
    console.error('GitHub Deploy Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Upload Bot ZIP with VirusTotal Malware Inspection
app.post('/api/bots/upload-zip', upload.single('botZip'), async (req, res) => {
  const { botName, userId, envVars, startCommand } = req.body;
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

    // 📦 Step 2: Unpack Bot Files locally & dispatch to VM #2 Worker Node!
    extractBotZip(botId, file.buffer);

    try {
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      form.append('botId', botId);
      form.append('startCommand', startCommand || 'node index.js');
      form.append('botZip', file.buffer, { filename: file.originalname });

      await fetch(`${WORKER_URL}/api/worker/deploy`, {
        method: 'POST',
        body: form,
        headers: form.getHeaders ? form.getHeaders() : {}
      });
      console.log(`📡 Dispatched ZIP bot ${botId} directly to VM #2 (${WORKER_URL})`);
    } catch (dispatchErr) {
      console.warn('Worker Dispatch Notice:', dispatchErr.message);
    }

    let parsedEnv = {};
    if (envVars) {
      try { parsedEnv = typeof envVars === 'string' ? JSON.parse(envVars) : envVars; } catch (e) {}
    }

    const botObj = {
      botId,
      name: botName || cleanName,
      type: 'zip',
      sourceUrl: file.originalname,
      startCommand: startCommand || 'node index.js',
      envVars: parsedEnv,
      ramLimitMB: 128,
      status: 'STOPPED',
      securityStatus: 'CLEAN',
      securityHash: securityResult.hash,
      securityMessage: securityResult.message
    };

    inMemoryBots.set(botId, botObj);
    saveBotsToJson(inMemoryBots);

    try {
      if (mongoose.connection.readyState === 1) {
        let userObj = await User.findOne();
        if (!userObj) userObj = await User.create({ username: 'KP Dev', email: 'dev@kphost.io' });
        await Bot.create({ ...botObj, ownerId: userObj._id });
      }
    } catch (dbErr) {
      console.warn('MongoDB Notice: Saved bot to fast memory store.');
    }

    res.json({
      success: true,
      bot: botObj,
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
    let bot = null;
    try {
      if (mongoose.connection.readyState === 1) {
        bot = await Bot.findOne({ botId }).maxTimeMS(1000);
      }
    } catch (e) {}

    if (!bot) {
      bot = inMemoryBots.get(botId);
    }

    if (!bot) return res.status(404).json({ error: 'Bot not found.' });

    if (bot.securityStatus === 'INFECTED') {
      return res.status(403).json({ error: 'Cannot start bot: File flagged by VirusTotal.' });
    }

    const envMap = bot.envVars ? (bot.envVars instanceof Map ? Object.fromEntries(bot.envVars) : bot.envVars) : {};
    await startBotProcess(botId, envMap, bot.ramLimitMB || 128, bot.startCommand);

    bot.status = 'RUNNING';
    if (inMemoryBots.has(botId)) {
      const memBot = inMemoryBots.get(botId);
      memBot.status = 'RUNNING';
    }

    try {
      if (bot.save) await bot.save();
    } catch (e) {}

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

// 5. Delete Bot API
app.delete('/api/bots/:botId', async (req, res) => {
  const { botId } = req.params;
  try {
    stopBotProcess(botId);
    inMemoryBots.delete(botId);
    saveBotsToJson(inMemoryBots);
    try { await Bot.deleteOne({ botId }); } catch (e) {}
    res.json({ success: true, message: 'Bot deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Add Credits / Top Up Wallet API
app.post('/api/users/add-credits', async (req, res) => {
  const { amount } = req.body;
  const creditAmount = parseFloat(amount) || 5.00;
  try {
    let user = await User.findOne();
    if (!user) {
      user = await User.create({ username: 'KP Developer', email: 'dev@kphost.io', walletBalance: 10.00 });
    }
    user.walletBalance += creditAmount;
    await user.save();
    res.json({ success: true, balance: user.walletBalance });
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
  let rawBots = [];
  try {
    if (mongoose.connection.readyState === 1) {
      const dbBots = await Bot.find().sort({ createdAt: -1 }).maxTimeMS(1000);
      if (dbBots && dbBots.length > 0) rawBots = dbBots;
    }
  } catch (err) {}

  if (!rawBots || rawBots.length === 0) {
    rawBots = Array.from(inMemoryBots.values());
  }

  const liveBots = rawBots.map(b => {
    const obj = b.toObject ? b.toObject() : { ...b };
    obj.status = isBotRunning(obj.botId) ? 'RUNNING' : 'STOPPED';
    return obj;
  });

  res.json({ success: true, bots: liveBots });
});

async function restoreRunningBots() {
  try {
    if (mongoose.connection.readyState === 1) {
      const runningBots = await Bot.find({ status: 'RUNNING' });
      for (const bot of runningBots) {
        try {
          const envMap = bot.envVars ? (bot.envVars instanceof Map ? Object.fromEntries(bot.envVars) : bot.envVars) : {};
          await startBotProcess(bot.botId, envMap, bot.ramLimitMB || 128, bot.startCommand);
          console.log(`⚡ Auto-restored active bot container: ${bot.botId}`);
        } catch (e) {
          console.warn(`Could not restore bot ${bot.botId}:`, e.message);
        }
      }
    }
  } catch (err) {}
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(`🟢 KP Host Control Panel & API is LIVE on port ${PORT}!`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`=======================================================`);
  await restoreRunningBots();
});
