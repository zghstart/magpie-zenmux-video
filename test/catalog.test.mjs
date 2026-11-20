import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog } from '../lib/catalog.mjs';

const live = names => () => ({ async json(path) {
  if (path.includes('vertex-ai')) return { models: [] };
  return { data: names.map(id => ({ id, output_modalities: ['video'] })) };
} });
const offline = () => { throw new TypeError('gateway is starting'); };

test('a fresh host can list verified models before its gateway listens, then replace an expired snapshot', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zenmux-video-catalog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await createCatalog(dir)('relay', live(['pixverse/c1']), true);
  const cached = join(dir, 'zenmux-video-catalog', 'relay.json');
  const snapshot = JSON.parse(await readFile(cached, 'utf8'));
  await writeFile(cached, JSON.stringify({ ...snapshot, expires: 1 }));
  assert.deepEqual([...(await createCatalog(dir)('relay', offline)).keys()], ['pixverse/c1']);
  await assert.rejects(createCatalog(dir)('different-source', offline));
  await assert.rejects(createCatalog(dir)('relay', offline, true));
  assert.deepEqual([...(await createCatalog(dir)('relay', live(['pixverse/v6']))).keys()], ['pixverse/v6']);
  assert.deepEqual([...(await createCatalog(dir)('relay', offline)).keys()], ['pixverse/v6']);
});
