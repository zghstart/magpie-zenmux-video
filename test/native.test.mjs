import assert from 'node:assert/strict';
import test from 'node:test';
import { poll, start } from '../lib/native.mjs';

const id = '59600cb2cb854b519a6b3a44a7a21011';
const dataUrl = 'data:image/png;base64,AQID';

// These are the `videos` options published on the corresponding ZenMux model pages.
const groups = [
  [['bytedance/doubao-seedance-2.0', 'bytedance/doubao-seedance-2.5', 'bytedance/doubao-seedance-2.5-flash'], { return_last_frame: true, seed: -1 }],
  [['klingai/kling-3.0', 'klingai/kling-3.0-omni'], { watermark: false }],
  [['klingai/kling-3.0-turbo', 'bfl/flux-3-video'], { generate_audio: false }],
  [['minimax/minimax-h3', 'minimax/minimax-h3-highspeed', 'minimax/minimax-h3-lite', 'minimax/minimax-h3-max'], { callback_url: 'https://example.org/done' }],
  [['alibaba/wan3.0-video', 'alibaba/wan3.0-video-prime'], { watermark: false, seed: 0 }],
  [['pixverse/c1'], { seed: 23 }],
  [['pixverse/v6'], { generate_multi_clip_switch: true }],
];

test('every catalogued native model submits text through the common ZenMux video protocol', async () => {
  for (const [models, options] of groups) {
    for (const model of models) {
      const prompt = 'Snow falling into a mountain stream';
      const api = { async json(path, init) {
        assert.equal(path, '/api/v1/videos');
        assert.deepEqual(init, { method: 'POST', body: {
          model, content: [{ type: 'text', text: prompt }], ratio: '16:9', duration: 5, ...options,
        } });
        return { id, model, status: 'queued' };
      } };
      assert.deepEqual(await start(api, { model, prompt, size: '16:9', seconds: '5', ...options }), { id, status: 'queued' });
    }
  }
});

test('native frames, reference images, and extra typed content keep their media roles', async () => {
  const reference = 'https://example.org/reference.jpg';
  const sound = { type: 'audio_url', role: 'reference_audio', audio_url: { url: 'https://example.org/sound.wav' } };
  const model = 'bytedance/doubao-seedance-2.5';
  const modes = [
    { input: { input_reference: dataUrl, last_frame: dataUrl }, expected: [
      { type: 'image_url', role: 'first_frame', image_url: { url: dataUrl } },
      { type: 'image_url', role: 'last_frame', image_url: { url: dataUrl } },
    ] },
    { input: { reference_images: [reference], content: [sound] }, expected: [
      { type: 'image_url', role: 'reference_image', image_url: { url: reference } },
      sound,
    ] },
  ];
  for (const { input, expected } of modes) {
    const api = { async json(path, init) {
      assert.deepEqual(init.body, { model, ratio: '9:16', resolution: '720p',
        content: [{ type: 'text', text: 'Follow the performer' }, ...expected] });
      return { id, status: 'running' };
    } };
    assert.deepEqual(await start(api, { model, prompt: 'Follow the performer', size: '720x1280', ...input }),
      { id, status: 'in_progress' });
  }
});

test('native validation rejects malformed request settings before submission', async () => {
  const api = { json: () => assert.fail('Unexpected HTTP request') };
  const body = { model: 'alibaba/wan3.0-video', prompt: 'A bird' };
  for (const options of [{ seconds: 'no' }, { duration: 8, seconds: '4' }, { resolution: '480p', size: '1280x720' },
    { input_reference: 'file:///tmp/frame.png' }, { reference_images: dataUrl }, { content: {} }]) {
    await assert.rejects(start(api, { ...body, ...options }), { status: 400 });
  }
});

test('saved native IDs can be polled independently and only the video URL becomes media', async () => {
  const model = 'klingai/kling-3.0';
  const url = 'https://example.org/result.mp4';
  const completed = { id, model, status: 'succeeded', content: { video_url: url, last_frame_url: 'https://example.org/frame.jpg' } };
  const api = { async json(path) { assert.equal(path, `/api/v1/videos/${id}`); return completed; } };
  assert.deepEqual(await poll(api, model, id), { status: 'completed' });
  assert.deepEqual(await poll(api, model, id, true), { status: 'completed', media: { url } });
  assert.deepEqual(await start({ json: async () => completed }, { model, prompt: 'A bird' }), { id, status: 'completed' });
});

test('native polling preserves provider failures and HTTP errors and rejects unusable results', async () => {
  const model = 'pixverse/v6';
  const error = { code: 'generation_failed', message: 'Media format unsupported' };
  const polling = job => poll({ json: async () => job }, model, id, true);
  assert.deepEqual(await polling({ id, status: 'failed', error }), { status: 'failed', error });
  assert.equal((await polling({ id, status: 'succeeded', content: { last_frame_url: 'https://example.org/frame.jpg' } })).error.code, 'missing_media');
  await assert.rejects(polling({ id, status: 'unexpected' }), { status: 502 });
  const expired = Object.assign(new Error('Task expired'), { status: 404 });
  await assert.rejects(poll({ json: async () => { throw expired; } }, model, id), e => e === expired);
});

test('native job IDs cannot alter the API path', async () => {
  const api = { json: () => assert.fail('Unexpected HTTP request') };
  for (const unsafe of ['', 'a/b', '..', '../jobs', '%2e%2e', 'abc?job=two', 'x#y']) {
    await assert.rejects(poll(api, 'pixverse/c1', unsafe), { status: 400 });
  }
  await assert.rejects(start({ json: async () => ({ id: '../bad', status: 'queued' }) },
    { model: 'pixverse/c1', prompt: 'A bird' }), { status: 502 });
});
