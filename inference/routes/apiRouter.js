/**
 * Tenrary-X API Router
 * Handles /api/* routes for auth, conversations, and rooms.
 * Pure Node.js HTTP — no Express dependency.
 */

import { authenticateRequest } from '../auth/auth.js';
import { sendCompressedJson } from '../compression.js';
import { handleAgentRoomRoute } from './agentRoomRoutes.js';
import { handleAuthRoute } from './authRoutes.js';
import { handleConversationRoute } from './conversationRoutes.js';
import { handleRoomRoute } from './roomRoutes.js';

// ── Helpers ────────────────────────────────────────────────────

/**
 * Send a JSON response with optional gzip compression.
 * When `req` is attached to `res._req`, compression is applied automatically.
 */
export function sendJson(res, statusCode, data, extraHeaders = {}) {
  const req = res._req;
  if (req) {
    // Fire-and-forget async compression — response is sent inside
    sendCompressedJson(req, res, statusCode, data, extraHeaders);
    return;
  }
  // Fallback: no req available, send uncompressed
  const json = JSON.stringify(data);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(json);
}

export function readBody(req, maxSize = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxSize) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Route an /api/* request. Returns true if handled, false if not matched.
 * @param {URL} url
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function routeApiRequest(url, req, res) {
  // Attach req to res so sendJson can access Accept-Encoding for compression
  res._req = req;
  const path = url.pathname;

  // ── Public auth routes (no token needed) ─────────────────────
  if (path.startsWith('/api/auth/')) {
    return handleAuthRoute(path, req, res);
  }

  // ── Protected routes — require auth ──────────────────────────
  const authError = authenticateRequest(req);
  if (authError) {
    sendJson(res, 401, { error: authError });
    return true;
  }

  if (path.startsWith('/api/conversations')) {
    return handleConversationRoute(path, req, res);
  }

  if (path.startsWith('/api/rooms')) {
    return handleRoomRoute(path, url, req, res);
  }

  if (path.startsWith('/api/agent-rooms') || path.startsWith('/api/skills')) {
    return handleAgentRoomRoute(path, url, req, res);
  }

  if (path === '/api/me' && req.method === 'GET') {
    sendJson(res, 200, { user: req.user });
    return true;
  }

  return false;
}
