export function problem(status, message) {
  return Object.assign(new Error(message), { status });
}

const ratios = [[1, 1], [16, 9], [9, 16], [4, 3], [3, 4], [3, 2], [2, 3], [21, 9], [9, 21]];

export function videoSize(size) {
  if (size == null || size === '') return {};
  if (typeof size !== 'string') throw problem(400, 'size must be an aspect ratio or WIDTHxHEIGHT');
  if (/^(360|480|720|768|1080|2160)p$/.test(size)) return { resolution: size };
  if (/^[1-9]\d?:[1-9]\d?$/.test(size)) return { ratio: size };
  const match = /^(\d{1,5})[x×](\d{1,5})$/i.exec(size);
  if (!match) throw problem(400, 'size must be an aspect ratio or WIDTHxHEIGHT');
  const width = Number(match[1]), height = Number(match[2]);
  if (!width || !height) throw problem(400, 'Video dimensions must be positive');
  // Video frames rounded to a codec block boundary still represent the same aspect ratio.
  const ratio = ratios.find(([w, h]) => Math.abs(width / height / (w / h) - 1) < 0.02);
  if (!ratio) throw problem(400, `Unsupported video aspect ratio for ${size}`);
  const short = Math.min(width, height);
  const resolution = [360, 480, 720, 768, 1080, 2160].find((tier) => tier >= short);
  if (!resolution) throw problem(400, `Unsupported video resolution for ${size}`);
  return { ratio: ratio.join(':'), resolution: `${resolution}p` };
}

export function inlineImage(value) {
  if (typeof value !== 'string') throw problem(400, 'Expected a base64 image data URL');
  const header = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(value);
  if (!header) throw problem(400, 'This video model requires an inline image data URL');
  const data = value.slice(header[0].length);
  if (!data || data.length % 4 === 1 || (data.includes('=') && data.length % 4 !== 0) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw problem(400, 'Invalid base64 image');
  }
  return { mimeType: header[1].toLowerCase(), data };
}
