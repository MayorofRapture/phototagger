import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/contracts/ipc';
import type { CatalogIpcClient } from '../../src/main/ipc/register';

const { handle, logger } = vi.hoisted(() => ({
  handle: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('electron', () => ({ ipcMain: { handle } }));
vi.mock('../../src/main/services/logger', () => ({ getLogger: () => logger }));

import { registerIpcHandlers, setMainWindow } from '../../src/main/ipc/register';

const fingerprint = 'a'.repeat(64);
const selectionId = '00000000-0000-4000-8000-000000000001';
const query = {
  tagIds: [],
  flaggedOnly: false,
  order: 'newest-imported' as const,
};
const selection = { selectionId, count: 0, catalogRevisionAtCapture: 0 };
const viewSessionId = '00000000-0000-4000-8000-000000000002';
const photoDetail = {
  photoId: 1,
  canonicalFilename: '0000000001.jpg',
  originalFilename: 'cat.jpg',
  flagged: false,
  integrityState: 'clean' as const,
  width: 1200,
  height: 800,
  contentRevision: 1,
  thumbnailRevision: 1,
  thumbnailUrl: 'pt-photo://thumb/1?thumb=1',
  lifecycleState: 'active' as const,
  fullImageUrl: 'pt-photo://full/1?content=1',
  explicitTags: [],
  desiredMetadataRevision: 0,
  syncedMetadataRevision: 0,
  metadataState: 'synchronized' as const,
  importedAt: '2026-09-18T12:00:00.000Z',
};
const viewSession = { viewSessionId, position: 0, count: 1, detail: photoDetail };

function createCatalogClient(): CatalogIpcClient {
  return {
    readGeneralSettings: vi.fn().mockResolvedValue({
      settings: {
        jpegQuality: 92,
        alphaBackground: '#ffffff',
        defaultOrder: 'newest-imported',
        warningThreshold: 500,
      },
      warnings: [],
    }),
    findTagSuggestions: vi.fn().mockResolvedValue([]),
    queryLibrary: vi.fn().mockResolvedValue({
      queryFingerprint: fingerprint,
      totalCount: 0,
      photos: [],
      nextCursor: null,
    }),
    createLibrarySelection: vi.fn().mockResolvedValue(selection),
    updateLibrarySelection: vi.fn().mockResolvedValue(selection),
    getLibrarySelection: vi.fn().mockResolvedValue(selection),
    clearLibrarySelection: vi.fn().mockResolvedValue({ cleared: true }),
    getPhotoDetail: vi.fn().mockResolvedValue(photoDetail),
    createLibraryViewSession: vi.fn().mockResolvedValue(viewSession),
    navigateLibraryViewSession: vi.fn().mockResolvedValue(viewSession),
  };
}

function registeredHandler(
  channel: string
): (event: unknown, payload: unknown) => Promise<unknown> {
  const registration = handle.mock.calls.find((call) => call[0] === channel);
  expect(registration).toBeDefined();
  return registration?.[1] as (event: unknown, payload: unknown) => Promise<unknown>;
}

describe('M1E1 main IPC registration', () => {
  let client: CatalogIpcClient;
  let event: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createCatalogClient();
    const mainFrame = {};
    const webContents = { mainFrame };
    setMainWindow({ webContents } as never);
    event = { sender: webContents, senderFrame: mainFrame };
    registerIpcHandlers({ collectionRoot: 'D:\\Collection' } as never, '1.0.0-test', client);
  });

  it('registers only the explicit approved channel allowlist', () => {
    expect(handle.mock.calls.map((call) => call[0]).sort()).toEqual(
      [
        IPC_CHANNELS.APP_GET_BOOTSTRAP,
        IPC_CHANNELS.APP_GET_VERSION,
        IPC_CHANNELS.LIBRARY_CLEAR_SELECTION,
        IPC_CHANNELS.LIBRARY_CREATE_SELECTION,
        IPC_CHANNELS.LIBRARY_CREATE_VIEW_SESSION,
        IPC_CHANNELS.LIBRARY_GET_SELECTION,
        IPC_CHANNELS.LIBRARY_QUERY,
        IPC_CHANNELS.LIBRARY_NAVIGATE_VIEW,
        IPC_CHANNELS.LIBRARY_UPDATE_SELECTION,
        IPC_CHANNELS.SETTINGS_GET,
        IPC_CHANNELS.TAGS_SUGGEST,
        IPC_CHANNELS.PHOTO_GET_DETAIL,
      ].sort()
    );
  });

  it('delegates each approved catalog call to its explicit CatalogClient method', async () => {
    await registeredHandler(IPC_CHANNELS.SETTINGS_GET)(event, {});
    await registeredHandler(IPC_CHANNELS.TAGS_SUGGEST)(event, {
      query: 'cat',
      limit: 10,
    });
    await registeredHandler(IPC_CHANNELS.LIBRARY_QUERY)(event, {
      query,
      options: { pageSize: 20 },
    });
    await registeredHandler(IPC_CHANNELS.LIBRARY_CREATE_SELECTION)(event, {
      queryFingerprint: fingerprint,
      seed: { type: 'all' },
    });
    await registeredHandler(IPC_CHANNELS.LIBRARY_UPDATE_SELECTION)(event, {
      selectionId,
      photoIds: [1, 2],
      selected: false,
    });
    await registeredHandler(IPC_CHANNELS.LIBRARY_GET_SELECTION)(event, {
      selectionId,
    });
    await registeredHandler(IPC_CHANNELS.LIBRARY_CLEAR_SELECTION)(event, {
      selectionId,
    });
    await registeredHandler(IPC_CHANNELS.PHOTO_GET_DETAIL)(event, { photoId: 1 });
    await registeredHandler(IPC_CHANNELS.LIBRARY_CREATE_VIEW_SESSION)(event, {
      queryFingerprint: fingerprint,
      selectedPhotoId: 1,
    });
    await registeredHandler(IPC_CHANNELS.LIBRARY_NAVIGATE_VIEW)(event, {
      viewSessionId,
      direction: 'next',
    });

    expect(client.readGeneralSettings).toHaveBeenCalledWith();
    expect(client.findTagSuggestions).toHaveBeenCalledWith('cat', 10);
    expect(client.queryLibrary).toHaveBeenCalledWith(query, { pageSize: 20 });
    expect(client.createLibrarySelection).toHaveBeenCalledWith(fingerprint, {
      type: 'all',
    });
    expect(client.updateLibrarySelection).toHaveBeenCalledWith(selectionId, [1, 2], false);
    expect(client.getLibrarySelection).toHaveBeenCalledWith(selectionId);
    expect(client.clearLibrarySelection).toHaveBeenCalledWith(selectionId);
    expect(client.getPhotoDetail).toHaveBeenCalledWith(1);
    expect(client.createLibraryViewSession).toHaveBeenCalledWith(fingerprint, 1);
    expect(client.navigateLibraryViewSession).toHaveBeenCalledWith(viewSessionId, 'next');
  });

  it('rejects malformed renderer input before delegation', async () => {
    const result = await registeredHandler(IPC_CHANNELS.LIBRARY_QUERY)(event, {
      query: { ...query, tagIds: [0] },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_PAYLOAD',
        category: 'validation',
        dataSafe: true,
      },
    });
    expect(client.queryLibrary).not.toHaveBeenCalled();

    const invalidNavigation = await registeredHandler(
      IPC_CHANNELS.LIBRARY_NAVIGATE_VIEW
    )(event, { viewSessionId, direction: 'sideways' });
    expect(invalidNavigation).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    expect(client.navigateLibraryViewSession).not.toHaveBeenCalled();
  });

  it('rejects a non-window sender before delegation', async () => {
    const result = await registeredHandler(IPC_CHANNELS.SETTINGS_GET)(
      { sender: {}, senderFrame: {} },
      {}
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED_SENDER' },
    });
    expect(client.readGeneralSettings).not.toHaveBeenCalled();
  });

  it('logs internal failures but returns a sanitized renderer error', async () => {
    vi.mocked(client.queryLibrary).mockRejectedValueOnce(
      new Error('SQLITE_ERROR SELECT secret FROM D:\\private\\catalog.sqlite')
    );
    const result = await registeredHandler(IPC_CHANNELS.LIBRARY_QUERY)(event, {
      query,
    });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'CATALOG_REQUEST_FAILED',
        message: 'The catalog could not complete the request',
        dataSafe: true,
      },
    });
    expect(serialized).not.toContain('SQLITE');
    expect(serialized).not.toContain('private');
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
