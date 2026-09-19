import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogProcessHandler } from '../../src/catalog/catalog-process';
import { initializeNewCatalogState } from '../../src/catalog/migrations/initial-state';
import {
  openNewCatalogForSchemaValidation,
  openProductionCatalog,
  type CatalogDatabase,
} from '../../src/catalog/migrations/schema';
import { TagRepository } from '../../src/catalog/repositories/tag-repository';
import {
  CatalogRequestType,
  type CatalogResponse,
} from '../../src/shared/contracts/catalog-process';
import type {
  LibraryPageResultDto,
  LibraryViewSessionResultDto,
  PhotoDetailDto,
  ReadGeneralSettingsResultDto,
  SelectionRefDto,
  TagSuggestionDto,
} from '../../src/shared/contracts/catalog-api';

const directories: string[] = [];
const handlers: CatalogProcessHandler[] = [];
const timestamp = '2026-09-17T15:00:00.000Z';
const hash = Buffer.alloc(32, 17);
const query = {
  tagIds: [],
  flaggedOnly: false,
  order: 'newest-imported' as const,
};

afterEach(() => {
  for (const handler of handlers.splice(0)) {
    handler.closeDatabase();
  }
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createSeededCatalog(): { databasePath: string; revision: bigint } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phototagger-catalog-operations-'));
  directories.push(directory);
  const databasePath = path.join(directory, 'catalog.sqlite');
  const database = openNewCatalogForSchemaValidation(databasePath);
  initializeNewCatalogState(database, {
    appVersion: '1.0.0-test',
    now: () => timestamp,
    catalogUuid: () => '00000000-0000-4000-8000-000000000060',
  });
  const cats = new TagRepository(database, {
    now: () => timestamp,
  }).resolveOrCreatePath('Pets/Cats').path[1];
  for (let photoId = 1; photoId <= 3; photoId += 1) {
    insertPhoto(database, photoId);
  }
  database
    .prepare('INSERT INTO photo_tags (photo_id, tag_id, assigned_at) VALUES (?, ?, ?)')
    .run(1, cats.tagId, timestamp);
  const revision = (
    database.prepare('SELECT catalog_revision FROM app_state WHERE singleton = 1').get() as {
      catalog_revision: bigint;
    }
  ).catalog_revision;
  database.close();
  return { databasePath, revision };
}

function insertPhoto(database: CatalogDatabase, photoId: number): void {
  database
    .prepare(
      `INSERT INTO id_reservations
    (photo_id, origin, state, reserved_at, committed_at)
    VALUES (?, 'import', 'committed', ?, ?)`
    )
    .run(photoId, timestamp, timestamp);
  database
    .prepare(
      `INSERT INTO photos (
    photo_id, original_filename, source_format, lifecycle_state, integrity_state, flagged,
    width, height, display_orientation, source_sha256, current_file_sha256,
    image_data_sha256, content_revision, desired_metadata_revision,
    synced_metadata_revision, embedded_thumbnail_status, thumbnail_state,
    thumbnail_revision, imported_at, updated_at
  ) VALUES (?, ?, 'jpeg', 'active', 'clean', 0, 1200, 800, 1, ?, ?, ?, 1, 0, 0,
    'not_attempted', 'ready', 1, ?, ?)`
    )
    .run(photoId, `photo-${photoId}.jpg`, hash, hash, hash, timestamp, timestamp);
}

function openHandler(databasePath: string): CatalogProcessHandler {
  const handler = new CatalogProcessHandler({}, false);
  handlers.push(handler);
  expect(
    success(handler, CatalogRequestType.OPEN_CATALOG, {
      databasePath,
      appVersion: '1.0.0-test',
    })
  ).toMatchObject({ opened: true, created: false, userVersion: 1 });
  return handler;
}

function response(handler: CatalogProcessHandler, type: string, payload: unknown): CatalogResponse {
  return handler.handleRawMessage({
    requestId: `${type}-${Math.random()}`,
    type,
    payload,
  });
}

function success<T>(handler: CatalogProcessHandler, type: string, payload: unknown): T {
  const result = response(handler, type, payload);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.result as T;
}

function failure(handler: CatalogProcessHandler, type: string, payload: unknown): CatalogResponse {
  const result = response(handler, type, payload);
  expect(result.success).toBe(false);
  return result;
}

describe('M1E1 catalog operation integration', () => {
  it('executes settings, suggestions, Library query, and every selection operation', () => {
    const { databasePath, revision } = createSeededCatalog();
    const handler = openHandler(databasePath);

    const settings = success<ReadGeneralSettingsResultDto>(
      handler,
      CatalogRequestType.READ_GENERAL_SETTINGS,
      {}
    );
    expect(settings).toEqual({
      settings: {
        jpegQuality: 92,
        alphaBackground: '#ffffff',
        defaultOrder: 'newest-imported',
        warningThreshold: 500,
      },
      warnings: [],
    });

    const suggestions = success<TagSuggestionDto[]>(
      handler,
      CatalogRequestType.FIND_TAG_SUGGESTIONS,
      { query: 'cat', limit: 10 }
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      displayName: 'Cats',
      fullPath: 'Pets/Cats',
    });

    const page = success<LibraryPageResultDto>(handler, CatalogRequestType.QUERY_LIBRARY, {
      query,
      options: { pageSize: 1 },
    });
    expect(page.totalCount).toBe(3);
    expect(page.photos).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.queryFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const detail = success<PhotoDetailDto>(handler, CatalogRequestType.GET_PHOTO_DETAIL, {
      photoId: 2,
    });
    expect(detail).toMatchObject({
      photoId: 2,
      fullImageUrl: 'pt-photo://full/2?content=1',
      explicitTags: [],
    });
    const view = success<LibraryViewSessionResultDto>(
      handler,
      CatalogRequestType.CREATE_VIEW_SESSION,
      { queryFingerprint: page.queryFingerprint, selectedPhotoId: 2 }
    );
    expect(view).toMatchObject({ position: 1, count: 3, detail: { photoId: 2 } });
    expect(success<LibraryViewSessionResultDto>(
      handler,
      CatalogRequestType.NAVIGATE_VIEW_SESSION,
      { viewSessionId: view.viewSessionId, direction: 'next' }
    )).toMatchObject({ position: 2, detail: { photoId: 1 } });

    const none = success<SelectionRefDto>(handler, CatalogRequestType.CREATE_SELECTION, {
      queryFingerprint: page.queryFingerprint,
      seed: { type: 'none' },
    });
    expect(none.count).toBe(0);
    expect(
      success<SelectionRefDto>(handler, CatalogRequestType.UPDATE_SELECTION, {
        selectionId: none.selectionId,
        photoIds: [2],
        selected: true,
      }).count
    ).toBe(1);
    expect(
      success<SelectionRefDto>(handler, CatalogRequestType.UPDATE_SELECTION, {
        selectionId: none.selectionId,
        photoIds: [2],
        selected: false,
      }).count
    ).toBe(0);
    const one = success<SelectionRefDto>(handler, CatalogRequestType.CREATE_SELECTION, {
      queryFingerprint: page.queryFingerprint,
      seed: { type: 'one', photoId: 1 },
    });
    expect(one.count).toBe(1);
    const all = success<SelectionRefDto>(handler, CatalogRequestType.CREATE_SELECTION, {
      queryFingerprint: page.queryFingerprint,
      seed: { type: 'all' },
    });
    expect(all.count).toBe(3);
    expect(Object.keys(all).sort()).toEqual(['catalogRevisionAtCapture', 'count', 'selectionId']);

    const updated = success<SelectionRefDto>(handler, CatalogRequestType.UPDATE_SELECTION, {
      selectionId: all.selectionId,
      photoIds: [1],
      selected: false,
    });
    expect(updated.count).toBe(2);
    expect(
      success<SelectionRefDto>(handler, CatalogRequestType.GET_SELECTION, {
        selectionId: all.selectionId,
      }).count
    ).toBe(2);
    expect(
      success(handler, CatalogRequestType.CLEAR_SELECTION, {
        selectionId: all.selectionId,
      })
    ).toEqual({ cleared: true });
    failure(handler, CatalogRequestType.GET_SELECTION, {
      selectionId: all.selectionId,
    });

    success(handler, CatalogRequestType.CLOSE_CATALOG, {});
    const reopened = openProductionCatalog(databasePath).database;
    const afterRevision = (
      reopened.prepare('SELECT catalog_revision FROM app_state WHERE singleton = 1').get() as {
        catalog_revision: bigint;
      }
    ).catalog_revision;
    reopened.close();
    expect(afterRevision).toBe(revision);
  });

  it('does not accept query identities from another runtime', () => {
    const { databasePath } = createSeededCatalog();
    const first = openHandler(databasePath);
    const page = success<LibraryPageResultDto>(first, CatalogRequestType.QUERY_LIBRARY, {
      query,
      options: { pageSize: 1 },
    });
    const second = openHandler(databasePath);

    const rejected = failure(second, CatalogRequestType.CREATE_SELECTION, {
      queryFingerprint: page.queryFingerprint,
      seed: { type: 'none' },
    });
    if (!rejected.success) {
      expect(rejected.error.message).toMatch(/not issued/i);
    }
  });

  it('resets fingerprints, cursors, and TEMP selections when a catalog closes', () => {
    const { databasePath } = createSeededCatalog();
    const handler = openHandler(databasePath);
    const page = success<LibraryPageResultDto>(handler, CatalogRequestType.QUERY_LIBRARY, {
      query,
      options: { pageSize: 1 },
    });
    const selection = success<SelectionRefDto>(handler, CatalogRequestType.CREATE_SELECTION, {
      queryFingerprint: page.queryFingerprint,
      seed: { type: 'all' },
    });
    const view = success<LibraryViewSessionResultDto>(
      handler,
      CatalogRequestType.CREATE_VIEW_SESSION,
      { queryFingerprint: page.queryFingerprint, selectedPhotoId: 2 }
    );
    success(handler, CatalogRequestType.CLOSE_CATALOG, {});
    success(handler, CatalogRequestType.OPEN_CATALOG, {
      databasePath,
      appVersion: '1.0.0-test',
    });

    failure(handler, CatalogRequestType.CREATE_SELECTION, {
      queryFingerprint: page.queryFingerprint,
      seed: { type: 'none' },
    });
    failure(handler, CatalogRequestType.GET_SELECTION, {
      selectionId: selection.selectionId,
    });
    failure(handler, CatalogRequestType.QUERY_LIBRARY, {
      query,
      options: { pageSize: 1, cursor: page.nextCursor },
    });
    failure(handler, CatalogRequestType.NAVIGATE_VIEW_SESSION, {
      viewSessionId: view.viewSessionId,
      direction: 'next',
    });
  });
});
