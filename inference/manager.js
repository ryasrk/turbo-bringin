/**
 * Tenrary-X Inference Manager
 * Single model resource — switches between standard/turboquant modes by restarting llama-server.
 * Exposes a control API on :3002 and proxies inference to the active llama-server on :8080.
 */

import { spawn } from 'child_process';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');
const ENGINE = path.join(PROJECT_DIR, 'engines/llama-cpp-prismml/build/bin/llama-server');
const MODEL = path.join(PROJECT_DIR, 'models/Bonsai-8B-Q1_0.gguf');

const CONTROL_PORT = 3002;
const INFERENCE_PORT = 8080;

const MODES = {
  standard: {
    label: 'Standard (f16 KV)',
    args: ['--cache-type-k', 'f16', '--cache-type-v', 'f16', '-fa', 'off', '-c', '8192'],
  },
  turboquant: {
    label: 'TurboQuant (q4_0 + FA)',
    args: ['--cache-type-k', 'q4_0', '--cache-type-v', 'q4_0', '-fa', 'on', '-c', '16384'],
  },
};

let currentMode = null;
let serverProcess = null;
let isStarting = false;

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

function killServer() {
  return new Promise((resolve) => {
    if (!serverProcess) return resolve();

    const proc = serverProcess;
    log(`Stopping ${currentMode} server (PID: ${proc.pid})...`);

    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(forceTimer);
      serverProcess = null;
      currentMode = null;
      resolve();
    };

    proc.on('exit', done);
    proc.kill('SIGTERM');

    // Force kill after 5s if still alive
    const forceTimer = setTimeout(() => {
      if (!resolved) {
        try { proc.kill('SIGKILL'); } catch {}
        done();
      }
    }, 5000);
  });
}

function startServer(mode) {
  return new Promise((resolve, reject) => {
    if (!MODES[mode]) return reject(new Error(`Unknown mode: ${mode}`));

    const config = MODES[mode];
    const args = [
      '-m', MODEL,
      '-ngl', '99',
      '-np', '1',
      '--host', '0.0.0.0',
      '--port', String(INFERENCE_PORT),
      ...config.args,
    ];

    log(`Starting ${mode} mode: ${config.label}`);

    const proc = spawn(ENGINE, args, {
      cwd: PROJECT_DIR,
      env: { ...process.env, PATH: `/usr/local/cuda-12.8/bin:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;

    const handleOutput = (data) => {
      const line = data.toString();
      if (!started && line.includes('server is listening')) {
        started = true;
        currentMode = mode;
        serverProcess = proc;
        isStarting = false;
        log(`✓ ${mode} server ready on :${INFERENCE_PORT}`);
        resolve();
      }
      process.stdout.write(data);
    };

    proc.stdout.on('data', handleOutput);
    proc.stderr.on('data', handleOutput);

    proc.on('error', (err) => {
      isStarting = false;
      reject(err);
    });

    proc.on('exit', (code) => {
      if (!started) {
        isStarting = false;
        reject(new Error(`Server exited with code ${code} before starting`));
      } else if (serverProcess === proc) {
        // Only log if this is still the active server (not replaced by a switch)
        log(`Server exited (code: ${code})`);
        currentMode = null;
        serverProcess = null;
      }
    });

    // Timeout after 30s
    setTimeout(() => {
      if (!started) {
        proc.kill('SIGKILL');
        isStarting = false;
        reject(new Error('Server startup timeout (30s)'));
      }
    }, 30000);
  });
}

async function switchMode(mode) {
  if (mode === currentMode) return { status: 'ok', mode, message: 'Already running' };
  if (isStarting) return { status: 'busy', message: 'Mode switch in progress' };

  isStarting = true;
  await killServer();
  await startServer(mode);
  return { status: 'ok', mode, message: `Switched to ${MODES[mode].label}` };
}

// ── Control API Server ─────────────────────────────────────────
const controlServer = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`);

  // GET /status
  if (url.pathname === '/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      mode: currentMode,
      label: currentMode ? MODES[currentMode].label : null,
      port: INFERENCE_PORT,
      pid: serverProcess?.pid || null,
      isStarting,
    }));
  }

  // POST /switch?mode=turboquant
  if (url.pathname === '/switch' && req.method === 'POST') {
    const mode = url.searchParams.get('mode');
    if (!mode || !MODES[mode]) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `Invalid mode. Use: ${Object.keys(MODES).join(', ')}` }));
    }

    try {
      const result = await switchMode(mode);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // POST /stop
  if (url.pathname === '/stop' && req.method === 'POST') {
    await killServer();
    currentMode = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'stopped' }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ── Startup ────────────────────────────────────────────────────
controlServer.listen(CONTROL_PORT, () => {
  log(`═══ Tenrary-X Inference Manager ═══`);
  log(`Control API: http://localhost:${CONTROL_PORT}`);
  log(`Inference:   http://localhost:${INFERENCE_PORT}`);
  log(`Endpoints:`);
  log(`  GET  /status         — Current mode info`);
  log(`  POST /switch?mode=X  — Switch mode (standard|turboquant)`);
  log(`  POST /stop           — Stop server`);
  log(``);
});

// Start with turboquant by default
const startMode = process.argv[2] || 'turboquant';
switchMode(startMode).catch((err) => {
  log(`Failed to start: ${err.message}`);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  log('Shutting down...');
  await killServer();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('Shutting down...');
  await killServer();
  process.exit(0);
});
