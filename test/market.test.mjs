import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchMarket, releaseDate } from '../lib/market.mjs';

test('reads native and Vertex storefront listings in a single anonymous request', async () => {
  let calls = 0;
  const models = await fetchMarket(async (url, options) => {
    calls++;
    assert.equal(url, 'https://zenmux.ai/api/frontend/model/listByFilter?output_modalities=video');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    return Response.json({ success: true, data: [
      { slug: 'minimax/minimax-h3-lite', publish_time: '2026-10-26', pricing_discount: '0.65' },
      { slug: 'minimax/minimax-h3-highspeed', publish_time: '2026-10-26', pricing_discount: '0.5' },
      { slug: 'google/gemini-omni-1.2-flash', publish_time: '2026-11-06', pricing_discount: '1' },
    ] });
  });
  assert.equal(calls, 1);
  assert.deepEqual(models.get('minimax/minimax-h3-lite'), { releaseDate: '2026-10-26', discountFactor: 0.65 });
  assert.deepEqual(models.get('minimax/minimax-h3-highspeed'), { releaseDate: '2026-10-26', discountFactor: 0.5 });
  assert.deepEqual(models.get('google/gemini-omni-1.2-flash'), { releaseDate: '2026-11-06' });
});

test('publishes only explicit valid discounts, independent of price tiers and publish date', async () => {
  const badFactors = [undefined, null, false, '', '35% OFF', '0.5abc', '0', 1.2, -0.2];
  const data = badFactors.map((factor, i) => ({
    slug: `fixture/model-${i}`, publish_time: '2026-08-07', pricing_discount: factor,
    pricing_prompt: '1', pricing_completion: '2',
    pricings: { video: [{ value: 4.2, unit: 'perMTokens' }, { value: 7, unit: 'perMTokens' }] },
  }));
  const models = await fetchMarket(async () => Response.json({ success: true, data: [
    ...data, null, { slug: 'fixture/discount-only', publish_time: '2026-02-29', pricing_discount: 0.8 },
  ] }));
  for (const { slug } of data) assert.deepEqual(models.get(slug), { releaseDate: '2026-08-07' });
  assert.deepEqual(models.get('fixture/discount-only'), { discountFactor: 0.8 });
});

test('release dates accept actual calendar dates in the ZenMux date format', () => {
  assert.equal(releaseDate('2024-02-29'), '2024-02-29');
  for (const value of [undefined, 1792983814, '2026-02-29', '2026-13-01', '2026-1-1', '2026-10-26T00:00:00Z']) {
    assert.equal(releaseDate(value), undefined);
  }
});

test('reports storefront failures separately from an empty list', async () => {
  assert.equal((await fetchMarket(async () => Response.json({ success: true, data: [] }))).size, 0);
  await assert.rejects(fetchMarket(async () => new Response(null, { status: 503 })), /503/);
  await assert.rejects(fetchMarket(async () => Response.json({ success: false, data: [] })), /Unrecognized/);
  await assert.rejects(fetchMarket(async () => Response.json({ success: true, data: {} })), /Unrecognized/);
});
