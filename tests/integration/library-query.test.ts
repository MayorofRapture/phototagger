import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeNewCatalogState } from '../../src/catalog/migrations/initial-state';
import {
  openNewCatalogForSchemaValidation,
  type CatalogDatabase,
} from '../../src/catalog/migrations/schema';
import {
  canonicalizeLibraryQuery,
  fingerprintLibraryQuery,
  IssuedLibraryQueryRegistry,
  normalizeLibraryQuery,
  type LibraryOrder,
  type LibraryQuery,
} from '../../src/catalog/library/library-query-model';
import { LibraryQueryService } from '../../src/catalog/queries/library-query';
import { TagRepository } from '../../src/catalog/repositories/tag-repository';

const temporaryDirectories: string[] = [];
const temporaryDatabases: CatalogDatabase[] = [];
const timestamp = '2026-09-17T12:00:00.000Z';
const hash = Buffer.alloc(32, 9);

const defaultQuery: LibraryQuery = {
  tagIds: [],
  flaggedOnly: false,
  order: 'newest-imported',
};

afterEach(() => {
  for (const database of temporaryDatabases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createCatalog(): { database: CatalogDatabase; databasePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phototagger-library-query-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'catalog.sqlite');
  const database = openNewCatalogForSchemaValidation(databasePath);
  temporaryDatabases.push(database);
  initializeNewCatalogState(database, {
    appVersion: '1.0.0-test',
    now: () => timestamp,
    catalogUuid: () => '00000000-0000-4000-8000-000000000040',
  });
  return { database, databasePath };
}

function insertActivePhoto(
  database: CatalogDatabase,
  photoId: number,
  options: {
    originalFilename?: string;
    flagged?: boolean;
    integrityState?: string;
    width?: number | bigint;
    height?: number | bigint;
    contentRevision?: number;
    thumbnailRevision?: number;
  } = {}
): void {
  database.prepare(`INSERT INTO id_reservations
    (photo_id, origin, state, reserved_at, committed_at)
    VALUES (?, 'import', 'committed', ?, ?)`)
    .run(photoId, timestamp, timestamp);
  database.prepare(`INSERT INTO photos (
    photo_id, original_filename, source_format, lifecycle_state, integrity_state, flagged,
    width, height, display_orientation, source_sha256, current_file_sha256,
    image_data_sha256, content_revision, desired_metadata_revision,
    synced_metadata_revision, embedded_thumbnail_status, thumbnail_state,
    thumbnail_revision, imported_at, updated_at
  ) VALUES (?, ?, 'jpeg', 'active', ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, 0,
    'not_attempted', 'ready', ?, ?, ?)`)
    .run(
      photoId,
      options.originalFilename ?? `photo-${photoId}.jpg`,
      options.integrityState ?? 'clean',
      options.flagged ? 1 : 0,
      options.width ?? 1200,
      options.height ?? 800,
      hash,
      hash,
      hash,
      options.contentRevision ?? 1,
      options.thumbnailRevision ?? 1,
      timestamp,
      timestamp
    );
}

function trashPhoto(database: CatalogDatabase, photoId: number): void {
  database.prepare(`UPDATE photos
    SET lifecycle_state = 'trashed', trashed_at = ?, updated_at = ?
    WHERE photo_id = ?`).run(timestamp, timestamp, photoId);
}

function purgePhoto(database: CatalogDatabase, photoId: number): void {
  const backupId = `backup-${photoId}`;
  const batchId = `purge-${photoId}`;
  database.prepare(`INSERT INTO backup_records (
    backup_id, kind, state, catalog_revision, schema_version, relative_path,
    manifest_relative_path, created_at, updated_at
  ) VALUES (?, 'safety', 'complete', 0, 1, ?, ?, ?, ?)`)
    .run(backupId, `Backups/${backupId}.sqlite`, `Backups/${backupId}.json`, timestamp, timestamp);
  database.prepare(`INSERT INTO trash_batches (
    trash_batch_id, action, state, requested_count, known_size_bytes,
    safety_backup_id, manifest_relative_path, user_authorized_at,
    created_at, updated_at, completed_at
  ) VALUES (?, 'purge', 'completed', 1, 0, ?, ?, ?, ?, ?, ?)`)
    .run(batchId, backupId, `Manifests/${batchId}.json`, timestamp, timestamp, timestamp, timestamp);
  database.prepare(`UPDATE photos SET
    lifecycle_state = 'purged', source_format = NULL, integrity_state = NULL,
    flagged = NULL, width = NULL, height = NULL, display_orientation = NULL,
    current_file_sha256 = NULL, observed_size_bytes = NULL, observed_mtime_ns = NULL,
    content_revision = NULL, desired_metadata_revision = NULL,
    synced_metadata_revision = NULL, metadata_warning_code = NULL,
    embedded_thumbnail_status = NULL, thumbnail_state = NULL,
    thumbnail_revision = NULL, last_verified_at = NULL,
    trashed_at = ?, purged_at = ?, purge_batch_id = ?, updated_at = ?
    WHERE photo_id = ?`)
    .run(timestamp, timestamp, batchId, timestamp, photoId);
}

function assignTag(database: CatalogDatabase, photoId: number, tagId: number): void {
  database.prepare(`INSERT INTO photo_tags (photo_id, tag_id, assigned_at)
    VALUES (?, ?, ?)`).run(photoId, tagId, timestamp);
}

function createLegacyTag(database: CatalogDatabase, displayName: string): number {
  const normalizedKey = displayName.normalize('NFC').toLocaleLowerCase('en-US').normalize('NFC');
  const inserted = database.prepare(`INSERT INTO tags
    (parent_tag_id, display_name, normalized_key, legacy_flat_only, created_at, updated_at)
    VALUES (NULL, ?, ?, 1, ?, ?)`)
    .run(displayName.normalize('NFC'), normalizedKey, timestamp, timestamp);
  const tagId = Number(inserted.lastInsertRowid);
  database.prepare(`INSERT INTO tag_closure (ancestor_tag_id, descendant_tag_id, depth)
    VALUES (?, ?, 0)`).run(tagId, tagId);
  database.prepare(`INSERT INTO tag_paths
    (tag_id, path_display, path_key, leaf_key, depth, updated_at)
    VALUES (?, ?, ?, ?, 1, ?)`)
    .run(tagId, displayName.normalize('NFC'), `legacy-flat:${normalizedKey}`, normalizedKey, timestamp);
  return tagId;
}

function createQueryService(database: CatalogDatabase): LibraryQueryService {
  return new LibraryQueryService(database, new IssuedLibraryQueryRegistry());
}

function traverse(
  service: LibraryQueryService,
  query: LibraryQuery,
  pageSize: number
): number[] {
  const photoIds: number[] = [];
  let cursor: string | null = null;
  do {
    const page = service.queryLibrary(query, { cursor, pageSize });
    photoIds.push(...page.photos.map((photo) => photo.photoId));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return photoIds;
}

describe('Library query model and service', () => {
  it('normalizes tag IDs and produces fixed canonical fingerprints', () => {
    const first = normalizeLibraryQuery({
      order: 'newest-imported',
      tagIds: [2, 1, 2],
      flaggedOnly: false,
    });
    const reordered = normalizeLibraryQuery({
      tagIds: [1, 2],
      flaggedOnly: false,
      order: 'newest-imported',
    });

    expect(first).toEqual({
      tagIds: [1, 2],
      flaggedOnly: false,
      order: 'newest-imported',
    });
    expect(canonicalizeLibraryQuery(first)).toBe(
      '{"flaggedOnly":false,"order":"newest-imported","tagIds":[1,2]}'
    );
    expect(fingerprintLibraryQuery(first)).toBe(
      '20732c60be94e977b9efc873c503044b7f06d785b0801a446cb9f62115f1bdcd'
    );
    expect(fingerprintLibraryQuery(reordered)).toBe(fingerprintLibraryQuery(first));
    expect(fingerprintLibraryQuery({ ...first, flaggedOnly: true }))
      .not.toBe(fingerprintLibraryQuery(first));
    expect(fingerprintLibraryQuery({ ...first, order: 'oldest-imported' }))
      .not.toBe(fingerprintLibraryQuery(first));
    expect(fingerprintLibraryQuery({ ...first, tagIds: [1] }))
      .not.toBe(fingerprintLibraryQuery(first));
  });

  it('strictly rejects malformed query input and unknown tag IDs without mutation', () => {
    const { database } = createCatalog();
    const service = createQueryService(database);
    const beforeRevision = database.prepare(
      'SELECT catalog_revision FROM app_state WHERE singleton = 1'
    ).get();

    for (const invalid of [
      { tagIds: [0], flaggedOnly: false, order: 'newest-imported' },
      { tagIds: [1.5], flaggedOnly: false, order: 'newest-imported' },
      { tagIds: ['1'], flaggedOnly: false, order: 'newest-imported' },
      { tagIds: [], flaggedOnly: 0, order: 'newest-imported' },
      { tagIds: [], flaggedOnly: false, order: 'recent' },
      { tagIds: [], flaggedOnly: false, order: 'newest-imported', extra: true },
    ]) {
      expect(() => service.queryLibrary(invalid)).toThrow();
    }
    expect(() => service.queryLibrary({ ...defaultQuery, tagIds: [999] })).toThrow(/unknown tag/i);
    expect(database.prepare('SELECT catalog_revision FROM app_state WHERE singleton = 1').get())
      .toEqual(beforeRevision);
  });

  it('returns only active photos while preserving every active integrity state and flag mode', () => {
    const { database } = createCatalog();
    const integrityStates = [
      'clean',
      'missing',
      'unreadable',
      'metadata_conflict',
      'content_conflict',
      'recovery_required',
    ];
    integrityStates.forEach((integrityState, index) => {
      insertActivePhoto(database, index + 1, {
        integrityState,
        flagged: index % 2 === 0,
      });
    });
    insertActivePhoto(database, 7);
    trashPhoto(database, 7);
    insertActivePhoto(database, 8);
    purgePhoto(database, 8);
    const service = createQueryService(database);

    const all = service.queryLibrary(defaultQuery);
    expect(all.totalCount).toBe(6);
    expect(all.photos.map((photo) => photo.integrityState).sort()).toEqual([...integrityStates].sort());
    expect(all.photos.some((photo) => photo.flagged)).toBe(true);
    expect(all.photos.some((photo) => !photo.flagged)).toBe(true);
    const flagged = service.queryLibrary({ ...defaultQuery, flaggedOnly: true });
    expect(flagged.totalCount).toBe(3);
    expect(flagged.photos.every((photo) => photo.flagged)).toBe(true);
    expect(all.photos.map((photo) => photo.photoId)).not.toContain(7);
    expect(all.photos.map((photo) => photo.photoId)).not.toContain(8);
  });

  it('implements descendant-aware hierarchical filters with logical AND semantics', () => {
    const { database } = createCatalog();
    const tags = new TagRepository(database, { now: () => timestamp });
    const animalPath = tags.resolveOrCreatePath('Animals/Cats/Siamese').path;
    const blue = tags.resolveOrCreatePath('Color/Blue').path[1];
    for (let photoId = 1; photoId <= 4; photoId += 1) {
      insertActivePhoto(database, photoId);
    }
    assignTag(database, 1, animalPath[2].tagId);
    assignTag(database, 1, blue.tagId);
    assignTag(database, 2, animalPath[0].tagId);
    assignTag(database, 3, animalPath[1].tagId);
    assignTag(database, 4, blue.tagId);
    const service = createQueryService(database);
    const idsFor = (tagIds: number[]) => service.queryLibrary({
      ...defaultQuery,
      tagIds,
    }).photos.map((photo) => photo.photoId);

    expect(idsFor([animalPath[0].tagId])).toEqual([3, 2, 1]);
    expect(idsFor([animalPath[1].tagId])).toEqual([3, 1]);
    expect(idsFor([animalPath[2].tagId])).toEqual([1]);
    expect(idsFor([animalPath[0].tagId, blue.tagId])).toEqual([1]);
  });

  it('keeps same-name hierarchy filters independent and supports legacy self filters', () => {
    const { database } = createCatalog();
    const tags = new TagRepository(database, { now: () => timestamp });
    const petsCats = tags.resolveOrCreatePath('Pets/Cats').path[1];
    const peopleCats = tags.resolveOrCreatePath('People/Cats').path[1];
    const legacy = createLegacyTag(database, 'Legacy/Flat');
    for (let photoId = 1; photoId <= 4; photoId += 1) {
      insertActivePhoto(database, photoId);
    }
    assignTag(database, 1, petsCats.tagId);
    assignTag(database, 2, peopleCats.tagId);
    assignTag(database, 3, legacy);
    const service = createQueryService(database);

    expect(service.queryLibrary({ ...defaultQuery, tagIds: [petsCats.tagId] }).photos
      .map((photo) => photo.photoId)).toEqual([1]);
    expect(service.queryLibrary({ ...defaultQuery, tagIds: [peopleCats.tagId] }).photos
      .map((photo) => photo.photoId)).toEqual([2]);
    expect(service.queryLibrary({ ...defaultQuery, tagIds: [legacy] }).photos
      .map((photo) => photo.photoId)).toEqual([3]);
    expect(service.queryLibrary(defaultQuery).totalCount).toBe(4);
  });

  it('implements all four deterministic sort modes including duplicate filenames', () => {
    const { database } = createCatalog();
    insertActivePhoto(database, 1, { originalFilename: 'beta.jpg' });
    insertActivePhoto(database, 2, { originalFilename: 'same.jpg' });
    insertActivePhoto(database, 3, { originalFilename: 'alpha.jpg' });
    insertActivePhoto(database, 4, { originalFilename: 'same.jpg' });
    const service = createQueryService(database);
    const ids = (order: LibraryOrder) => service.queryLibrary({ ...defaultQuery, order }).photos
      .map((photo) => photo.photoId);

    expect(ids('newest-imported')).toEqual([4, 3, 2, 1]);
    expect(ids('oldest-imported')).toEqual([1, 2, 3, 4]);
    expect(ids('original-filename-asc')).toEqual([3, 1, 2, 4]);
    expect(ids('original-filename-desc')).toEqual([4, 2, 1, 3]);
  });

  it('uses keyset paging without duplicates or skips in every order', () => {
    const { database } = createCatalog();
    insertActivePhoto(database, 1, { originalFilename: 'beta.jpg' });
    insertActivePhoto(database, 2, { originalFilename: 'same.jpg' });
    insertActivePhoto(database, 3, { originalFilename: 'alpha.jpg' });
    insertActivePhoto(database, 4, { originalFilename: 'same.jpg' });
    insertActivePhoto(database, 5, { originalFilename: 'delta.jpg' });
    const service = createQueryService(database);
    const expected: Record<LibraryOrder, number[]> = {
      'newest-imported': [5, 4, 3, 2, 1],
      'oldest-imported': [1, 2, 3, 4, 5],
      'original-filename-asc': [3, 1, 5, 2, 4],
      'original-filename-desc': [4, 2, 5, 1, 3],
    };

    for (const order of Object.keys(expected) as LibraryOrder[]) {
      const traversed = traverse(service, { ...defaultQuery, order }, 1);
      expect(traversed).toEqual(expected[order]);
      expect(new Set(traversed).size).toBe(traversed.length);
    }
    const finalPage = service.queryLibrary(defaultQuery, {
      cursor: service.queryLibrary(defaultQuery, { pageSize: 4 }).nextCursor,
      pageSize: 4,
    });
    expect(finalPage.photos).toHaveLength(1);
    expect(finalPage.nextCursor).toBeNull();
  });

  it('uses and validates the approved 200-row page-size bound', () => {
    const { database } = createCatalog();
    for (let photoId = 1; photoId <= 201; photoId += 1) {
      insertActivePhoto(database, photoId);
    }
    const service = createQueryService(database);

    expect(service.queryLibrary(defaultQuery).photos).toHaveLength(200);
    expect(service.queryLibrary(defaultQuery, { pageSize: 200 }).photos).toHaveLength(200);
    expect(service.queryLibrary(defaultQuery, { pageSize: 1 }).photos).toHaveLength(1);
    for (const pageSize of [0, -1, 1.5, 201]) {
      expect(() => service.queryLibrary(defaultQuery, { pageSize })).toThrow();
    }
  });

  it('binds opaque issued cursors to the exact query and order', () => {
    const { database } = createCatalog();
    insertActivePhoto(database, 1);
    insertActivePhoto(database, 2);
    const registry = new IssuedLibraryQueryRegistry();
    const service = new LibraryQueryService(database, registry);
    const first = service.queryLibrary(defaultQuery, { pageSize: 1 });
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor as string;

    expect(() => service.queryLibrary({ ...defaultQuery, flaggedOnly: true }, {
      cursor,
      pageSize: 1,
    })).toThrow(/different query/i);
    expect(() => service.queryLibrary(defaultQuery, { cursor: 'not+a+cursor', pageSize: 1 }))
      .toThrow();

    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    const wrongOrder = Buffer.from(JSON.stringify({ ...payload, order: 'oldest-imported' }))
      .toString('base64url');
    expect(() => service.queryLibrary(defaultQuery, { cursor: wrongOrder, pageSize: 1 }))
      .toThrow(/order/i);
    const unsafe = Buffer.from(JSON.stringify({
      ...payload,
      sortValue: 9007199254740992,
      photoId: 9007199254740992,
    })).toString('base64url');
    expect(() => service.queryLibrary(defaultQuery, { cursor: unsafe, pageSize: 1 }))
      .toThrow(/safe integer/i);
    const fabricated = Buffer.from(JSON.stringify({
      ...payload,
      sortValue: 1,
      photoId: 1,
    })).toString('base64url');
    expect(() => service.queryLibrary(defaultQuery, { cursor: fabricated, pageSize: 1 }))
      .toThrow(/not issued/i);
    const restartedService = new LibraryQueryService(database, new IssuedLibraryQueryRegistry());
    expect(() => restartedService.queryLibrary(defaultQuery, { cursor, pageSize: 1 }))
      .toThrow(/fingerprint was not issued/i);
  });

  it('returns validated renderer-safe photo summaries with ID-only URLs', () => {
    const { database } = createCatalog();
    insertActivePhoto(database, 1, {
      originalFilename: 'one.jpg',
      flagged: true,
      width: 427,
      height: 240,
      contentRevision: 3,
      thumbnailRevision: 4,
    });
    insertActivePhoto(database, 427, { originalFilename: 'four-twenty-seven.jpg' });
    insertActivePhoto(database, 10_000_000_001, { originalFilename: 'large-id.jpg' });
    const photos = createQueryService(database).queryLibrary(defaultQuery).photos;
    const one = photos.find((photo) => photo.photoId === 1);
    const fourTwentySeven = photos.find((photo) => photo.photoId === 427);
    const large = photos.find((photo) => photo.photoId === 10_000_000_001);

    expect(one).toEqual({
      photoId: 1,
      canonicalFilename: '0000000001.jpg',
      originalFilename: 'one.jpg',
      flagged: true,
      integrityState: 'clean',
      width: 427,
      height: 240,
      contentRevision: 3,
      thumbnailRevision: 4,
      thumbnailUrl: 'pt-photo://thumb/1?thumb=4',
    });
    expect(fourTwentySeven?.canonicalFilename).toBe('0000000427.jpg');
    expect(large?.canonicalFilename).toBe('10000000001.jpg');
    expect(Object.values(one ?? {}).some((value) => typeof value === 'bigint')).toBe(false);
    for (const value of [
      one?.photoId,
      one?.width,
      one?.height,
      one?.contentRevision,
      one?.thumbnailRevision,
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
    expect(JSON.stringify(photos)).not.toMatch(/[A-Z]:\\/i);
  });

  it('fails clearly when selected photo data cannot form a safe DTO', () => {
    const { database } = createCatalog();
    insertActivePhoto(database, 1);
    database.pragma('ignore_check_constraints = ON');
    database.prepare("UPDATE photos SET integrity_state = 'invalid' WHERE photo_id = 1").run();
    database.pragma('ignore_check_constraints = OFF');

    expect(() => createQueryService(database).queryLibrary(defaultQuery))
      .toThrow(/integrity_state is invalid/);
  });

  it('returns complete filtered counts from the same request as the page', () => {
    const { database } = createCatalog();
    const tags = new TagRepository(database, { now: () => timestamp });
    const cats = tags.resolveOrCreatePath('Pets/Cats').path[1];
    for (let photoId = 1; photoId <= 5; photoId += 1) {
      insertActivePhoto(database, photoId, { flagged: photoId % 2 === 1 });
    }
    assignTag(database, 1, cats.tagId);
    assignTag(database, 2, cats.tagId);
    assignTag(database, 3, cats.tagId);
    trashPhoto(database, 3);
    const service = createQueryService(database);

    const tagPage = service.queryLibrary({ ...defaultQuery, tagIds: [cats.tagId] }, { pageSize: 1 });
    expect(tagPage.photos).toHaveLength(1);
    expect(tagPage.totalCount).toBe(2);
    const flaggedPage = service.queryLibrary({ ...defaultQuery, flaggedOnly: true }, { pageSize: 1 });
    expect(flaggedPage.totalCount).toBe(2);
  });
});
