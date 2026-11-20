import { problem } from './common.mjs';
import { providerId, virtualBase } from './gateway.mjs';

export const validModel = (id) => typeof id === 'string' && id.length <= 255 && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(id);
const ttl = 5 * 60 * 1000;

export function createCatalog() {
  const accounts = new Map();
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
  return async function catalog(source, api) {
    const saved = accounts.get(source);
    if (saved?.expires > Date.now()) return saved.models;
    if (saved?.pending) return saved.pending;
    const pending = refresh(api).then((result) => {
      accounts.set(source, result);
      return result.models;
    }, (err) => { accounts.delete(source); throw err; });
    accounts.set(source, { pending });
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
