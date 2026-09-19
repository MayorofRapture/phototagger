import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type PhotoTaggerApi } from '../../src/shared/contracts/ipc';

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue({ ok: true, data: null }),
}));

vi.mock('electron', () => ({ ipcRenderer: { invoke } }));

import { photoTaggerApi } from '../../src/preload/api';

const fingerprint = 'a'.repeat(64);
const selectionId = '00000000-0000-4000-8000-000000000001';
const viewSessionId = '00000000-0000-4000-8000-000000000002';
const query = {
  tagIds: [],
  flaggedOnly: false,
  order: 'newest-imported' as const,
};

describe('M1E1 preload API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('matches the typed narrow runtime surface without exposing Electron primitives', () => {
    const typedApi: PhotoTaggerApi = photoTaggerApi;
    expect(Object.keys(typedApi).sort()).toEqual(['app', 'library', 'photo', 'settings', 'tags']);
    expect(Object.keys(typedApi.settings)).toEqual(['get']);
    expect(Object.keys(typedApi.tags)).toEqual(['suggest']);
    expect(Object.keys(typedApi.library).sort()).toEqual([
      'clearSelection',
      'createSelection',
      'createViewSession',
      'getSelection',
      'navigateView',
      'query',
      'updateSelection',
    ]);
    expect(Object.keys(typedApi.photo)).toEqual(['getDetail']);
    expect('ipcRenderer' in (typedApi as unknown as Record<string, unknown>)).toBe(false);
    expect('invoke' in (typedApi as unknown as Record<string, unknown>)).toBe(false);
    expect(Object.isFrozen(typedApi)).toBe(true);
    expect(Object.isFrozen(typedApi.library)).toBe(true);
  });

  it('invokes only the exact approved channels and payloads', async () => {
    await photoTaggerApi.settings.get();
    await photoTaggerApi.tags.suggest('cat', 10);
    await photoTaggerApi.library.query(query, { pageSize: 20 });
    await photoTaggerApi.library.createSelection(fingerprint, {
      type: 'one',
      photoId: 1,
    });
    await photoTaggerApi.library.updateSelection(selectionId, [1, 2], true);
    await photoTaggerApi.library.getSelection(selectionId);
    await photoTaggerApi.library.clearSelection(selectionId);
    await photoTaggerApi.photo.getDetail(1);
    await photoTaggerApi.library.createViewSession(fingerprint, 1);
    await photoTaggerApi.library.navigateView(viewSessionId, 'next');

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.SETTINGS_GET, {}],
      [IPC_CHANNELS.TAGS_SUGGEST, { query: 'cat', limit: 10 }],
      [IPC_CHANNELS.LIBRARY_QUERY, { query, options: { pageSize: 20 } }],
      [
        IPC_CHANNELS.LIBRARY_CREATE_SELECTION,
        {
          queryFingerprint: fingerprint,
          seed: { type: 'one', photoId: 1 },
        },
      ],
      [
        IPC_CHANNELS.LIBRARY_UPDATE_SELECTION,
        {
          selectionId,
          photoIds: [1, 2],
          selected: true,
        },
      ],
      [IPC_CHANNELS.LIBRARY_GET_SELECTION, { selectionId }],
      [IPC_CHANNELS.LIBRARY_CLEAR_SELECTION, { selectionId }],
      [IPC_CHANNELS.PHOTO_GET_DETAIL, { photoId: 1 }],
      [IPC_CHANNELS.LIBRARY_CREATE_VIEW_SESSION, { queryFingerprint: fingerprint, selectedPhotoId: 1 }],
      [IPC_CHANNELS.LIBRARY_NAVIGATE_VIEW, { viewSessionId, direction: 'next' }],
    ]);
  });

  it('rejects malformed renderer values inside preload without invoking IPC', async () => {
    const invalidLimit = await photoTaggerApi.tags.suggest('cat', 51);
    const invalidId = await photoTaggerApi.library.updateSelection(selectionId, [0], true);
    const invalidPhotoId = await photoTaggerApi.photo.getDetail(0);
    const invalidDirection = await photoTaggerApi.library.navigateView(
      viewSessionId,
      'sideways' as never
    );

    expect(invalidLimit).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PAYLOAD' },
    });
    expect(invalidId).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PAYLOAD' },
    });
    expect(invalidPhotoId).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    expect(invalidDirection).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    expect(invoke).not.toHaveBeenCalled();
  });
});
