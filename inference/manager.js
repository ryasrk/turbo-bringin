/**
 * Tenrary-X Inference Manager
 * Single model resource — switches between standard/turboquant modes by restarting llama-server.
 * Exposes a control API on :3002 and proxies inference to the active llama-server on :18080.
 */

import { spawn, execFile } from 'child_process';
import { createServer, request as httpRequest } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import { buildChatCompletionPayload, parseSseLine, splitSseLines } from './streamProxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');
const ENGINE = path.join(PROJECT_DIR, 'engines/llama-cpp-prismml/build/bin/llama-server');
const MODEL = path.join(PROJECT_DIR, 'models/Bonsai-8B-Q1_0.gguf');

const CONTROL_PORT = parseInt(process.env.CONTROL_PORT, 10) || 3002;
const INFERENCE_PORT = parseInt(process.env.INFERENCE_PORT, 10) || 18080;
const MAX_WS_CONNECTIONS = 32;
const MAX_WS_PER_IP = 4;
const MAX_STREAM_BUFFER_SIZE = 64 * 1024;
const STREAM_REQUEST_COOLDOWN_MS = 250;
const UPSTREAM_REQUEST_TIMEOUT_MS = 45_000;

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || 'http://localhost:3000';
const CONTROL_API_KEY = process.env.CONTROL_API_KEY || '';

// ── Request Queue ──────────────────────────────────────────────
const requestQueue = [];
let isProcessing = false;
const MAX_QUEUE_SIZE = 10;

const MODES = {
  standard: {
    label: 'Standard (f16 KV)',
    args: ['--cache-type-k', 'f16', '--cache-type-v', 'f16', '-fa', 'off', '-c', '8192'],
  },
  turboquant: {
    label: 'TurboQuant (q4_0 + FA)',
    args: ['--cache-type-k', 'q4_0', '--cache-type-v', 'q4_0', '-fa', 'on', '-c', '65536'],
  },
};

let currentMode = null;
let serverProcess = null;
let isStarting = false;
let activeWebSocketConnections = 0;
const wsConnectionsByIp = new Map();

const startedAt = Date.now();
let totalRequests = 0;

// ── GPU Metrics Cache ──────────────────────────────────────────
let gpuMetricsCache = { utilization: 0, memory_used_mb: 0, memory_total_mb: 0, temperature: 0 };

function pollGpuMetrics() {
  execFile('nvidia-smi', [
    '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu',
    '--format=csv,noheader,nounits',
  ], { timeout: 5000 }, (err, stdout) => {
    if (err) return;
    const parts = stdout.trim().split(',').map((s) => parseFloat(s.trim()));
    if (parts.length >= 4 && parts.every((n) => !Number.isNaN(n))) {
      gpuMetricsCache = {
        utilization: Math.round(parts[0]),
        memory_used_mb: Math.round(parts[1]),
        memory_total_mb: Math.round(parts[2]),
        temperature: Math.round(parts[3]),
      };
    }
  });
}

pollGpuMetrics();
setInterval(pollGpuMetrics, 5000);

const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

