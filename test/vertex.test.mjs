import assert from 'node:assert/strict'
import test from 'node:test'
import { poll, start } from '../lib/vertex.mjs'

const model = 'google/veo-3.1-generate-001'
const path = 'publishers/google/models/veo-3.1-generate-001'
const name = `${path}/operations/job-123`
const source = 'data:image/png;base64,aW1hZ2U='
const frame = { mimeType: 'image/png', bytesBase64Encoded: 'aW1hZ2U=' }

function reply(response) {
  return { json: async () => response }
}

test('submits first and last frames, Magpie size and duration, and Vertex generation settings', async () => {
  const api = { async json(url, request) {
    assert.equal(url, `/api/vertex-ai/v1/${path}:predictLongRunning`)
    assert.deepEqual(request, { method: 'POST', body: {
      instances: [{ prompt: 'moving clouds', image: frame, lastFrame: frame }],
      parameters: { aspectRatio: '16:9', resolution: '720p', durationSeconds: 8,
        seed: 0, generateAudio: false, negativePrompt: 'rain', enhancePrompt: false },
    } })
    return { name }
  } }
  assert.deepEqual(await start(api, { model, prompt: 'moving clouds', seconds: '8', size: '1280x720',
    input_reference: source, last_frame: source, seed: 0, generate_audio: false,
    negativePrompt: 'rain', parameters: { enhancePrompt: false } }), { id: name, status: 'queued' })
})

test('submits multiple distinct asset references in one model-specific request', async () => {
  const resource = 'publishers/alibaba/models/happyhorse-1.0'
  const api = { async json(url, { body }) {
    assert.equal(url, `/api/vertex-ai/v1/${resource}:predictLongRunning`)
    assert.deepEqual(body.instances[0].referenceImages, [
      { image: frame, referenceType: 'asset' },
      { image: { mimeType: 'image/jpeg', bytesBase64Encoded: 'YWJj' }, referenceType: 'asset' },
    ])
    return { name: `${resource}/operations/job2` }
  } }
  await start(api, { model: 'alibaba/happyhorse-1.0', prompt: 'A still life',
    reference_images: [source, 'data:image/jpeg;base64,YWJj'] })
})

test('rejects conflicting, unsupported, or multiple-output requests before submission', async () => {
  const api = { json() { assert.fail('unexpected generation request') } }
  for (const [options, reason] of [
    [{ seconds: 4, durationSeconds: 8 }, /conflicting/i], [{ last_frame: source }, /first frame/i],
    [{ seconds: '8s' }, /positive integer/i], [{ numberOfVideos: 2 }, /one video/i],
    [{ arbitrary: true }, /unsupported/i], [{ parameters: [] }, /object/i],
  ]) await assert.rejects(start(api, { model, prompt: 'clouds', ...options }), reason)
})

test('polls with the saved operation name and returns bytes only on content requests', async () => {
  const id = `projects/p/locations/us-east1/${name}`
  let response = { name: id }
  const api = { async json(url, request) {
    assert.equal(url, `/api/vertex-ai/v1/${path}:fetchPredictOperation`)
    assert.deepEqual(request, { method: 'POST', body: { operationName: id } })
    return response
  } }
  assert.deepEqual(await poll(api, model, id), { status: 'in_progress' })
  response = { name: id, done: true, response: { videos: [{ bytesBase64Encoded: 'eA==', mimeType: 'video/webm', gcsUri: 'gs://bucket/key' }] } }
  assert.deepEqual(await poll(api, model, id), { status: 'completed' })
  assert.deepEqual(await poll(api, model, id, true), { status: 'completed', media: { base64: 'eA==', mimeType: 'video/webm' } })
})

test('relays HTTPS video URLs and reports inaccessible storage results', async () => {
  const fetchUri = gcsUri => poll(reply({ done: true, response: { videos: [{ gcsUri }] } }), model, name, true)
  const url = 'https://media.example/clip.mp4?sig=123'
  assert.deepEqual(await fetchUri(url), { status: 'completed', media: { url } })
  assert.equal((await fetchUri('gs://private/file.mp4')).error.code, 'unsupported_media_uri')
  assert.equal((await fetchUri('file:///etc/hosts')).status, 'failed')
})

test('exposes upstream and moderation failures and missing output', async () => {
  assert.deepEqual(await poll(reply({ done: true, error: { code: 7, message: 'Permission denied' } }), model, name),
    { status: 'failed', error: { message: 'Permission denied', code: '7' } })
  const filtered = { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['Safety policy'] }
  assert.deepEqual(await poll(reply({ done: true, response: filtered }), model, name),
    { status: 'failed', error: { message: 'Safety policy', code: 'content_filtered' } })
  assert.equal((await poll(reply({ done: true, response: {} }), model, name)).error.code, 'missing_media')
})

test('binds operation names to the selected model and rejects mismatched upstream replies', async () => {
  for (const id of ['https://api.example/operation', `${name}?key=value`, name.replace('google', 'elsewhere')]) {
    await assert.rejects(poll({ json() { assert.fail('unexpected poll') } }, model, id), /operation name/i)
  }
  await assert.rejects(poll(reply({ name: `${name}2` }), model, name), /different operation/i)
})
