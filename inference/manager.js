/**
 * Tenrary-X Inference Manager
 * Single model resource — switches between standard/turboquant modes by restarting llama-server.
 * Exposes a control API on :3002 and proxies inference to the active llama-server on :18080.
 */

import { spawn, execFile } from 'child_process';
import { createServer, request as httpRequest } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from 'redis';
import { WebSocketServer } from 'ws';

import { buildCacheKey, CACHE_TTLS, RequestCache, shouldCacheRequest } from './requestCache.js';
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
const MANUAL_PARALLEL_SLOTS = parseInt(process.env.PARALLEL_SLOTS, 10) || 0;

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || 'http://localhost:3000';
const CONTROL_API_KEY = process.env.CONTROL_API_KEY || '';
const ENOWXAI_BASE_URL = process.env.ENOWXAI_BASE_URL || '';
const ENOWXAI_API_KEY = process.env.ENOWXAI_API_KEY || '';
const ENOWXAI_MODEL = process.env.ENOWXAI_MODEL || '';
const REDIS_URL = process.env.REDIS_URL || '';
const MAX_PROXY_BODY_SIZE = 512 * 1024;
const MAX_BUFFERED_PROXY_RESPONSE_SIZE = 2 * 1024 * 1024;
const SUPPORTED_PROXY_GET_PATHS = new Set(['/v1/models']);
const SUPPORTED_PROXY_POST_PATHS = new Set(['/v1/chat/completions', '/v1/responses', '/v1/messages']);

// ── Request Queue ──────────────────────────────────────────────
const requestQueue = [];
let activeSlots = 0;
const MAX_QUEUE_SIZE = 10;

const MODES = {
  standard: {
    type: 'local',
    label: 'Standard (f16 KV)',
    args: ['--cache-type-k', 'f16', '--cache-type-v', 'f16', '-fa', 'off', '-c', '8192'],
  },
  turboquant: {
    type: 'local',
    label: 'TurboQuant (q4_0 + FA)',
    args: ['--cache-type-k', 'q4_0', '--cache-type-v', 'q4_0', '-fa', 'on', '-c', '65536'],
  },
  enowxai: {
    type: 'provider',
    label: 'EnowxAI (Claude Opus 4.6)',
    baseURL: ENOWXAI_BASE_URL,
    apiKey: ENOWXAI_API_KEY,
    model: ENOWXAI_MODEL,
  },
};

let currentMode = null;
let serverProcess = null;
let isStarting = false;
let activeWebSocketConnections = 0;
let maxParallelSlots = 1;
let slotStrategy = MANUAL_PARALLEL_SLOTS > 0 ? 'manual' : 'auto';
const wsConnectionsByIp = new Map();

const startedAt = Date.now();
let totalRequests = 0;
const requestCache = new RequestCache();

// ── GPU Metrics Cache ──────────────────────────────────────────
let gpuMetricsCache = { utilization: 0, memory_used_mb: 0, memory_total_mb: 0, temperature: 0 };

function clampSlots(value) {
  return Math.max(1, Math.min(MAX_WS_CONNECTIONS, Math.floor(value || 1)));
}

function resolveParallelSlots(mode) {
  if (MANUAL_PARALLEL_SLOTS > 0) {
    slotStrategy = 'manual';
    return clampSlots(MANUAL_PARALLEL_SLOTS);
  }

  slotStrategy = 'auto';
  const vramGb = (gpuMetricsCache.memory_total_mb || 0) / 1024;

  if (vramGb <= 0) {
    // Conservative defaults before first nvidia-smi sample arrives.
    return mode === 'turboquant' ? 2 : 1;
  }

  if (mode === 'turboquant') {
    if (vramGb >= 16) return 6;
    if (vramGb >= 12) return 4;
    if (vramGb >= 8) return 3;
    if (vramGb >= 6) return 2;
    return 1;
  }

  // Standard mode uses f16 KV cache, so keep slots conservative.
  if (vramGb >= 24) return 4;
  if (vramGb >= 16) return 3;
  if (vramGb >= 10) return 2;
  return 1;
}

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

