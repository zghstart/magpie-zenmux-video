import { problem } from './lib/common.mjs';
import { createApi, gatewayOrigin, providerId, sourceId, virtualBase } from './lib/gateway.mjs';
import { createCatalog, magpieModels, validModel } from './lib/catalog.mjs';
import { omniJobs } from './lib/omni-jobs.mjs';
import * as native from './lib/native.mjs';
import * as vertex from './lib/vertex.mjs';
import * as interactions from './lib/interactions.mjs';

const adapters = { native, vertex, interactions };

// Carry the protocol in the task ID so polling still works after a catalog change
// or a Magpie restart. Only the source provider ID is recorded, never its API key.
function jobId(source, protocol, model, id) {
  if (typeof id !== 'string' || !id || id.length > 4096) throw problem(502, 'ZenMux returned an invalid task ID');
  return Buffer.from(JSON.stringify([source, protocol, model, id])).toString('base64url');
}

function parseJob(id, source) {
  if (id.length <= 6500 && /^[A-Za-z0-9_-]+$/.test(id)) {
    let parts;
    try { parts = JSON.parse(Buffer.from(id, 'base64url').toString()); } catch { /* Unknown task ID. */ }
    if (Array.isArray(parts) && parts.length === 4 && parts[0] === source && Object.hasOwn(adapters, parts[1]) &&
        validModel(parts[2]) && typeof parts[3] === 'string' && parts[3].length <= 4096 && parts[3].length) return parts;
  }
  throw problem(404, 'Unknown ZenMux video task');
}

function videoObject(id, model, state) {
  const out = { object: 'video', id, model, status: state.status };
  if (state.progress != null) out.progress = state.progress;
  if (state.error) out.error = state.error;
  return Response.json(out);
}

export default async function ZenMuxVideo({ directory = process.cwd() } = {}) {
  const catalog = createCatalog();
  const jobs = omniJobs(directory);
  // A finished Vertex poll already contains the film. Keep one recent result for
  // the following /content GET; the upstream operation remains the durable source.
  let recentVertex;
  let expiry;
  const bind = async (source, signal) => createApi(await gatewayOrigin(directory), source, signal);
  const models = async (source, signal) => catalog(source, await bind(source, signal));
  const signedSource = (auth) => {
    if (auth?.type !== 'api' || !auth.key) throw problem(401, 'Connect an existing ZenMux provider in the ZenMux Video plugin');
    return sourceId(auth.key);
  };
  return {
    async config(config) {
      config.provider ??= {};
      config.provider[providerId] = { name: 'ZenMux Video', npm: '@ai-sdk/openai-compatible', api: virtualBase, models: {} };
    },
    provider: {
      id: providerId,
      async models(_provider, { auth, signal } = {}) {
        if (!auth) return {};
        return magpieModels(await models(signedSource(auth), signal));
      },
    },
    auth: {
      provider: providerId,
      methods: [{
        type: 'api', label: 'Use an existing Magpie provider / 复用已有供应商',
        prompts: [{ type: 'text', key: 'source', message: 'Magpie provider ID / 供应商 ID（默认 zenmux）', placeholder: 'zenmux' }],
        async authorize(inputs = {}, { signal } = {}) {
          const source = sourceId(inputs.source);
          const found = await models(source, signal);
          if (!found.size) throw new Error('The provider did not advertise any ZenMux video models');
          return { type: 'success', key: source, metadata: { email: source } };
        },
      }],
      async loader(getAuth) {
        return { baseURL: virtualBase, apiKey: providerId, async fetch(input, init) {
          try {
            const req = new Request(input, init);
            const route = /^\/api\/v1\/videos(?:\/([^/]+)(\/content)?)?$/.exec(new URL(req.url).pathname);
            if (!route) throw problem(404, 'Unknown ZenMux Video route');
            const source = signedSource(await getAuth());
            const api = await bind(source, req.signal);
            if (req.method === 'POST' && !route[1]) {
              let body;
              try { body = await req.json(); } catch { throw problem(400, 'A JSON video request is required'); }
              if (!validModel(body?.model)) throw problem(400, 'A ZenMux publisher/model ID is required');
              const model = body.model;
              const protocol = (await catalog(source, api)).get(model)?.protocol;
              if (!protocol) throw problem(400, 'This model is not in the ZenMux video catalog');
              let state;
              if (protocol === 'interactions') {
                state = await jobs.start(source, model, async () => {
                  const background = await bind(source, AbortSignal.timeout(15 * 60 * 1000));
                  const result = await interactions.start(background, body);
                  if (result.status !== 'completed' || !result.media) throw problem(502, result.error?.message || 'ZenMux returned no completed video');
                  return background.media(result.media);
                });
              } else {
                state = await adapters[protocol].start(api, body);
              }
              return videoObject(jobId(source, protocol, model, state.id), model, state);
            }
            if (req.method !== 'GET' || !route[1]) throw problem(405, 'Unsupported video operation');
            const id = route[1];
            const [, protocol, model, remoteId] = parseJob(id, source);
            const content = Boolean(route[2]);
            if (protocol === 'interactions') {
              const state = await jobs.read(source, model, remoteId, content);
              return content ? state : videoObject(id, model, state);
            }
            let state;
            if (protocol === 'vertex' && recentVertex?.id === id) {
              state = recentVertex.state;
            } else {
              state = await adapters[protocol].poll(api, model, remoteId, content || protocol === 'vertex');
              if (protocol === 'vertex' && !content && state.status === 'completed') {
                clearTimeout(expiry);
                recentVertex = { id, state };
                expiry = setTimeout(() => { recentVertex = undefined; }, 60_000);
                expiry.unref?.();
              }
            }
            if (!content) return videoObject(id, model, state);
            if (state.status !== 'completed') throw problem(409, state.error?.message || 'Video is still being generated');
            return await api.media(state.media);
          } catch (e) {
            const status = e.status >= 400 && e.status <= 599 ? e.status : ['TimeoutError', 'AbortError'].includes(e.name) ? 504 : 502;
            return Response.json({ error: { message: e.message || 'ZenMux request failed' } }, { status, headers: { 'X-Magpie-Sign-In': 'kept' } });
          }
        } };
      },
    },
  };
}
