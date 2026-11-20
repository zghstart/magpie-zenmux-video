import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog, magpieModels } from '../lib/catalog.mjs';

const live = names => () => ({ async json(path) {
  if (path.includes('vertex-ai')) return { models: [] };
  return { data: names.map(id => ({ id, output_modalities: ['video'] })) };
} });
const offline = () => { throw new TypeError('gateway is starting'); };

test('a fresh host can list verified models before its gateway listens, then replace an expired snapshot', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zenmux-video-catalog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const newHost = () => createCatalog(dir, async () => new Map());
  await newHost()('relay', live(['pixverse/c1']), true);
  const cached = join(dir, 'zenmux-video-catalog', 'relay.json');
  const snapshot = JSON.parse(await readFile(cached, 'utf8'));
  await writeFile(cached, JSON.stringify({ ...snapshot, expires: 1 }));
  assert.deepEqual([...(await newHost()('relay', offline)).keys()], ['pixverse/c1']);
  await assert.rejects(newHost()('different-source', offline));
  await assert.rejects(newHost()('relay', offline, true));
  assert.deepEqual([...(await newHost()('relay', live(['pixverse/v6']))).keys()], ['pixverse/v6']);
  assert.deepEqual([...(await newHost()('relay', offline)).keys()], ['pixverse/v6']);
});

test('the picker merges protocol lists by release, labels current offers, and hides expired offers offline', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zenmux-video-picker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const native = [
    { id: 'vendor/undated', publish_time: 'bad-date' },
    { id: 'vendor/lite', display_name: 'Lite' },
    { id: 'vendor/fast', display_name: 'Fast', publish_time: '2026-10-26' },
  ];
  const vertex = [
    { name: 'vendor/lite', publish_time: '2026-10-26' },
    { name: 'google/new', displayName: 'Newest' },
  ];
  const api = () => ({ async json(path) {
    return path.includes('vertex-ai')
      ? { models: vertex.map(row => ({ ...row, outputModalities: ['video'] })) }
      : { data: native.map(row => ({ ...row, output_modalities: ['video'] })) };
  } });
  const market = async () => new Map([
    ['vendor/fast', { discountFactor: 0.5 }], ['vendor/lite', { discountFactor: 0.65 }],
    ['google/new', { releaseDate: '2026-11-06' }], ['unavailable/model', { discountFactor: 0.3 }],
  ]);
  const entries = await createCatalog(dir, market)('relay', api);
  const rows = magpieModels(entries);
  assert.deepEqual(Object.keys(rows), ['google/new', 'vendor/fast', 'vendor/lite', 'vendor/undated']);
  assert.equal(rows['vendor/lite'].name, 'Lite · 商城 6.5 折 · 2026-10-26');
  assert.equal(rows['vendor/fast'].name, 'Fast · 商城 5 折 · 2026-10-26');
  assert.equal(rows['google/new'].name, 'Newest · 2026-11-06');
  assert.equal(rows['vendor/undated'].name, 'vendor/undated');
  assert.equal(entries.get('vendor/lite').protocol, 'native');
  const later = Date.now() + 3600_000;
  t.mock.method(Date, 'now', () => later);
  const cached = await createCatalog(dir, offline)('relay', offline);
  assert.equal(magpieModels(cached)['vendor/lite'].name, 'Lite · 2026-10-26');
  const noOffers = await createCatalog(dir, async () => { throw new Error('store unavailable'); })('relay', api, true);
  assert.equal(magpieModels(noOffers)['vendor/fast'].name, 'Fast · 2026-10-26');
});
