import { describe, expect, it, vi } from 'vitest';
import type {
  LibraryPageResultDto,
  LibraryQueryDto,
  PhotoSummaryDto,
  SelectionRefDto,
  TagSuggestionDto,
} from '../../src/shared/contracts/catalog-api';
import { createSuccessResult, type IpcResult } from '../../src/shared/errors/app-error';
import type { LibraryRendererApi } from '../../src/renderer/app/library/library-api';
import {
  LibraryController,
  knownSoleSelectedPhotoId,
} from '../../src/renderer/app/library/library-controller';

const FINGERPRINT = 'a'.repeat(64);
const SELECTION_ID = 'a0f0a4ed-5ca8-4012-bae0-f8a73f80d2a1';

function photo(photoId: number): PhotoSummaryDto {
  return {
    photoId,
    canonicalFilename: `${photoId}.jpg`,
    originalFilename: `${photoId}.jpg`,
    flagged: false,
    integrityState: 'clean',
    width: 100,
    height: 100,
    contentRevision: 1,
    thumbnailRevision: 1,
    thumbnailUrl: `pt-photo://thumb/${photoId}?thumb=1`,
  };
}

function page(overrides: Partial<LibraryPageResultDto> = {}): LibraryPageResultDto {
  return {
    queryFingerprint: FINGERPRINT,
    totalCount: 2,
    photos: [photo(1), photo(2)],
    nextCursor: null,
    ...overrides,
  };
}

function selection(count: number): SelectionRefDto {
  return {
    selectionId: SELECTION_ID,
    count,
    catalogRevisionAtCapture: 7,
  };
}

function tag(tagId: number, fullPath: string): TagSuggestionDto {
  return {
    tagId,
    parentTagId: null,
    displayName: fullPath,
    fullPath,
    depth: 1,
    childCount: 0,
    pinned: false,
    legacyFlatOnly: false,
  };
}

function makeApi(overrides: Partial<LibraryRendererApi> = {}): LibraryRendererApi {
  return {
    readGeneralSettings: vi.fn(async () => createSuccessResult({
      settings: {
        jpegQuality: 92,
        alphaBackground: '#ffffff',
        defaultOrder: 'oldest-imported' as const,
        warningThreshold: 500,
      },
      warnings: [],
    })),
    findTagSuggestions: vi.fn(async () => createSuccessResult([])),
    queryLibrary: vi.fn(async () => createSuccessResult(page())),
    createSelection: vi.fn(async () => createSuccessResult(selection(1))),
    updateSelection: vi.fn(async () => createSuccessResult(selection(1))),
    clearSelection: vi.fn(async () => createSuccessResult({ cleared: true as const })),
    ...overrides,
  };
}

