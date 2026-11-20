const videoMarket = 'https://zenmux.ai/api/frontend/model/listByFilter?output_modalities=video';

export function releaseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const time = Date.parse(value);
  if (Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value) return value;
}

export async function fetchMarket(request = fetch) {
  const response = await request(videoMarket, {
    headers: { accept: 'application/json' }, credentials: 'omit', redirect: 'error',
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`ZenMux storefront returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.success !== true || !Array.isArray(payload.data)) throw new Error('Unrecognized ZenMux storefront model list');

  const models = new Map();
  for (const row of payload.data) {
    if (typeof row?.slug !== 'string' || !row.slug) continue;
    const metadata = {};
    const date = releaseDate(row.publish_time);
    if (date) metadata.releaseDate = date;
    // The storefront publishes the fraction of the original price charged (0.65 means 35% off).
    const value = row.pricing_discount;
    const factor = typeof value === 'string' && /^0\.\d+$/.test(value) ? Number(value) : value;
    if (typeof factor === 'number' && factor > 0 && factor < 1) metadata.discountFactor = factor;
    if (date || metadata.discountFactor) models.set(row.slug, metadata);
  }
  return models;
}
