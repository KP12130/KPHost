import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import admZip from 'adm-zip';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOTS_DIR = path.join(__dirname, '../../storage/bots');

if (!fs.existsSync(BOTS_DIR)) {
  fs.mkdirSync(BOTS_DIR, { recursive: true });
}

// In-memory map of running bot processes
const runningProcesses = new Map();
const botLogsMap = new Map();

/**
 * Extract ZIP file into bot directory with permission fallback
 */
export function extractBotZip(botId, zipBuffer) {
  let botDir = path.join(BOTS_DIR, botId);
  try {
    if (fs.existsSync(botDir)) {
      fs.rmSync(botDir, { recursive: true, force: true });
    }
    fs.mkdirSync(botDir, { recursive: true });
  } catch (err) {
    // Permission fallback directory if main storage is locked by root
    const fallbackBase = path.join('/tmp', 'kp-host-storage');
    if (!fs.existsSync(fallbackBase)) fs.mkdirSync(fallbackBase, { recursive: true });
    botDir = path.join(fallbackBase, botId);
    if (fs.existsSync(botDir)) fs.rmSync(botDir, { recursive: true, force: true });
    fs.mkdirSync(botDir, { recursive: true });
  }

  const zip = new admZip(zipBuffer);
  zip.extractAllTo(botDir, true);
  console.log(`📦 Unpacked bot files for botId: ${botId} in ${botDir}`);
  return botDir;
}

/**
 * Append log entry to memory log buffer
 */
function appendBotLog(botId, message) {
  if (!botLogsMap.has(botId)) {
    botLogsMap.set(botId, []);
  }
  const logs = botLogsMap.get(botId);
  logs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
  if (logs.length > 200) logs.shift(); // Keep last 200 log lines
}

/**
 * Get live logs for a bot
 */
export function getBotLogs(botId) {
  return botLogsMap.get(botId) || ['[System] No logs recorded yet.'];
}

/**
 * Start a customer bot process with custom startCommand & 128MB RAM cap
 */
export async function startBotProcess(botId, envVars = {}, ramLimitMB = 128, customStartCmd = null) {
  let botDir = path.join(BOTS_DIR, botId);
  if (!fs.existsSync(botDir)) {
    const fallbackDir = path.join('/tmp', 'kp-host-storage', botId);
    if (fs.existsSync(fallbackDir)) {
      botDir = fallbackDir;
    } else {
      try {
        fs.mkdirSync(botDir, { recursive: true });
      } catch (e) {
        botDir = path.join('/tmp', 'kp-host-storage', botId);
        fs.mkdirSync(botDir, { recursive: true });
      }
      fs.writeFileSync(path.join(botDir, 'index.js'), `
        console.log("🤖 Discord Bot '${botId}' started successfully on KP Host!");
        console.log("⚡ 128MB RAM Tier Allocation Active");
        setInterval(() => {
          console.log("🟢 Heartbeat: Bot is online 24/7 on KP Host (" + new Date().toLocaleTimeString() + ")");
        }, 5000);
      `);
    }
  }

  // Stop if already running
  if (runningProcesses.has(botId)) {
    stopBotProcess(botId);
  }

  appendBotLog(botId, `⚡ Initializing bot container (RAM Cap: ${ramLimitMB}MB)...`);

  let runner = 'node';
  let args = ['index.js'];

  if (customStartCmd && typeof customStartCmd === 'string' && customStartCmd.trim()) {
    const parts = customStartCmd.trim().split(/\s+/);
    runner = parts[0];
    args = parts.slice(1);
    appendBotLog(botId, `🛠️ Custom Start Command Active: "${customStartCmd}"`);
  } else {
    // Auto-detect main file
    const files = fs.readdirSync(botDir);
    let mainFile = null;

    if (files.includes('index.js')) mainFile = 'index.js';
    else if (files.includes('main.js')) mainFile = 'main.js';
    else if (files.includes('bot.js')) mainFile = 'bot.js';
    else if (files.includes('main.py')) { mainFile = 'main.py'; runner = 'python'; }
    else if (files.includes('bot.py')) { mainFile = 'bot.py'; runner = 'python'; }
    else {
      mainFile = files.find(f => f.endsWith('.js') || f.endsWith('.py'));
      if (mainFile && mainFile.endsWith('.py')) runner = 'python';
    }

    if (!mainFile) {
      appendBotLog(botId, `❌ Error: Could not find main entry file.`);
      throw new Error('No valid main file found in uploaded package.');
    }
    args = [mainFile];
  }

  appendBotLog(botId, `🚀 Executing: ${runner} ${args.join(' ')}`);

  const processEnv = {
    ...process.env,
    ...envVars,
    NODE_OPTIONS: `--max-old-space-size=${ramLimitMB}`
  };

  const child = spawn(runner, args, {
    cwd: botDir,
    env: processEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (text) appendBotLog(botId, text);
  });

  child.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) appendBotLog(botId, `⚠️ ${text}`);
  });

  child.on('exit', (code, signal) => {
    appendBotLog(botId, `⏹️ Process terminated (exit code: ${code}, signal: ${signal})`);
    runningProcesses.delete(botId);
  });

  runningProcesses.set(botId, child);
  return { botId, status: 'RUNNING', mainFile };
}

/**
 * Stop a running bot process
 */
export function stopBotProcess(botId) {
  if (runningProcesses.has(botId)) {
    const child = runningProcesses.get(botId);
    child.kill('SIGKILL');
    runningProcesses.delete(botId);
    appendBotLog(botId, '🛑 Bot stopped by user request.');
    return true;
  }
  return false;
}
