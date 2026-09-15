import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { CollectionPaths } from '../../src/main/bootstrap/collection';
import {
  CatalogLifecycle,
  resolveCatalogPath,
  type CatalogLifecycleClient,
} from '../../src/main/catalog/catalog-lifecycle';

function collectionPaths(data: string): CollectionPaths {
  return { data } as CollectionPaths;
}

function createClient(overrides: Partial<CatalogLifecycleClient> = {}): CatalogLifecycleClient {
  return {
    start: vi.fn(),
    ping: vi.fn().mockResolvedValue({ pong: true, timestamp: '2026-09-14T12:00:00.000Z' }),
    openCatalog: vi.fn().mockResolvedValue({
      opened: true,
      created: true,
      userVersion: 1,
      temporaryTableNames: ['selection_members', 'selection_sessions', 'view_members', 'view_sessions'],
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

describe('production catalog lifecycle', () => {
  it('derives Collection/Data/catalog.sqlite and opens it after starting the process', async () => {
    const dataPath = path.join('D:\\isolated', 'Collection', 'Data');
    const paths = collectionPaths(dataPath);
    const client = createClient();
    const lifecycle = new CatalogLifecycle(client, createLogger());

    await lifecycle.start(paths);

    expect(resolveCatalogPath(paths)).toBe(path.join(dataPath, 'catalog.sqlite'));
    expect(client.start).toHaveBeenCalledOnce();
    expect(client.ping).toHaveBeenCalledOnce();
    expect(client.openCatalog).toHaveBeenCalledWith(path.join(dataPath, 'catalog.sqlite'));
    expect(vi.mocked(client.start).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(client.openCatalog).mock.invocationCallOrder[0]);
  });

  it('cleans up the catalog process when startup fails', async () => {
    const client = createClient({
      openCatalog: vi.fn().mockRejectedValue(new Error('catalog open failed')),
    });
    const logger = createLogger();
    const lifecycle = new CatalogLifecycle(client, logger);

    await expect(lifecycle.start(collectionPaths('D:\\isolated\\Collection\\Data')))
      .rejects.toThrow('catalog open failed');
    expect(client.stop).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), 'Catalog startup failed');
  });

  it('makes shutdown idempotent and safe after partially completed startup', async () => {
    const client = createClient({
      start: vi.fn(() => {
        throw new Error('process start failed');
      }),
    });
    const lifecycle = new CatalogLifecycle(client, createLogger());

    await expect(lifecycle.start(collectionPaths('D:\\isolated\\Collection\\Data')))
      .rejects.toThrow('process start failed');
    const firstStop = lifecycle.stop();
    const secondStop = lifecycle.stop();
    expect(firstStop).toBe(secondStop);
    await firstStop;
    expect(client.stop).toHaveBeenCalledOnce();
  });
});
