import assert from 'node:assert/strict'
import test from 'node:test'
import { start } from '../lib/interactions.mjs'

const current = 'google/gemini-omni-1.2-flash'
const preview = 'google/gemini-omni-1.1-flash-preview'
const prompt = 'A cloud drifts across a mountain ridge.'
const png = 'data:image/png;base64,AQ=='
const jpeg = 'data:image/jpeg;base64,Ag=='
const content = { type: 'video', mime_type: 'video/mp4', data: 'Aw==' }
const completed = {
  id: 'v1_omni-id', status: 'completed',
  steps: [
    { type: 'user_input', content: [{ type: 'video', data: 'BA==' }] },
    { type: 'model_output', content: [{ type: 'text', text: 'Generated.' }, content] },
  ],
}

function upstream(response = completed) {
  const calls = []
  return { calls, async json(path, options) { calls.push({ path, ...options }); return response } }
}

test('Omni 1.2 creates a stateless video interaction and returns only generated media', async () => {
  const api = upstream()
  const result = await start(api, { model: current, prompt, seconds: '15', size: '16:9', seed: 17 })
  assert.deepEqual(api.calls, [{
    method: 'POST', path: '/api/v1/interactions', body: {
      model: current,
      input: [{ type: 'text', text: prompt }],
      response_format: [{ type: 'video', delivery: 'inline', aspect_ratio: '16:9', duration: '15s' }],
      generation_config: { seed: 17, video_config: { task: 'text_to_video' } },
      stream: false, background: false, store: false,
    },
  }])
  assert.deepEqual(result, { id: completed.id, status: 'completed', media: { base64: 'Aw==', mimeType: 'video/mp4' } })
})

test('Omni preview sends ordered first and last frames with native output dimensions', async () => {
  const api = upstream()
  await start(api, { model: preview, prompt, size: '720x1280', seconds: 10, input_reference: png, last_frame: jpeg })
  const { body } = api.calls[0]
  assert.deepEqual(body.input, [
    { type: 'image', mime_type: 'image/png', data: 'AQ==' },
    { type: 'image', mime_type: 'image/jpeg', data: 'Ag==' },
    { type: 'text', text: prompt },
  ])
  assert.equal(body.generation_config.video_config.task, 'image_to_video')
  assert.deepEqual(body.response_format[0], { type: 'video', delivery: 'inline', aspect_ratio: '9:16', resolution: '720p', duration: '10s' })
})

test('subject references are distinguished from frames, including mixed-role input', async () => {
  const api = upstream()
  await start(api, { model: current, prompt, reference_images: [jpeg, png] })
  await start(api, { model: current, prompt, input_reference: png, reference_images: [jpeg] })
  const [references, mixed] = api.calls.map(call => call.body)
  assert.equal(references.generation_config.video_config.task, 'reference_to_video')
  assert.deepEqual(references.input.filter(part => part.type === 'image').map(part => part.data), ['Ag==', 'AQ=='])
  assert.equal(mixed.generation_config, undefined)
  assert.match(mixed.input[0].text, /first frame/)
  assert.match(mixed.input[2].text, /references/)
  assert.equal(mixed.input.at(-1).text, prompt)
})

test('invalid duration, format and reference counts fail before submission', async () => {
  const api = upstream()
  for (const [params, message] of [
    [{ model: preview, seconds: 11 }, /3 to 10/],
    [{ input_reference: png, last_frame: jpeg, seconds: 15 }, /3 to 10/],
    [{ seconds: 2.5 }, /whole number/],
    [{ size: '1:1' }, /aspect ratio/],
    [{ reference_images: Array(7).fill(png) }, /six reference/],
    [{ negative_prompt: 'clouds' }, /negative_prompt/],
  ]) await assert.rejects(start(api, { model: current, prompt, ...params }), message)
  assert.equal(api.calls.length, 0)
})

test('unexpected upstream states and malformed media cannot complete a job', async () => {
  for (const [response, message] of [
    [{ status: 'failed', error: { message: 'Media generation blocked' } }, /generation blocked/],
    [{ status: 'in_progress' }, /in_progress/],
    [{ status: 'completed', steps: [{ type: 'user_input', content: [content] }] }, /without a generated video/],
    [{ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Unable to generate this scene.' }] }] }, /Unable to generate/],
    [{ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: 'QQ=' }] }] }, /invalid base64/],
    [{ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', uri: 'gs://bucket/object' }] }] }, /file URI/],
  ]) {
    const api = upstream(response)
    await assert.rejects(start(api, { model: current, prompt }), message)
    assert.equal(api.calls.length, 1)
  }
})

test('missing or unsafe upstream identifiers cannot become local paths', async () => {
  for (const id of [undefined, '../other-job']) {
    const result = await start(upstream({ ...completed, id }), { model: current, prompt })
    assert.match(result.id, /^[\da-f-]{36}$/)
    assert.deepEqual(result.media, { base64: 'Aw==', mimeType: 'video/mp4' })
  }
})