describe('LibraryController', () => {
  it('awaits the persisted default order before loading the first 200-result page', async () => {
    const api = makeApi();
    const controller = new LibraryController(api);

    await controller.initialize();

    expect(api.queryLibrary).toHaveBeenCalledWith(
      { tagIds: [], flaggedOnly: false, order: 'oldest-imported' },
      { pageSize: 200 },
    );
    expect(controller.getSnapshot().totalCount).toBe(2);
  });

  it('keeps selected tag full paths, avoids duplicate tag filters, and resets selection before a filter query', async () => {
    const api = makeApi();
    const controller = new LibraryController(api);
    await controller.initialize();
    await controller.togglePhoto(1);

    const activeTag = tag(8, 'People / Family');
    await controller.addTagFilter(activeTag);
    await controller.addTagFilter(activeTag);

    expect(api.clearSelection).toHaveBeenCalledWith(SELECTION_ID);
    expect(controller.getSnapshot().query?.tagIds).toEqual([8]);
    expect(controller.getSnapshot().activeTagFilters).toEqual([activeTag]);
    expect(api.queryLibrary).toHaveBeenCalledTimes(2);
  });

  it('removes tag filters and sends fresh queries for flagged-only and each selected sort state', async () => {
    const api = makeApi();
    const controller = new LibraryController(api);
    await controller.initialize();
    await controller.addTagFilter(tag(8, 'People / Family'));
    await controller.removeTagFilter(8);
    await controller.setFlaggedOnly(true);
    await controller.setOrder('original-filename-desc');

    expect(controller.getSnapshot().query).toEqual({
      tagIds: [],
      flaggedOnly: true,
      order: 'original-filename-desc',
    });
    expect(controller.getSnapshot().activeTagFilters).toEqual([]);
    expect(api.queryLibrary).toHaveBeenCalledTimes(5);
  });

  it('clears suggestions for blank text and suppresses stale suggestion responses', async () => {
    let resolveFirst: ((value: IpcResult<TagSuggestionDto[]>) => void) | undefined;
    const api = makeApi({
      findTagSuggestions: vi.fn((query: string) => new Promise<IpcResult<TagSuggestionDto[]>>((resolve) => {
        if (query === 'old') {
          resolveFirst = resolve;
        } else {
          resolve(createSuccessResult([tag(2, 'New')]));
        }
      })),
    });
    const controller = new LibraryController(api);

    const oldSearch = controller.updateSuggestionText('old');
    await controller.updateSuggestionText('new');
    resolveFirst?.(createSuccessResult([tag(1, 'Old')]));
    await oldSearch;
    await controller.updateSuggestionText('   ');

    expect(controller.getSnapshot().suggestions).toEqual([]);
    expect(api.findTagSuggestions).toHaveBeenCalledTimes(2);
  });

  it('uses the opaque next cursor, appends in order, and suppresses duplicate photos', async () => {
    const api = makeApi({
      queryLibrary: vi.fn()
        .mockResolvedValueOnce(createSuccessResult(page({ photos: [photo(1), photo(2)], nextCursor: 'opaque-cursor' })))
        .mockResolvedValueOnce(createSuccessResult(page({ photos: [photo(2), photo(3)], nextCursor: null, totalCount: 3 }))),
    });
    const controller = new LibraryController(api);
    await controller.initialize();
    await controller.loadNextPage();

    expect(api.queryLibrary).toHaveBeenLastCalledWith(
      { tagIds: [], flaggedOnly: false, order: 'oldest-imported' },
      { cursor: 'opaque-cursor', pageSize: 200 },
    );
    expect(controller.getSnapshot().photos.map(({ photoId }) => photoId)).toEqual([1, 2, 3]);
    await controller.loadNextPage();
    expect(api.queryLibrary).toHaveBeenCalledTimes(2);
  });

  it('suppresses an obsolete page response after a changed filter starts a new query', async () => {
    let resolveInitial: ((value: IpcResult<LibraryPageResultDto>) => void) | undefined;
    const api = makeApi({
      queryLibrary: vi.fn((query: LibraryQueryDto) => new Promise<IpcResult<LibraryPageResultDto>>((resolve) => {
        if (!query.flaggedOnly) {
          resolveInitial = resolve;
        } else {
          resolve(createSuccessResult(page({ photos: [photo(9)], totalCount: 1 })));
        }
      })),
    });
    const controller = new LibraryController(api);

    const initial = controller.initialize();
    await Promise.resolve();
    const filtered = controller.setFlaggedOnly(true);
    resolveInitial?.(createSuccessResult(page({ photos: [photo(1)], totalCount: 1 })));
    await Promise.all([initial, filtered]);

    expect(controller.getSnapshot().photos.map(({ photoId }) => photoId)).toEqual([9]);
    expect(controller.getSnapshot().query?.flaggedOnly).toBe(true);
  });

  it('discards a selection created after its query has been superseded', async () => {
    let resolveSelection: ((value: IpcResult<SelectionRefDto>) => void) | undefined;
    const api = makeApi({
      createSelection: vi.fn(() => new Promise<IpcResult<SelectionRefDto>>((resolve) => {
        resolveSelection = resolve;
      })),
    });
    const controller = new LibraryController(api);
    await controller.initialize();

    const pendingSelection = controller.togglePhoto(1);
    await Promise.resolve();
    await controller.setFlaggedOnly(true);
    resolveSelection?.(createSuccessResult(selection(1)));
    await pendingSelection;

    expect(controller.getSnapshot().query?.flaggedOnly).toBe(true);
    expect(controller.getSnapshot().selection).toBeNull();
    expect(api.clearSelection).toHaveBeenCalledWith(SELECTION_ID);
  });

  it('captures individual selection first, applies later overrides, and captures Select All without enumeration', async () => {
    const api = makeApi({
      createSelection: vi.fn()
        .mockResolvedValueOnce(createSuccessResult(selection(1)))
        .mockResolvedValueOnce(createSuccessResult(selection(400))),
      updateSelection: vi.fn(async () => createSuccessResult(selection(0))),
    });
    const controller = new LibraryController(api);
    await controller.initialize();
    await controller.togglePhoto(1);
    await controller.togglePhoto(1);
    await controller.selectAll();

    expect(api.createSelection).toHaveBeenNthCalledWith(1, FINGERPRINT, { type: 'one', photoId: 1 });
    expect(api.updateSelection).toHaveBeenCalledWith(SELECTION_ID, [1], false);
    expect(api.createSelection).toHaveBeenNthCalledWith(2, FINGERPRINT, { type: 'all' });
    expect(controller.getSnapshot().selection?.count).toBe(400);
    expect(controller.isPhotoSelected(999)).toBe(true);
  });

  it('uses a local explicit override for a visible card after Select All while retaining the backend count', async () => {
    const api = makeApi({
      createSelection: vi.fn(async () => createSuccessResult(selection(400))),
      updateSelection: vi.fn(async () => createSuccessResult(selection(399))),
    });
    const controller = new LibraryController(api);
    await controller.initialize();
    await controller.selectAll();
    await controller.togglePhoto(1);

    expect(controller.isPhotoSelected(1)).toBe(false);
    expect(controller.isPhotoSelected(2)).toBe(true);
    expect(controller.getSnapshot().selection?.count).toBe(399);
  });

  it('keeps loaded cards visible on incremental failure and retries with the same cursor', async () => {
    const failure = {
      ok: false as const,
      error: {
        code: 'CATALOG_UNAVAILABLE', category: 'unavailable' as const, message: 'Retry me',
        dataSafe: true, retryable: true, correlationId: 'test',
      },
    };
    const api = makeApi({
      queryLibrary: vi.fn()
        .mockResolvedValueOnce(createSuccessResult(page({ nextCursor: 'again' })))
        .mockResolvedValueOnce(failure)
        .mockResolvedValueOnce(createSuccessResult(page({ nextCursor: null }))),
    });
    const controller = new LibraryController(api);
    await controller.initialize();
    await controller.loadNextPage();

    expect(controller.getSnapshot().photos).toHaveLength(2);
    expect(controller.getSnapshot().error?.scope).toBe('incremental');
    await controller.retry();
    expect(api.queryLibrary).toHaveBeenLastCalledWith(expect.anything(), { cursor: 'again', pageSize: 200 });
  });

  it('proves a sole selected photo only when its identity is known from loaded state', () => {
    const base = {
      ...new LibraryController(makeApi()).getSnapshot(),
      photos: [photo(1), photo(2)],
      selection: selection(1),
      selectionMode: 'explicit' as const,
      selectionOverrides: { 1: true, 2: false },
    };
    expect(knownSoleSelectedPhotoId(base)).toBe(1);
    expect(knownSoleSelectedPhotoId({ ...base, selection: selection(2) })).toBeNull();
    expect(knownSoleSelectedPhotoId({
      ...base,
      selectionMode: 'all',
      selectionOverrides: {},
      photos: [photo(1)],
    })).toBe(1);
    expect(knownSoleSelectedPhotoId({
      ...base,
      selectionMode: 'explicit',
      selectionOverrides: {},
    })).toBeNull();
  });

  it('refreshes the current query without discarding filters or selection', async () => {
    const api = makeApi();
    const controller = new LibraryController(api);
    await controller.initialize();
    await controller.setFlaggedOnly(true);
    await controller.togglePhoto(1);
    const before = controller.getSnapshot();

    await controller.refreshCurrentQuery();

    expect(controller.getSnapshot().query).toEqual(before.query);
    expect(controller.getSnapshot().selection).toEqual(before.selection);
    expect(controller.getSnapshot().selectionOverrides).toEqual(before.selectionOverrides);
    expect(api.clearSelection).not.toHaveBeenCalled();
    expect(api.queryLibrary).toHaveBeenLastCalledWith(before.query, { pageSize: 200 });
  });
});