async function initRedisCache() {
  if (!REDIS_URL) {
    log('Redis cache disabled (REDIS_URL not set). Using memory cache.');
    return;
  }

  const client = createClient({ url: REDIS_URL });
  client.on('error', (error) => {
    if (client.isReady) {
      log(`Redis cache error: ${error.message}`);
    }
  });

  try {
    await client.connect();
    requestCache.redisClient = client;
    log(`Redis cache connected: ${REDIS_URL}`);
  } catch (error) {
    log(`Redis cache unavailable, falling back to memory cache: ${error.message}`);
    try {
      await client.disconnect();
    } catch {}
  }
}

void initRedisCache();

function wsSend(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function requestInference(pathname, { method = 'GET', body = null } = {}) {
  const modeConfig = currentMode ? MODES[currentMode] : null;

  if (modeConfig?.type === 'provider') {
    const baseUrl = new URL(modeConfig.baseURL);
    const basePath = baseUrl.pathname.replace(/\/$/, '');
    const upstreamPath = pathname.startsWith(basePath)
      ? pathname
      : `${basePath}${pathname.startsWith('/') ? pathname.replace(/^\/v1/, '') : pathname}`;
    const headers = body ? {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    } : {};

    if (modeConfig.apiKey) {
      headers.Authorization = `Bearer ${modeConfig.apiKey}`;
    }

    return httpRequest({
      protocol: baseUrl.protocol,
      hostname: baseUrl.hostname,
      port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
      path: upstreamPath,
      method,
      headers,
    });
  }

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

function isRemoteProviderMode(mode) {
  return Boolean(mode && MODES[mode]?.type === 'provider');
}

function isInferenceReady() {
  return Boolean(currentMode) && !isStarting && (isRemoteProviderMode(currentMode) || serverProcess);
}

function readRequestBody(req, sizeLimit = MAX_PROXY_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    let rawBody = '';

    req.on('data', (chunk) => {
      rawBody += chunk;
      if (rawBody.length > sizeLimit) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });

    req.on('end', () => resolve(rawBody));
    req.on('error', reject);
  });
}

function writeProxyHeaders(res, upstreamResponse) {
  const headers = { ...(upstreamResponse.headers || {}) };
  delete headers.connection;
  delete headers['transfer-encoding'];
  res.writeHead(upstreamResponse.statusCode ?? 502, headers);
}

function normalizeProxyHeaders(headers = {}) {
  const nextHeaders = { ...headers };
  delete nextHeaders.connection;
  delete nextHeaders['transfer-encoding'];
  return nextHeaders;
}

function sendBufferedProxyResponse(res, response) {
  res.writeHead(response.statusCode ?? 502, normalizeProxyHeaders(response.headers));
  res.end(response.body);
}

function isCacheableProviderRequest(pathname, method, body) {
  return isRemoteProviderMode(currentMode) && shouldCacheRequest(pathname, method, body);
}

