import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { problem } from './common.mjs';

export const providerId = 'zenmux-video';
export const virtualBase = 'https://zenmux.ai/api/v1';

export function sourceId(value) {
  const id = String(value ?? '').trim() || 'zenmux';
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id) || id === providerId) {
    throw problem(400, 'Enter the ID of the existing ZenMux API-key provider in Magpie');
  }
  return id;
}

export async function gatewayOrigin(directory) {
  const address = process.env.MAGPIE_ADDR || JSON.parse(await readFile(join(directory, 'gateway.json'), 'utf8')).addr;
  const url = new URL(address.includes('://') ? address : `http://${address}`);
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = '127.0.0.1';
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw problem(400, 'The adapter requires a Magpie gateway on loopback');
  }
  return url.origin;
}

async function ensureOK(response) {
  if (response.ok) return response;
  const raw = await response.text();
  let message;
  try {
    const parsed = JSON.parse(raw);
    message = parsed.error?.message || parsed.message || (typeof parsed.error === 'string' && parsed.error);
  } catch { /* Some gateways return plain text. */ }
  throw problem(response.status, String(message || raw || response.statusText).slice(0, 1200));
}

function downloadURL(value) {
  let url;
  try { url = new URL(value); } catch { throw problem(502, 'ZenMux returned an invalid video URL'); }
  const host = url.hostname;
  // Signed media URLs originate in the upstream job result. Never let them carry
  // our gateway identity, select a local service or redirect to a different resource.
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !host.includes('.') || host.endsWith('.') || /\.(localhost|local|internal|lan)$/i.test(host) || isIP(host) || host.startsWith('[')) {
    throw problem(502, 'ZenMux returned an unsupported video download host');
  }
  return url;
}

export function createApi(origin, source, signal, request = fetch) {
  const base = `${origin}/v1/magpie/native/${sourceId(source)}`;
  async function raw(path, { method = 'GET', body } = {}) {
    const dest = new URL(path, 'https://zenmux.ai');
    if (dest.origin !== 'https://zenmux.ai' || !dest.pathname.startsWith('/api/') || path !== dest.pathname + dest.search) {
      throw problem(400, 'Invalid ZenMux API path');
    }
    const headers = { authorization: 'Bearer magpie-zenmux-video' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return ensureOK(await request(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'error' }));
  }
  return {
    async json(path, options) {
      const response = await raw(path, options);
      try { return await response.json(); } catch { throw problem(502, 'ZenMux did not return valid JSON'); }
    },
    async media(media) {
      if (typeof media?.base64 === 'string' && media.base64.length) {
        const bytes = Buffer.from(media.base64, 'base64');
        if (!bytes.length) throw problem(502, 'ZenMux returned an empty video');
        return new Response(bytes, { headers: { 'content-type': media.mimeType || 'video/mp4', 'content-length': String(bytes.length) } });
      }
      const url = downloadURL(media?.url);
      const response = url.hostname === 'zenmux.ai' && url.pathname.startsWith('/api/')
        ? await raw(url.pathname + url.search)
        : await ensureOK(await request(url, { signal, redirect: 'error' }));
      const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if (!response.body || (type && !type.startsWith('video/') && type !== 'application/octet-stream' && type !== 'binary/octet-stream')) {
        await response.body?.cancel();
        throw problem(502, 'The upstream download did not return video content');
      }
      const headers = new Headers({ 'content-type': type.startsWith('video/') ? type : 'video/mp4' });
      const length = response.headers.get('content-length');
      if (length && !response.headers.has('content-encoding')) headers.set('content-length', length);
      return new Response(response.body, { headers });
    },
  };
}
