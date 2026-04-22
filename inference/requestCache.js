import { createHash } from 'node:crypto';

export const CACHE_TTLS = {
  '/v1/models': 300,
  '/v1/chat/completions': 120,
  '/v1/responses': 120,
  '/v1/messages': 120,
};

export function parseJsonSafely(rawBody) {
  if (typeof rawBody !== 'string' || !rawBody.trim()) return null;

  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

export function shouldCacheRequest(pathname, method, rawBody = '') {
  if (method === 'GET') {
    return pathname === '/v1/models';
  }

  if (method !== 'POST' || !(pathname in CACHE_TTLS)) {
    return false;
  }

  const payload = parseJsonSafely(rawBody);
  if (!payload || payload.stream === true) {
    return false;
  }

  return pathname === '/v1/chat/completions'
    || pathname === '/v1/responses'
    || pathname === '/v1/messages';
}

export function buildCacheKey(pathname, method, rawBody = '') {
  return createHash('sha256')
    .update(`${method}:${pathname}:${rawBody}`)
    .digest('hex');
}

export class RequestCache {
  constructor({ redisClient = null, keyPrefix = 'tenrary:enowxai' } = {}) {
    this.redisClient = redisClient;
    this.keyPrefix = keyPrefix;
    this.memoryCache = new Map();
    this.inflight = new Map();
  }

  getCacheKey(key) {
    return `${this.keyPrefix}:${key}`;
  }

  async get(key) {
    const namespacedKey = this.getCacheKey(key);

    if (this.redisClient?.isReady) {
      const cached = await this.redisClient.get(namespacedKey);
      return cached ? JSON.parse(cached) : null;
    }

    const cached = this.memoryCache.get(namespacedKey);
    if (!cached || cached.expiresAt <= Date.now()) {
      this.memoryCache.delete(namespacedKey);
      return null;
    }

    return cached.value;
  }

  async set(key, value, ttlSeconds) {
    const namespacedKey = this.getCacheKey(key);

    if (this.redisClient?.isReady) {
      await this.redisClient.set(namespacedKey, JSON.stringify(value), { EX: ttlSeconds });
      return;
    }

    this.memoryCache.set(namespacedKey, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async getOrCompute(key, ttlSeconds, compute, options = {}) {
    const shouldCache = typeof options.shouldCache === 'function'
      ? options.shouldCache
      : () => true;
    const cached = await this.get(key);
    if (cached) {
      return { value: cached, source: 'cache' };
    }

    if (this.inflight.has(key)) {
      return { value: await this.inflight.get(key), source: 'coalesced' };
    }

    const pending = (async () => {
      const freshValue = await compute();
      if (shouldCache(freshValue)) {
        await this.set(key, freshValue, ttlSeconds);
      }
      return freshValue;
    })();

    this.inflight.set(key, pending);

    try {
      return { value: await pending, source: 'fresh' };
    } finally {
      this.inflight.delete(key);
    }
  }
}