function fetchBufferedInferenceResponse(pathname, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const upstreamRequest = requestInference(pathname, { method, body });

    upstreamRequest.setTimeout(UPSTREAM_REQUEST_TIMEOUT_MS, () => {
      upstreamRequest.destroy(new Error('Proxy request timeout'));
    });

    upstreamRequest.on('response', (upstreamResponse) => {
      const chunks = [];
      let totalLength = 0;

      upstreamResponse.on('data', (chunk) => {
        totalLength += chunk.length;
        if (totalLength > MAX_BUFFERED_PROXY_RESPONSE_SIZE) {
          upstreamRequest.destroy(new Error('Buffered proxy response exceeded size limit'));
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      upstreamResponse.on('end', () => {
        resolve({
          statusCode: upstreamResponse.statusCode ?? 502,
          headers: normalizeProxyHeaders(upstreamResponse.headers),
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });

      upstreamResponse.on('error', reject);
    });

    upstreamRequest.on('error', reject);

    if (body) {
      upstreamRequest.write(body);
    }

    upstreamRequest.end();
  });
}

async function maybeServeCachedProxyRequest(pathname, { method = 'GET', body = null } = {}, res) {
  if (!isCacheableProviderRequest(pathname, method, body)) {
    return false;
  }

  const cacheKey = buildCacheKey(pathname, method, body || '');
  const ttlSeconds = CACHE_TTLS[pathname] ?? 60;
  const { value, source } = await requestCache.getOrCompute(
    cacheKey,
    ttlSeconds,
    () => {
      totalRequests += 1;
      return fetchBufferedInferenceResponse(pathname, { method, body });
    },
    {
      shouldCache: (response) => (response?.statusCode ?? 500) < 400,
    },
  );

  res.setHeader('X-Tenrary-Cache', source);
  sendBufferedProxyResponse(res, value);
  return true;
}

function proxyInferenceRequest(pathname, { method = 'GET', body = null } = {}, res) {
  const upstreamRequest = requestInference(pathname, { method, body });

  upstreamRequest.setTimeout(UPSTREAM_REQUEST_TIMEOUT_MS, () => {
    upstreamRequest.destroy(new Error('Proxy request timeout'));
  });

  upstreamRequest.on('response', (upstreamResponse) => {
    writeProxyHeaders(res, upstreamResponse);
    upstreamResponse.pipe(res);
  });

  upstreamRequest.on('error', (error) => {
    if (res.headersSent) {
      res.end();
      return;
    }

    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message || 'Failed to reach inference backend.' }));
  });

  if (body) {
    upstreamRequest.write(body);
  }

  upstreamRequest.end();
}

