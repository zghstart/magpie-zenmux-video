import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { problem } from './common.mjs';
import { providerId, virtualBase } from './gateway.mjs';

export const validModel = (id) => typeof id === 'string' && id.length <= 255 && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(id);
const ttl = 5 * 60 * 1000;

export function createCatalog(directory) {
  const accounts = new Map();
  const cacheDir = join(directory, 'zenmux-video-catalog');

  async function readSnapshot(path) {
    try {
      const snapshot = JSON.parse(await readFile(path, 'utf8'));
      if (!Array.isArray(snapshot.entries) || !Number.isFinite(snapshot.expires)) return;
      if (!snapshot.entries.every(e => validModel(e?.id) && ['native', 'vertex', 'interactions'].includes(e.protocol) && Array.isArray(e.inputs))) return;
      return { models: new Map(snapshot.entries.map(e => [e.id, e])), expires: snapshot.expires };
    } catch { /* First login or an incomplete cache from an older version. */ }
  }

  async function saveSnapshot(path, result) {
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, JSON.stringify({ expires: result.expires, entries: [...result.models.values()] }), { mode: 0o600, flag: 'wx' });
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async function refresh(api) {
    const results = await Promise.allSettled([
      api.json('/api/v1/models').then((r) => readList(r.data, false)),
      api.json('/api/vertex-ai/v1beta/models').then((r) => readList(r.models, true)),
    ]);
    const success = results.filter((r) => r.status === 'fulfilled');
    if (!success.length) throw results[0].reason;
    const models = new Map();
    for (const { value } of success) {
      for (const entry of value) if (!models.has(entry.id)) models.set(entry.id, entry);
    }
    return { models, expires: Date.now() + (success.length === 2 ? ttl : 15_000) };
  }
  return async function catalog(source, openApi, verify = false) {
    const saved = accounts.get(source);
    if (saved?.expires > Date.now() && !verify) return saved.models;
    if (saved?.pending) {
      if (!verify || saved.verify) return saved.pending;
      // Linking an account needs a live check even when a cached listing is in flight.
      return saved.pending.catch(() => {}).then(() => catalog(source, openApi, true));
    }
    const path = join(cacheDir, `${source}.json`);
    const load = async () => {
      // Magpie may ask for signed-in models before its own gateway listens.
      // Only a previous successful listing for this source can span startup.
      const snapshot = verify ? undefined : saved?.models ? saved : await readSnapshot(path);
      if (snapshot?.expires > Date.now()) return snapshot;
      let result;
      try {
        result = await refresh(await openApi());
      } catch (err) {
        if (snapshot && (!err.status || err.status >= 500)) return { models: snapshot.models, expires: Date.now() + 15_000 };
        throw err;
      }
      await saveSnapshot(path, result);
      return result;
    };
    const pending = load().then((result) => {
      accounts.set(source, result);
      return result.models;
    }, (err) => { accounts.delete(source); throw err; });
    accounts.set(source, { pending, verify });
    return pending;
  };
}

function readList(rows, vertex) {
  if (!Array.isArray(rows)) throw problem(502, 'Unrecognized ZenMux model catalog');
  const list = [];
  for (const row of rows) {
    const id = vertex ? row.name : row.id;
    const outputs = vertex ? row.outputModalities : row.output_modalities;
    if (!validModel(id) || !Array.isArray(outputs) || !outputs.includes('video')) continue;
    const protocol = /^google\/gemini-omni(?:-|$)/.test(id) ? 'interactions' : vertex ? 'vertex' : 'native';
    list.push({ id, protocol, name: row.display_name || row.displayName || id, inputs: row.input_modalities || row.inputModalities || [] });
  }
  return list;
}

export function magpieModels(entries) {
  return Object.fromEntries(Array.from(entries.values(), ({ id, name, inputs }) => [id, {
    id, providerID: providerId, name,
    api: { id, npm: '@ai-sdk/openai-compatible', url: virtualBase },
    capabilities: { input: { text: true, image: inputs.includes('image') }, output: { video: true } },
  }]));
}
