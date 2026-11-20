import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import ZenMuxVideo from '../index.mjs';
import { videoSize } from '../lib/common.mjs';

const native = 'bytedance/doubao-seedance-2.0';
const omni = 'google/gemini-omni-1.2-flash';
const veo = 'google/veo-3.1-generate-001';
const video = Buffer.from('AAAAGGZ0eXBtcDQyAAAAAG1wNDJpc29t', 'base64');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-zenmux-video-test-'));
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const url = req.url.replace('/v1/magpie/native/my-relay', '');
    calls.push({ url, method: req.method, body, auth: req.headers.authorization });
    let payload;
    if (url === '/api/v1/models') payload = { data: [
      { id: native, input_modalities: ['image', 'text'], output_modalities: ['video'] },
      { id: 'other/understanding', input_modalities: ['video'], output_modalities: ['text'] },
    ] };
    else if (url.endsWith('/v1beta/models')) payload = { models: [native, omni, veo].map(name => ({ name, inputModalities: ['text'], outputModalities: ['video'] })) };
    else if (url === '/api/v1/videos' && req.method === 'POST') payload = { id: 'sample-task', status: 'queued', model: native };
    else if (url === '/api/v1/videos/sample-task') payload = { id: 'sample-task', model: native, status: 'succeeded', content: { video_url: 'https://zenmux.ai/api/files/clip.mp4' } };
    else if (url === '/api/files/clip.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(video); return; }
    else if (url.endsWith(':predictLongRunning')) payload = { name: 'publishers/google/models/veo-3.1-generate-001/operations/123' };
    else if (url.endsWith(':fetchPredictOperation')) payload = { done: true, response: { videos: [{ bytesBase64Encoded: video.toString('base64') }] } };
    else if (url === '/api/v1/interactions') payload = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: video.toString('base64'), mime_type: 'video/mp4' }] }] };
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const old = process.env.MAGPIE_ADDR;
  process.env.MAGPIE_ADDR = `127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (old == null) delete process.env.MAGPIE_ADDR; else process.env.MAGPIE_ADDR = old;
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const plugin = await ZenMuxVideo({ directory });
  const auth = { type: 'api', key: 'my-relay' };
  const loader = p => p.auth.loader(async () => auth);
  return { directory, calls, plugin, auth, loader };
}

test('provider discovers only film outputs and uses the saved Magpie source for every request', async t => {
  const { plugin, calls, auth, loader, directory } = await fixture(t);
  const link = await plugin.auth.methods[0].authorize({ source: 'my-relay' });
  assert.equal(link.key, 'my-relay');
  const models = await plugin.provider.models({}, { auth });
  assert.deepEqual(Object.keys(models).sort(), [native, omni, veo].sort());
  assert.equal(models[native].capabilities.output.video, true);
  const client = await loader(plugin);
  for (const model of [native, veo, omni]) {
    const endpoint = client.baseURL + '/videos';
    const response = await client.fetch(endpoint, { method: 'POST', body: JSON.stringify({ model, prompt: 'A camera pans over a lake', seconds: '4' }) });
    assert.equal(response.status, 200);
    const start = await response.json();
    assert.equal(start.model, model);
    // Fresh plugin instance models a new host serving a saved Magpie task.
    const fresh = await loader(await ZenMuxVideo({ directory }));
    let state;
    for (let attempt = 0; attempt < 120; attempt++) {
      const status = await fresh.fetch(`${endpoint}/${start.id}`);
      assert.equal(status.status, 200);
      state = await status.json();
      if (state.status === 'completed' || state.status === 'failed') break;
      await delay(10);
    }
    assert.equal(state.status, 'completed', JSON.stringify(state.error));
    const content = await fresh.fetch(`${endpoint}/${start.id}/content`);
    assert.equal(content.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), video);
    const another = await plugin.auth.loader(async () => ({ type: 'api', key: 'other-relay' }));
    assert.equal((await another.fetch(`${endpoint}/${start.id}/content`)).status, 404);
  }
  const submitted = calls.find(c => c.method === 'POST' && c.url === '/api/v1/videos');
  assert.deepEqual(submitted.body.content, [{ type: 'text', text: 'A camera pans over a lake' }]);
  assert.equal(submitted.body.duration, 4);
  assert.equal(calls.filter(c => c.url === '/api/v1/interactions').length, 1);
  assert.ok(calls.every(c => c.auth === 'Bearer magpie-zenmux-video'));
});

test('MiniMax 768p and portrait Omni 4K retain their requested resolution', () => {
  assert.deepEqual(videoSize('1366x768'), { ratio: '16:9', resolution: '768p' });
  assert.deepEqual(videoSize('2160x3840'), { ratio: '9:16', resolution: '2160p' });
});