function checkInferenceHealth() {
  return new Promise((resolve) => {
    if (!isInferenceReady()) {
      resolve(false);
      return;
    }

    const healthPath = isRemoteProviderMode(currentMode) ? '/v1/models' : '/health';
    const req = requestInference(healthPath);
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
        if (event.type === 'delta') { sink.onDelta(event.delta, event.channel); continue; }
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
  // Drain queue into available slots
  while (activeSlots < maxParallelSlots && requestQueue.length > 0) {
    const entry = requestQueue.shift();

    // Update queue positions for remaining waiters
    for (let i = 0; i < requestQueue.length; i++) {
      const queued = requestQueue[i];
      if (queued.type === 'ws' && queued.ws.readyState === 1) {
        wsSend(queued.ws, { type: 'queued', position: i + 1 });
      } else if (queued.type === 'sse' && !queued.disconnected) {
        queued.res.write(`data: ${JSON.stringify({ type: 'queued', position: i + 1 })}\n\n`);
      }
    }

    // Skip disconnected clients
    if (entry.type === 'ws' && entry.ws.readyState !== 1) continue;
    if (entry.type === 'sse' && entry.disconnected) continue;

    activeSlots++;
    entry.inFlight = true;

    const onComplete = () => {
      if (entry.inFlight) {
        entry.inFlight = false;
        activeSlots = Math.max(0, activeSlots - 1);
      }
      processQueue();
    };

    if (entry.type === 'ws') {
      const handle = streamUpstreamToSink(entry.params, {
        onDelta: (delta, channel) => wsSend(entry.ws, { type: 'delta', delta, channel }),
        onDone: () => { wsSend(entry.ws, { type: 'done' }); entry.cleanupRef = null; onComplete(); },
        onError: (msg) => { wsSend(entry.ws, { type: 'error', message: msg }); entry.cleanupRef = null; onComplete(); },
      });
      entry.cleanupRef = handle.cleanup;
    } else if (entry.type === 'sse') {
      const handle = streamUpstreamToSink(entry.params, {
        onDelta: (delta, channel) => {
          if (!entry.disconnected) entry.res.write(`data: ${JSON.stringify({ type: 'delta', delta, channel })}\n\n`);
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
    if (!isInferenceReady()) {
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

    const entry = { type: 'ws', ws, params, cleanupRef: null, inFlight: false };
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
    if (activeEntry?.inFlight && activeEntry.cleanupRef) {
      activeEntry.cleanupRef();
      activeEntry.cleanupRef = null;
      activeEntry.inFlight = false;
      activeSlots = Math.max(0, activeSlots - 1);
      processQueue();
    }
  };

  ws.on('close', closeConnection);
  ws.on('error', closeConnection);
});

function killServer() {
  return new Promise((resolve) => {
    if (!serverProcess) {
      currentMode = null;
      resolve();
      return;
    }

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
    if (config.type === 'provider') {
      if (!config.baseURL || !config.apiKey) {
        reject(new Error('EnowxAI provider is not configured. Set ENOWXAI_BASE_URL and ENOWXAI_API_KEY in .env.'));
        return;
      }
      maxParallelSlots = clampSlots(resolveParallelSlots(mode));
      currentMode = mode;
      serverProcess = null;
      isStarting = false;
      log(`✓ ${mode} provider ready via ${config.baseURL}`);
      resolve();
      return;
    }

    maxParallelSlots = clampSlots(resolveParallelSlots(mode));
    const args = [
      '-m', MODEL,
      '-ngl', '99',
      '-np', String(maxParallelSlots),
      '--host', '0.0.0.0',
      '--port', String(INFERENCE_PORT),
      ...config.args,
    ];

    log(`Starting ${mode} mode: ${config.label} (slots: ${maxParallelSlots}, strategy: ${slotStrategy})`);

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

  if (SUPPORTED_PROXY_GET_PATHS.has(url.pathname) && req.method === 'GET') {
    if (!isInferenceReady()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Inference server is not ready yet.' }));
    }

    if (await maybeServeCachedProxyRequest(url.pathname, { method: 'GET' }, res)) {
      return;
    }

    return proxyInferenceRequest(url.pathname, { method: 'GET' }, res);
  }

  if (SUPPORTED_PROXY_POST_PATHS.has(url.pathname) && req.method === 'POST') {
    if (!isInferenceReady()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Inference server is not ready yet.' }));
    }

    try {
      const rawBody = await readRequestBody(req);
      if (await maybeServeCachedProxyRequest(url.pathname, { method: 'POST', body: rawBody }, res)) {
        return;
      }
      return proxyInferenceRequest(url.pathname, { method: 'POST', body: rawBody }, res);
    } catch (error) {
      const statusCode = error.message === 'Payload too large' ? 413 : 400;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: error.message || 'Invalid request body.' }));
    }
  }

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
        active_slots: activeSlots,
        max_parallel_slots: maxParallelSlots,
        slot_strategy: slotStrategy,
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
    if (!isInferenceReady()) {
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

      const entry = { type: 'sse', res, params, disconnected: false, cleanupRef: null, inFlight: false };

      req.on('close', () => {
        entry.disconnected = true;
        // Remove from queue if still pending
        const idx = requestQueue.indexOf(entry);
        if (idx !== -1) requestQueue.splice(idx, 1);
        if (entry.cleanupRef) {
          entry.cleanupRef();
          entry.cleanupRef = null;
        }
        if (entry.inFlight) {
          entry.inFlight = false;
          activeSlots = Math.max(0, activeSlots - 1);
          processQueue();
        }
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
  log(`  GET  /v1/models      — Proxy models endpoint`);
  log(`  POST /v1/chat/completions — Proxy OpenAI chat completions`);
  log(`  POST /v1/responses   — Proxy OpenAI responses API`);
  log(`  POST /v1/messages    — Proxy Anthropic messages API`);
  log(`  GET  /status         — Current mode info`);
  log(`  GET  /health         — Inference health check`);
  log(`  GET  /metrics        — GPU & inference metrics`);
  log(`  POST /switch?mode=X  — Switch mode (${Object.keys(MODES).join('|')})`);
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
