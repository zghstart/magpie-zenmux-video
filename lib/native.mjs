import { inlineImage, problem, videoSize } from './common.mjs';

const jobsPath = '/api/v1/videos';

function jobId(value, status) {
  if (typeof value !== 'string' || value.length > 512 || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(value)) {
    throw problem(status, 'Invalid ZenMux video job ID');
  }
  return value;
}

function imageItem(role, url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) inlineImage(url);
  return { type: 'image_url', role, image_url: { url } };
}

function put(options, field, value) {
  if (value === undefined) return;
  if (Object.hasOwn(options, field) && options[field] !== value) {
    throw problem(400, `Conflicting values for native video ${field}`);
  }
  options[field] = value;
}

function request(body) {
  const { model, prompt, seconds, size, input_reference, last_frame, reference_images, content = [], ...options } = body;
  if (!Array.isArray(content)) throw problem(400, 'Native video content must be an array');
  const items = [];
  if (prompt != null) {
    if (typeof prompt !== 'string') throw problem(400, 'Video prompt must be a string');
    if (prompt.length) items.push({ type: 'text', text: prompt });
  }
  if (input_reference != null) items.push(imageItem('first_frame', input_reference));
  if (last_frame != null) items.push(imageItem('last_frame', last_frame));
  if (reference_images != null) {
    if (!Array.isArray(reference_images)) throw problem(400, 'reference_images must be an array of images');
    for (const image of reference_images) items.push(imageItem('reference_image', image));
  }
  // The native endpoint also accepts typed video/audio content and provider-specific options.
  for (const item of content) items.push(item);
  if (!items.length) throw problem(400, 'Native video generation requires a prompt or media content');
  const dimensions = size === 'adaptive' ? { ratio: 'adaptive' } : videoSize(size);
  put(options, 'ratio', dimensions.ratio);
  put(options, 'resolution', dimensions.resolution);
  if (seconds != null) {
    const duration = typeof seconds === 'string' ? Number(seconds) : seconds;
    if (!Number.isSafeInteger(duration) || duration <= 0) throw problem(400, 'seconds must be a positive integer');
    put(options, 'duration', duration);
  }
  return { model, content: items, ...options };
}

function result(job, includeMedia) {
  switch (job?.status) {
    case 'queued': return { status: 'queued' };
    case 'running': return { status: 'in_progress' };
    case 'failed': {
      const { code, message } = job.error ?? {};
      const error = { message: typeof message === 'string' && message ? message : 'ZenMux video generation failed' };
      if (code != null) error.code = String(code);
      return { status: 'failed', error };
    }
    case 'succeeded': {
      const url = job.content?.video_url;
      if (typeof url !== 'string' || !url) {
        return { status: 'failed', error: { code: 'missing_media', message: 'ZenMux completed without content.video_url' } };
      }
      return includeMedia ? { status: 'completed', media: { url } } : { status: 'completed' };
    }
    default: throw problem(502, `Unknown ZenMux video status: ${job?.status ?? 'missing'}`);
  }
}

export async function start(api, body) {
  const job = await api.json(jobsPath, { method: 'POST', body: request(body) });
  return { id: jobId(job?.id, 502), ...result(job, false) };
}

export async function poll(api, model, id, includeMedia = false) {
  const job = await api.json(`${jobsPath}/${jobId(id, 400)}`);
  if ((job?.model && job.model !== model) || (job?.id && job.id !== id)) {
    throw problem(404, 'The upstream video job does not match this model or task ID');
  }
  return result(job, includeMedia);
}
