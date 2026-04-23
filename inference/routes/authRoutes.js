/**
 * Auth Routes — /api/auth/*
 * Registration, login, token refresh, logout.
 */

import { register, login, logout, logoutAll, verifyRefreshTokenAndRotate, authenticateRequest } from '../auth/auth.js';
import { sendJson, readBody } from './apiRouter.js';
import { updateUser, findUserById } from '../db/database.js';
import { hashPassword, verifyPassword, validatePassword } from '../auth/auth.js';

/**
 * @param {string} path
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function handleAuthRoute(path, req, res) {

  // POST /api/auth/register
  if (path === '/api/auth/register' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { username, email, password, display_name } = body;

      if (!username || !email || !password) {
        sendJson(res, 400, { error: 'username, email, and password are required' });
        return true;
      }

      const result = register(username, email, password, display_name);
      if (result.error) {
        sendJson(res, 400, { error: result.error });
        return true;
      }

      sendJson(res, 201, { user: result.user, tokens: result.tokens });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Registration failed' });
    }
    return true;
  }

  // POST /api/auth/login
  if (path === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { username, password } = body;

      if (!username || !password) {
        sendJson(res, 400, { error: 'username and password are required' });
        return true;
      }

      const result = login(username, password);
      if (result.error) {
        sendJson(res, 401, { error: result.error });
        return true;
      }

      sendJson(res, 200, { user: result.user, tokens: result.tokens });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Login failed' });
    }
    return true;
  }

  // POST /api/auth/refresh
  if (path === '/api/auth/refresh' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { refresh_token } = body;

      if (!refresh_token) {
        sendJson(res, 400, { error: 'refresh_token is required' });
        return true;
      }

      const result = verifyRefreshTokenAndRotate(refresh_token);
      if (result.error) {
        sendJson(res, 401, { error: result.error });
        return true;
      }

      sendJson(res, 200, { user: result.user, tokens: result.tokens });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Token refresh failed' });
    }
    return true;
  }

  // POST /api/auth/logout
  if (path === '/api/auth/logout' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      logout(body.refresh_token);
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 200, { ok: true });
    }
    return true;
  }

  // POST /api/auth/logout-all (requires auth)
  if (path === '/api/auth/logout-all' && req.method === 'POST') {
    const authError = authenticateRequest(req);
    if (authError) {
      sendJson(res, 401, { error: authError });
      return true;
    }
    logoutAll(req.user.id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // PATCH /api/auth/profile (requires auth)
  if (path === '/api/auth/profile' && req.method === 'PATCH') {
    const authError = authenticateRequest(req);
    if (authError) {
      sendJson(res, 401, { error: authError });
      return true;
    }

    try {
      const body = await readBody(req);
      const updates = {};
      if (body.display_name !== undefined) updates.display_name = String(body.display_name).slice(0, 50);
      if (body.avatar_url !== undefined) {
        const url = String(body.avatar_url);
        // Allow data URLs (base64 avatars) up to 50KB, regular URLs up to 500 chars
        const maxLen = url.startsWith('data:') ? 50_000 : 500;
        updates.avatar_url = url.slice(0, maxLen);
      }

      if (Object.keys(updates).length === 0) {
        sendJson(res, 400, { error: 'No valid fields to update' });
        return true;
      }

      updateUser(req.user.id, updates);
      const user = findUserById(req.user.id);
      const { password_hash, ...safe } = user;
      sendJson(res, 200, { user: safe });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Update failed' });
    }
    return true;
  }

  // POST /api/auth/change-password (requires auth)
  if (path === '/api/auth/change-password' && req.method === 'POST') {
    const authError = authenticateRequest(req);
    if (authError) {
      sendJson(res, 401, { error: authError });
      return true;
    }

    try {
      const body = await readBody(req);
      const { current_password, new_password } = body;

      if (!current_password || !new_password) {
        sendJson(res, 400, { error: 'current_password and new_password are required' });
        return true;
      }

      const user = findUserById(req.user.id);
      if (!verifyPassword(current_password, user.password_hash)) {
        sendJson(res, 401, { error: 'Current password is incorrect' });
        return true;
      }

      const pwErrors = validatePassword(new_password);
      if (pwErrors.length > 0) {
        sendJson(res, 400, { error: pwErrors.join('. ') });
        return true;
      }

      updateUser(req.user.id, { password_hash: hashPassword(new_password) });
      logoutAll(req.user.id);
      sendJson(res, 200, { ok: true, message: 'Password changed. All sessions revoked.' });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Password change failed' });
    }
    return true;
  }

  return false;
}