function wsSend(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function requestInference(pathname, { method = 'GET', body = null } = {}) {
  return httpRequest({
    hostname: '127.0.0.1',
    port: INFERENCE_PORT,
    path: pathname,
    method,
    headers: body ? {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    } : undefined,
  });
}

function checkInferenceHealth() {
  return new Promise((resolve) => {
    if (!serverProcess || !currentMode || isStarting) {
      resolve(false);
      return;
    }

    const req = requestInference('/health');
    req.setTimeout(3000, () => req.destroy(new Error('Health check timeout')));
    req.on('response', (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 400);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function attachWebSocketBridge(server) {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`);
    if (url.pathname !== '/ws/chat') {
      socket.destroy();
      return;
    }

    const ip = req.socket.remoteAddress || '';
    const ipCount = wsConnectionsByIp.get(ip) || 0;
    if (ipCount >= MAX_WS_PER_IP) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(req, socket, head, (ws) => {
      ws._clientIp = ip;
      websocketServer.emit('connection', ws);
    });
  });
}

// ── Shared stream-to-upstream logic ─────────────────────────────
function streamUpstreamToSink(params, sink) {
  const body = buildChatCompletionPayload(params);
  let upstreamRequest = null;
  let upstreamResponse = null;
  let streamBuffer = '';
  let completed = false;

  const cleanupUpstream = () => {
    streamBuffer = '';
    if (upstreamResponse) { upstreamResponse.destroy(); upstreamResponse = null; }
    if (upstreamRequest) { upstreamRequest.destroy(); upstreamRequest = null; }
  };

  const finishStream = () => {
    if (completed) return;
    completed = true;
    sink.onDone();
    cleanupUpstream();
  };

  upstreamRequest = requestInference('/v1/chat/completions', { method: 'POST', body });
  upstreamRequest.setTimeout(UPSTREAM_REQUEST_TIMEOUT_MS, () => {
    sink.onError('Inference request timed out.');
    cleanupUpstream();
  });

  upstreamRequest.on('response', (res) => {
    upstreamResponse = res;
    res.setEncoding('utf8');

    if ((res.statusCode ?? 500) >= 400) {
      let errorBody = '';
      res.on('data', (chunk) => { errorBody += chunk; });
      res.on('end', () => {
        sink.onError(errorBody || `Upstream inference request failed with status ${res.statusCode}.`);
        cleanupUpstream();
      });
      return;
    }

    res.on('data', (chunk) => {
      if (streamBuffer.length + chunk.length > MAX_STREAM_BUFFER_SIZE) {
        sink.onError('Inference stream exceeded the buffer limit.');
        cleanupUpstream();
        return;
      }

      const { lines, buffer } = splitSseLines(streamBuffer, chunk);
      streamBuffer = buffer;

      for (const line of lines) {
        const event = parseSseLine(line);
        if (!event || event.type === 'meta') continue;
        if (event.type === 'delta') { sink.onDelta(event.delta); continue; }
        if (event.type === 'done') { finishStream(); return; }
        if (event.type === 'invalid') {
          sink.onError('Received malformed stream data from inference server.');
          cleanupUpstream();
          return;
        }
      }
    });

    res.on('end', () => {
      if (streamBuffer.trim()) {
        const trailingEvent = parseSseLine(streamBuffer.trim());
        if (trailingEvent?.type === 'delta') sink.onDelta(trailingEvent.delta);
        if (trailingEvent?.type === 'done') { finishStream(); return; }
      }
      if (!completed) finishStream();
    });

    res.on('error', () => {
      sink.onError('Inference stream closed unexpectedly.');
      cleanupUpstream();
    });
  });

  upstreamRequest.on('error', (error) => {
    sink.onError(error.message || 'Failed to reach inference server.');
    cleanupUpstream();
  });

  upstreamRequest.write(body);
  upstreamRequest.end();

  return { cleanup: cleanupUpstream };
}

// ── Request Queue Processing ───────────────────────────────────
function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;

  const entry = requestQueue.shift();

  // Update queue positions for remaining clients
  for (let i = 0; i < requestQueue.length; i++) {
    const queued = requestQueue[i];
    if (queued.type === 'ws' && queued.ws.readyState === 1) {
      wsSend(queued.ws, { type: 'queued', position: i + 1 });
    } else if (queued.type === 'sse' && !queued.disconnected) {
      queued.res.write(`data: ${JSON.stringify({ type: 'queued', position: i + 1 })}\n\n`);
    }
  }

  // Skip if client disconnected while queued
  if (entry.type === 'ws' && entry.ws.readyState !== 1) {
    processQueue();
    return;
  }
  if (entry.type === 'sse' && entry.disconnected) {
    processQueue();
    return;
  }

  isProcessing = true;

  const onComplete = () => {
    isProcessing = false;
    processQueue();
  };

  if (entry.type === 'ws') {
    const handle = streamUpstreamToSink(entry.params, {
      onDelta: (delta) => wsSend(entry.ws, { type: 'delta', delta }),
      onDone: () => { wsSend(entry.ws, { type: 'done' }); entry.cleanupRef = null; onComplete(); },
      onError: (msg) => { wsSend(entry.ws, { type: 'error', message: msg }); entry.cleanupRef = null; onComplete(); },
    });
    entry.cleanupRef = handle.cleanup;
  } else if (entry.type === 'sse') {
    const handle = streamUpstreamToSink(entry.params, {
      onDelta: (delta) => {
        if (!entry.disconnected) entry.res.write(`data: ${JSON.stringify({ type: 'delta', delta })}\n\n`);
      },
      onDone: () => {
        if (!entry.disconnected) { entry.res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`); entry.res.end(); }
        entry.cleanupRef = null;
        onComplete();
      },
      onError: (msg) => {
        if (!entry.disconnected) { entry.res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`); entry.res.end(); }
        entry.cleanupRef = null;
        onComplete();
      },
    });
    entry.cleanupRef = handle.cleanup;
  }
}

function enqueueRequest(entry) {
  if (requestQueue.length >= MAX_QUEUE_SIZE) {
    return false;
  }
  requestQueue.push(entry);
  processQueue();
  return true;
}

websocketServer.on('connection', (ws) => {
  if (activeWebSocketConnections >= MAX_WS_CONNECTIONS) {
    ws.close(1008, 'Connection limit exceeded.');
    return;
  }

  const clientIp = ws._clientIp || '';
  activeWebSocketConnections += 1;
  wsConnectionsByIp.set(clientIp, (wsConnectionsByIp.get(clientIp) || 0) + 1);

  let lastRequestAt = 0;
  let activeEntry = null;

  ws.on('message', (raw, isBinary) => {
    const now = Date.now();
    if (isBinary) {
      wsSend(ws, { type: 'error', message: 'Binary websocket messages are not supported.' });
      return;
    }
    if (!serverProcess || !currentMode || isStarting) {
      wsSend(ws, { type: 'error', message: 'Inference server is not ready yet.' });
      return;
    }

    let params;
    try {
      params = JSON.parse(raw.toString());
    } catch {
      wsSend(ws, { type: 'error', message: 'Invalid JSON payload.' });
      return;
    }

    if (!Array.isArray(params.messages) || params.messages.length === 0) {
      wsSend(ws, { type: 'error', message: 'The websocket payload must include a non-empty messages array.' });
      return;
    }
    if (now - lastRequestAt < STREAM_REQUEST_COOLDOWN_MS) {
      wsSend(ws, { type: 'error', message: 'Requests are arriving too quickly. Please retry shortly.' });
      return;
    }

    lastRequestAt = now;
    totalRequests += 1;

    const entry = { type: 'ws', ws, params, cleanupRef: null };
    activeEntry = entry;

    if (!enqueueRequest(entry)) {
      wsSend(ws, { type: 'error', message: 'Queue full, try later' });
      return;
    }

    const position = requestQueue.indexOf(entry);
    if (position >= 0) {
      wsSend(ws, { type: 'queued', position: position + 1 });
    }
  });

  const closeConnection = () => {
    if (activeWebSocketConnections > 0) {
      activeWebSocketConnections -= 1;
    }
    const count = wsConnectionsByIp.get(clientIp) || 0;
    if (count <= 1) {
      wsConnectionsByIp.delete(clientIp);
    } else {
      wsConnectionsByIp.set(clientIp, count - 1);
    }
    // Remove any pending queued entries for this ws
    for (let i = requestQueue.length - 1; i >= 0; i--) {
      if (requestQueue[i].type === 'ws' && requestQueue[i].ws === ws) {
        requestQueue.splice(i, 1);
      }
    }
    if (activeEntry?.cleanupRef) {
      activeEntry.cleanupRef();
    }
  };

  ws.on('close', closeConnection);
  ws.on('error', closeConnection);
});

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

// ── Auth helpers ────────────────────────────────────────────────
function isLocalhost(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isAuthorizedMutation(req) {
  if (CONTROL_API_KEY) {
    const auth = req.headers['authorization'] || '';
    return auth === `Bearer ${CONTROL_API_KEY}`;
  }
  return isLocalhost(req);
}

// ── Control API Server ─────────────────────────────────────────
const controlServer = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', DASHBOARD_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`);

  // GET /status
  if (url.pathname === '/status' && req.method === 'GET') {
    const healthy = await checkInferenceHealth();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      mode: currentMode,
      label: currentMode ? MODES[currentMode].label : null,
      port: INFERENCE_PORT,
      pid: serverProcess?.pid || null,
      isStarting,
      healthy,
    }));
  }

  // GET /health
  if (url.pathname === '/health' && req.method === 'GET') {
    const healthy = await checkInferenceHealth();
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      healthy,
      mode: currentMode,
      isStarting,
      port: INFERENCE_PORT,
    }));
  }

  // POST /switch?mode=turboquant
  if (url.pathname === '/switch' && req.method === 'POST') {
    if (!isAuthorizedMutation(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Forbidden' }));
    }

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

  // GET /metrics
  if (url.pathname === '/metrics' && req.method === 'GET') {
    const contextSize = currentMode ? (MODES[currentMode].args[MODES[currentMode].args.indexOf('-c') + 1] || '0') : '0';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      gpu: gpuMetricsCache,
      inference: {
        active_connections: activeWebSocketConnections,
        queue_depth: requestQueue.length,
        total_requests: totalRequests,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      },
      model: {
        name: 'Bonsai-8B-Q1_0',
        mode: currentMode || 'offline',
        context_size: parseInt(contextSize, 10),
      },
    }));
  }

  // POST /stop
  if (url.pathname === '/stop' && req.method === 'POST') {
    if (!isAuthorizedMutation(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Forbidden' }));
    }

    await killServer();
    currentMode = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'stopped' }));
  }

  // POST /manager/chat/sse — SSE fallback for WebSocket
  if ((url.pathname === '/manager/chat/sse' || url.pathname === '/chat/sse') && req.method === 'POST') {
    if (!serverProcess || !currentMode || isStarting) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Inference server is not ready yet.' }));
    }

    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk;
      if (rawBody.length > 256 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      let params;
      try {
        params = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON payload.' }));
      }

      if (!Array.isArray(params.messages) || params.messages.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'The payload must include a non-empty messages array.' }));
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': DASHBOARD_ORIGIN,
      });

      const entry = { type: 'sse', res, params, disconnected: false, cleanupRef: null };

      req.on('close', () => {
        entry.disconnected = true;
        // Remove from queue if still pending
        const idx = requestQueue.indexOf(entry);
        if (idx !== -1) requestQueue.splice(idx, 1);
        if (entry.cleanupRef) entry.cleanupRef();
      });

      if (!enqueueRequest(entry)) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Queue full, try later' })}\n\n`);
        res.end();
        return;
      }

      const position = requestQueue.indexOf(entry);
      if (position >= 0) {
        res.write(`data: ${JSON.stringify({ type: 'queued', position: position + 1 })}\n\n`);
      }
    });

    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

attachWebSocketBridge(controlServer);

// ── Startup ────────────────────────────────────────────────────
controlServer.listen(CONTROL_PORT, () => {
  log(`═══ Tenrary-X Inference Manager ═══`);
  log(`Control API: http://localhost:${CONTROL_PORT}`);
  log(`Inference:   http://localhost:${INFERENCE_PORT}`);
  log(`Endpoints:`);
  log(`  GET  /status         — Current mode info`);
  log(`  GET  /health         — Inference health check`);
  log(`  GET  /metrics        — GPU & inference metrics`);
  log(`  POST /switch?mode=X  — Switch mode (standard|turboquant)`);
  log(`  POST /stop           — Stop server`);
  log(`  WS   /ws/chat        — Streaming chat bridge`);
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
