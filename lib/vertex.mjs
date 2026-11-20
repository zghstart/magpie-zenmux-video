import { inlineImage, problem, videoSize } from './common.mjs'

const parameterNames = new Map([
  ['aspect_ratio', 'aspectRatio'], ['duration_seconds', 'durationSeconds'],
  ['generate_audio', 'generateAudio'], ['negative_prompt', 'negativePrompt'],
  ['enhance_prompt', 'enhancePrompt'], ['person_generation', 'personGeneration'],
  ['sample_count', 'sampleCount'], ['numberOfVideos', 'sampleCount'],
  ['number_of_videos', 'sampleCount'], ['seed', 'seed'], ['fps', 'fps'],
  ['resolution', 'resolution'], ['resize_mode', 'resizeMode'],
  ['compression_quality', 'compressionQuality'],
])
for (const field of [...parameterNames.values()]) parameterNames.set(field, field)

function modelPath(model) {
  if (typeof model !== 'string' || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(model)) {
    throw problem(400, 'Invalid Vertex publisher/model identifier')
  }
  const [publisher, name] = model.split('/')
  return `publishers/${publisher}/models/${name}`
}

function operationName(name, resource, status) {
  // ZenMux returns a publisher-relative name. Vertex also defines a fully qualified resource.
  const match = typeof name === 'string' && name.length <= 2048 &&
    /^(?:projects\/[\w.-]+\/locations\/[\w-]+\/)?(publishers\/[\w.-]+\/models\/[\w.-]+)\/operations\/[\w-][\w.-]*$/.exec(name)
  if (!match || match[1] !== resource) throw problem(status, 'Invalid Vertex operation name for this model')
  return name
}

function image(dataUrl) {
  const { mimeType, data } = inlineImage(dataUrl)
  return { mimeType, bytesBase64Encoded: data }
}

function put(target, key, value) {
  if (value === undefined) return
  if (Object.hasOwn(target, key) && target[key] !== value) throw problem(400, `Conflicting values for Vertex ${key}`)
  target[key] = value
}

function request(body) {
  const { model, prompt, size, seconds, input_reference, last_frame, reference_images, parameters = {}, ...options } = body
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw problem(400, 'Vertex parameters must be an object')
  const config = { ...parameters }
  const instance = {}
  put(instance, 'prompt', prompt)
  if (input_reference != null) instance.image = image(input_reference)
  if (last_frame != null) instance.lastFrame = image(last_frame)
  if (reference_images !== undefined) {
    if (!Array.isArray(reference_images)) throw problem(400, 'reference_images must be an array of image data URLs')
    if (reference_images.length) instance.referenceImages = reference_images.map(src => ({ image: image(src), referenceType: 'asset' }))
  }
  if (size != null) {
    const { ratio, resolution } = videoSize(size)
    if (!ratio && !resolution) throw problem(400, 'Unsupported Vertex video size')
    put(config, 'aspectRatio', ratio)
    put(config, 'resolution', resolution)
  }
  if (seconds != null) {
    const duration = typeof seconds === 'string' ? Number(seconds) : seconds
    if (!Number.isSafeInteger(duration) || duration <= 0) throw problem(400, 'seconds must be a positive integer')
    put(config, 'durationSeconds', duration)
  }
  for (const [key, value] of Object.entries(options)) {
    if (parameterNames.has(key)) put(config, parameterNames.get(key), value)
    else if (['image', 'lastFrame', 'video', 'referenceImages', 'mask'].includes(key)) put(instance, key, value)
    else throw problem(400, `Unsupported Vertex video option: ${key}. Pass vendor generation parameters in parameters.`)
  }
  if (instance.lastFrame && !instance.image) throw problem(400, 'A Vertex last frame requires a first frame')
  if (config.sampleCount !== undefined && config.sampleCount !== 1) throw problem(400, 'Magpie returns one video per job. Set sampleCount to 1.')
  return { instances: [instance], parameters: config }
}

function failed(message, code) {
  return { status: 'failed', error: code == null ? { message } : { message, code: String(code) } }
}

function result(op, pendingStatus, includeMedia) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) throw problem(502, 'Invalid Vertex operation response')
  if (op.error) return failed(op.error.message || 'Vertex video generation failed', op.error.status ?? op.error.code)
  if (op.done === undefined || op.done === false) return { status: pendingStatus }
  if (op.done !== true) throw problem(502, 'Invalid Vertex operation completion flag')
  const response = op.response
  const video = response?.videos?.[0]
  if (!video && (response?.raiMediaFilteredCount > 0 || response?.raiMediaFilteredReasons?.length)) {
    const reasons = Array.isArray(response.raiMediaFilteredReasons) ? response.raiMediaFilteredReasons.join(', ') : ''
    return failed(reasons || 'Vertex filtered the generated video', 'content_filtered')
  }
  let media
  if (typeof video?.bytesBase64Encoded === 'string' && video.bytesBase64Encoded.length) {
    media = { base64: video.bytesBase64Encoded, mimeType: video.mimeType || 'video/mp4' }
  } else if (typeof video?.gcsUri === 'string' && /^https:\/\//i.test(video.gcsUri)) {
    media = { url: video.gcsUri }
  } else if (typeof video?.gcsUri === 'string' && video.gcsUri.startsWith('gs://')) {
    return failed('Vertex returned a Google Cloud Storage URI. Magpie requires inline video bytes or an HTTPS download URL.', 'unsupported_media_uri')
  } else {
    return failed('Vertex completed without a downloadable video', 'missing_media')
  }
  return includeMedia ? { status: 'completed', media } : { status: 'completed' }
}

export async function start(api, body) {
  const resource = modelPath(body.model)
  const op = await api.json(`/api/vertex-ai/v1/${resource}:predictLongRunning`, { method: 'POST', body: request(body) })
  return { id: operationName(op?.name, resource, 502), ...result(op, 'queued', false) }
}

export async function poll(api, model, id, includeMedia = false) {
  const resource = modelPath(model)
  const name = operationName(id, resource, 400)
  const op = await api.json(`/api/vertex-ai/v1/${resource}:fetchPredictOperation`, { method: 'POST', body: { operationName: name } })
  if (op?.name !== undefined && op.name !== name) throw problem(502, 'Vertex returned a different operation')
  return result(op, 'in_progress', includeMedia)
}
