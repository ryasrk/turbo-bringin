/**
 * HTTP Response Compression Utility
 * Provides gzip compression for JSON API responses.
 * Only compresses responses above a size threshold.
 */

import { gzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);

/** Minimum response size (bytes) to bother compressing */
const MIN_COMPRESS_SIZE = 1024;

/**
 * Check if the client accepts gzip encoding.
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function acceptsGzip(req) {
  const accept = req?.headers?.['accept-encoding'] || '';
  return accept.includes('gzip');
}

/**
 * Send a JSON response with optional gzip compression.
 * Falls back to uncompressed if the client doesn't accept gzip
 * or the payload is too small to benefit from compression.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {number} statusCode
 * @param {any} data
 * @param {Record<string, string>} [extraHeaders]
 */
export async function sendCompressedJson(req, res, statusCode, data, extraHeaders = {}) {
  const json = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  };

  if (json.length >= MIN_COMPRESS_SIZE && acceptsGzip(req)) {
    try {
      const compressed = await gzipAsync(Buffer.from(json, 'utf-8'));
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = String(compressed.length);
      headers['Vary'] = 'Accept-Encoding';
      res.writeHead(statusCode, headers);
      res.end(compressed);
      return;
    } catch {
      // Fall through to uncompressed on error
    }
  }

  headers['Content-Length'] = String(Buffer.byteLength(json, 'utf-8'));
  res.writeHead(statusCode, headers);
  res.end(json);
}
