import { randomUUID } from 'node:crypto'
import { inlineImage, problem, videoSize } from './common.mjs'

const preview = 'google/gemini-omni-1.1-flash-preview'
const current = 'google/gemini-omni-1.2-flash'

function videoFormat(body) {
  const { ratio, resolution } = videoSize(body.size)
  const format = { type: 'video', delivery: 'inline' }
  const aspect = body.aspect_ratio ?? ratio
  if (aspect != null) {
    if (!['16:9', '9:16'].includes(aspect)) throw problem(400, 'Omni supports aspect ratios 16:9 and 9:16')
    format.aspect_ratio = aspect
  }
  const pixels = body.resolution ?? resolution
  if (pixels != null) {
    const value = pixels === '2160p' ? '4k' : String(pixels).toLowerCase()
    if (!['360p', '720p', '1080p', '4k'].includes(value)) throw problem(400, 'Omni supports 360p, 720p, 1080p and 4k')
    format.resolution = value
  }
  if (body.seconds != null) {
    const max = body.model === preview || (body.input_reference && body.last_frame) ? 10 : 15
    const seconds = Number(body.seconds)
    if (!['string', 'number'].includes(typeof body.seconds) || !Number.isInteger(seconds) || seconds < 3 || seconds > max) {
      throw problem(400, `Omni duration must be a whole number from 3 to ${max} seconds for this request`)
    }
    format.duration = `${seconds}s`
  }
  return format
}

function image(value) {
  const { mimeType, data } = inlineImage(value)
  return { type: 'image', mime_type: mimeType, data }
}

function inputParts(body) {
  const references = body.reference_images ?? []
  if (!Array.isArray(references)) throw problem(400, 'reference_images must be a list of images')
  if (body.model === current && references.length > 6) throw problem(400, 'Omni 1.2 supports up to six reference images')
  const input = []
  const hasFrames = body.input_reference != null || body.last_frame != null
  // A named task assigns roles by image order. For mixed roles, Omni uses natural-language instructions.
  const labelImages = (hasFrames && references.length > 0) || (body.last_frame != null && body.input_reference == null)
  if (body.input_reference != null) {
    if (labelImages) input.push({ type: 'text', text: 'Use the following image as the first frame.' })
    input.push(image(body.input_reference))
  }
  if (body.last_frame != null) {
    if (labelImages) input.push({ type: 'text', text: 'Use the following image as the last frame.' })
    input.push(image(body.last_frame))
  }
  if (references.length) {
    if (labelImages) input.push({ type: 'text', text: 'Use the following images as subject or scene references.' })
    for (const reference of references) input.push(image(reference))
  }
  input.push({ type: 'text', text: body.prompt })
  let task
  if (!labelImages) {
    if (hasFrames) task = 'image_to_video'
    else if (references.length) task = 'reference_to_video'
    else task = 'text_to_video'
  }
  return { input, task }
}

function completedMedia(response) {
  if (response?.status !== 'completed') {
    const detail = response?.error?.message || `Omni returned interaction status ${response?.status ?? 'unknown'} for a synchronous request`
    throw problem(502, detail)
  }
  let explanation
  for (const step of Array.isArray(response.steps) ? response.steps : []) {
    if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue
    for (const part of step.content) {
      if (part?.type === 'text' && typeof part.text === 'string') explanation = part.text
      if (part?.type !== 'video') continue
      if (typeof part.data === 'string' && part.data.length > 0) {
        const remainder = part.data.length % 4
        if (remainder === 1 || (remainder && part.data.endsWith('=')) || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data)) {
          throw problem(502, 'Omni returned invalid base64 video data')
        }
        const mimeType = part.mime_type ?? 'video/mp4'
        if (typeof mimeType !== 'string' || !/^video\/[\w.+-]+$/i.test(mimeType)) throw problem(502, 'Omni returned an invalid video MIME type')
        return { base64: part.data, mimeType }
      }
      if (part.uri) {
        // Vertex URI delivery points at a customer-owned GCS bucket. ZenMux has no documented Files proxy.
        throw problem(502, 'Omni returned a file URI despite the inline video delivery request')
      }
    }
  }
  throw problem(502, `Omni completed without a generated video${explanation ? `: ${explanation}` : ''}`)
}

export async function start(api, body) {
  if (![preview, current].includes(body.model)) throw problem(400, 'Unknown ZenMux Omni video model')
  if (body.negative_prompt != null) throw problem(400, 'Omni takes negative instructions in the prompt and does not support negative_prompt')
  const { input, task } = inputParts(body)
  const generationConfig = { ...body.generation_config }
  if (body.seed != null) generationConfig.seed = body.seed
  if (task) generationConfig.video_config = { task, ...generationConfig.video_config }
  const request = {
    model: body.model,
    input,
    response_format: [videoFormat(body)],
    // ZenMux exposes create; Magpie serves subsequent polling and content from the stored local job.
    store: false,
    stream: false,
    background: false,
  }
  if (Object.keys(generationConfig).length) request.generation_config = generationConfig
  for (const key of ['labels', 'provider', 'model_routing_config']) {
    if (body[key] != null) request[key] = body[key]
  }
  const response = await api.json('/api/v1/interactions', { method: 'POST', body: request })
  const media = completedMedia(response)
  const id = typeof response.id === 'string' && /^[\w-]{1,2048}$/.test(response.id) ? response.id : randomUUID()
  return { id, status: 'completed', media }
}
