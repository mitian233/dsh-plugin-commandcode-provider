import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  cacheIsFresh,
  commandCodeModelsFromCache,
  loadCommandCodeCatalog,
  MODEL_CATALOG_CACHE_VERSION,
  writeCommandCodeCatalogCache,
} from '../src/catalog.ts'

const cachedModels = [{ id: 'cached', name: 'Cached', contextWindow: 100_000, maxTokens: 64_000 }]
const staticModels = [{ id: 'static' }]
const apiResponse = { object: 'list', data: [{ id: 'live', name: 'Live', context_length: 200_000 }] }

function response(): Response {
  return new Response(JSON.stringify(apiResponse), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('uses a fresh disk cache without fetching', async () => {
  let fetches = 0
  const loaded = await loadCommandCodeCatalog({
    cachePath: '/cache/models.json', staticModels, ttlMs: 100, now: 1_000,
    readCache: async () => ({ version: MODEL_CATALOG_CACHE_VERSION, models: cachedModels, fetchedAt: 950 }),
    fetchImpl: async () => { fetches += 1; return response() },
  })

  assert.deepEqual(loaded.initial, { models: cachedModels, source: 'cache', fetchedAt: 950 })
  assert.equal(loaded.refresh, undefined)
  assert.equal(fetches, 0)
})

test('does not consider a future-dated cache fresh', () => {
  assert.equal(cacheIsFresh(1_001, 100, 1_000), false)
})

test('writes concurrent cache refreshes atomically with unique temporary files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'commandcode-catalog-'))
  const cachePath = join(directory, 'models.json')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const writes = Array.from({ length: 16 }, (_, index) => writeCommandCodeCatalogCache(
    cachePath,
    [{ id: `live-${index}`, contextWindow: 100_000 }],
    1_000 + index,
  ))

  await Promise.all(writes)

  const cache = commandCodeModelsFromCache(JSON.parse(await readFile(cachePath, 'utf8')) as unknown)
  assert.match(cache.models[0]?.id ?? '', /^live-\d+$/)
  assert.deepEqual(await readdir(directory), ['models.json'])
})

test('keeps a stale cache available while refreshing it in the background', async () => {
  let writes = 0
  const loaded = await loadCommandCodeCatalog({
    cachePath: '/cache/models.json', staticModels, ttlMs: 100, now: 1_000,
    readCache: async () => ({ version: MODEL_CATALOG_CACHE_VERSION, models: cachedModels, fetchedAt: 899 }),
    fetchImpl: async () => response(),
    writeCache: async (_path, models, fetchedAt) => {
      writes += 1
      assert.equal(fetchedAt, 1_000)
      assert.deepEqual(models.map(model => model.id), ['live'])
    },
  })

  assert.equal(loaded.initial.source, 'cache')
  assert.deepEqual((await loaded.refresh)?.models.map(model => model.id), ['live'])
  assert.equal((await loaded.refresh)?.source, 'live')
  assert.equal(writes, 1)
})

test('uses static models while no cache is available and promotes a live refresh', async () => {
  const loaded = await loadCommandCodeCatalog({
    cachePath: '/cache/models.json', staticModels, now: 1_000,
    readCache: async () => { throw new Error('ENOENT') },
    fetchImpl: async () => response(),
    writeCache: async () => undefined,
  })

  assert.equal(loaded.initial.source, 'static')
  assert.deepEqual(loaded.initial.models, staticModels)
  assert.deepEqual(await loaded.refresh, {
    models: [{ id: 'live', name: 'Live', contextWindow: 200_000, maxTokens: 64_000 }], source: 'live', fetchedAt: 1_000,
  })
})

test('falls back to static models when a corrupt cache cannot be refreshed', async () => {
  const loaded = await loadCommandCodeCatalog({
    cachePath: '/cache/models.json', staticModels,
    readCache: async () => { throw new Error('Expected Command Code model cache version 1') },
    fetchImpl: async () => { throw new Error('offline') },
  })

  assert.equal(loaded.initial.source, 'static')
  const refreshed = await loaded.refresh
  assert.equal(refreshed?.source, 'static')
  assert.match(refreshed?.warning ?? '', /offline/)
})

test('keeps live models when writing their cache fails', async () => {
  const loaded = await loadCommandCodeCatalog({
    cachePath: '/cache/models.json', staticModels,
    readCache: async () => { throw new Error('ENOENT') },
    fetchImpl: async () => response(),
    writeCache: async () => { throw new Error('read-only') },
  })

  const refreshed = await loaded.refresh
  assert.equal(refreshed?.source, 'live')
  assert.deepEqual(refreshed?.models.map(model => model.id), ['live'])
  assert.match(refreshed?.warning ?? '', /read-only/)
})

test('rejects corrupt and incompatible cache files before falling back', () => {
  assert.throws(() => commandCodeModelsFromCache({ version: 2, models: cachedModels, fetchedAt: 1 }), /version 1/)
  assert.throws(() => commandCodeModelsFromCache({ version: 1, models: [{ id: '' }], fetchedAt: 1 }), /non-empty id/)
})
