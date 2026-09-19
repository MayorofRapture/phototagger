import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IssuedLibraryQueryRegistry,
  type LibraryOrder,
} from '../../src/catalog/library/library-query-model';
import { initializeNewCatalogState } from '../../src/catalog/migrations/initial-state';
import {
  createSessionTables,
  openNewCatalogForSchemaValidation,
  openProductionCatalog,
  type CatalogDatabase,
} from '../../src/catalog/migrations/schema';
import { LibraryQueryService } from '../../src/catalog/queries/library-query';
import { PhotoDetailQuery } from '../../src/catalog/queries/photo-detail';
import { TagRepository } from '../../src/catalog/repositories/tag-repository';
import { LibraryViewSessionService } from '../../src/catalog/sessions/library-view-session-service';

const timestamp = '2026-09-18T12:00:00.000Z';
const hash = Buffer.alloc(32, 31);
const directories: string[] = [];
const databases: CatalogDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createCatalog(): { database: CatalogDatabase; databasePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phototagger-view-session-'));
  directories.push(directory);
  const databasePath = path.join(directory, 'catalog.sqlite');
  const database = openNewCatalogForSchemaValidation(databasePath);
  databases.push(database);
  initializeNewCatalogState(database, {
    appVersion: '1.0.0-test',
    now: () => timestamp,
    catalogUuid: () => '00000000-0000-4000-8000-000000000070',
  });
  createSessionTables(database);
  return { database, databasePath };
}

function insertPhoto(
  database: CatalogDatabase,
  photoId: number,
  options: {
    originalFilename?: string;
    integrityState?: 'clean' | 'missing' | 'unreadable' | 'metadata_conflict' | 'content_conflict' | 'recovery_required';
    lifecycleState?: 'active' | 'trashed';
    flagged?: boolean;
    contentRevision?: number;
    thumbnailRevision?: number;
    desiredMetadataRevision?: number;
    syncedMetadataRevision?: number;
    warningCode?: string | null;
  } = {}
): void {
  const lifecycleState = options.lifecycleState ?? 'active';
  database.prepare(`INSERT INTO id_reservations
    (photo_id, origin, state, reserved_at, committed_at)
    VALUES (?, 'import', 'committed', ?, ?)`)
    .run(photoId, timestamp, timestamp);
  database.prepare(`INSERT INTO photos (
    photo_id, original_filename, source_format, lifecycle_state, integrity_state, flagged,
    width, height, display_orientation, source_sha256, current_file_sha256,
    image_data_sha256, content_revision, desired_metadata_revision,
    synced_metadata_revision, metadata_warning_code, embedded_thumbnail_status,
    thumbnail_state, thumbnail_revision, imported_at, trashed_at, last_verified_at, updated_at
  ) VALUES (?, ?, 'jpeg', ?, ?, ?, 1200, 800, 1, ?, ?, ?, ?, ?, ?, ?,
    'not_attempted', 'ready', ?, ?, ?, ?, ?)`)
    .run(
      photoId,
      options.originalFilename ?? `photo-${photoId}.jpg`,
      lifecycleState,
      options.integrityState ?? 'clean',
      options.flagged ? 1 : 0,
      hash,
      hash,
      hash,
      options.contentRevision ?? 1,
      options.desiredMetadataRevision ?? 0,
      options.syncedMetadataRevision ?? 0,
      options.warningCode ?? null,
      options.thumbnailRevision ?? 1,
      timestamp,
      lifecycleState === 'trashed' ? timestamp : null,
      timestamp,
      timestamp
    );
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

function createServices(database: CatalogDatabase): {
  queries: LibraryQueryService;
  views: LibraryViewSessionService;
} {
  const registry = new IssuedLibraryQueryRegistry();
  let nextId = 1;
  return {
    queries: new LibraryQueryService(database, registry),
    views: new LibraryViewSessionService(database, registry, {
      now: () => timestamp,
      viewSessionId: () =>
        `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
    }),
  };
}

function issue(
  queries: LibraryQueryService,
  order: LibraryOrder = 'newest-imported',
  pageSize = 200,
  flaggedOnly = false
): string {
  return queries.queryLibrary({ tagIds: [], flaggedOnly, order }, { pageSize }).queryFingerprint;
}

function memberIds(database: CatalogDatabase, viewSessionId: string): number[] {
  const rows = database.prepare(`SELECT photo_id FROM temp.view_members
    WHERE view_session_id = ? ORDER BY position`).all(viewSessionId) as Array<{ photo_id: bigint }>;
  return rows.map((row) => Number(row.photo_id));
}

function revision(database: CatalogDatabase): bigint {
  return (database.prepare(
    'SELECT catalog_revision FROM app_state WHERE singleton = 1'
  ).get() as { catalog_revision: bigint }).catalog_revision;
}

describe('PhotoDetailQuery', () => {
  it('returns a renderer-safe active detail with only explicit full tag paths', () => {
    const { database } = createCatalog();
    insertPhoto(database, 427, { contentRevision: 3, thumbnailRevision: 4 });
    const tagPath = new TagRepository(database, { now: () => timestamp })
      .resolveOrCreatePath('Pets/Cats/Siamese').path;
    const leaf = tagPath[2];
    database.prepare('INSERT INTO photo_tags (photo_id, tag_id, assigned_at) VALUES (?, ?, ?)')
      .run(427, leaf.tagId, timestamp);
    database.prepare('INSERT INTO palette_entries (tag_id, position, pinned_at) VALUES (?, 0, ?)')
      .run(leaf.tagId, timestamp);

    const detail = new PhotoDetailQuery(database).getPhotoDetail(427);

    expect(detail).toMatchObject({
      photoId: 427,
      canonicalFilename: '0000000427.jpg',
      lifecycleState: 'active',
      fullImageUrl: 'pt-photo://full/427?content=3',
      thumbnailUrl: 'pt-photo://thumb/427?thumb=4',
      metadataState: 'synchronized',
    });
    expect(detail.explicitTags).toEqual([
      expect.objectContaining({
        tagId: leaf.tagId,
        parentTagId: tagPath[1].tagId,
        displayName: 'Siamese',
        fullPath: 'Pets/Cats/Siamese',
        depth: 3,
        pinned: true,
      }),
    ]);
    expect(detail.explicitTags.map((tag) => tag.fullPath)).not.toContain('Pets');
    expect(() => JSON.stringify(detail)).not.toThrow();
    expect(structuredClone(detail)).toEqual(detail);
  });

  it('rejects purged photos and omits full URLs for every non-clean integrity state', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1);
    purgePhoto(database, 1);
    const details = new PhotoDetailQuery(database);
    expect(() => details.getPhotoDetail(1)).toThrow(/not found/i);

    const states = ['missing', 'unreadable', 'metadata_conflict', 'content_conflict', 'recovery_required'] as const;
    states.forEach((state, index) => insertPhoto(database, index + 2, { integrityState: state }));
    for (let photoId = 2; photoId <= 6; photoId += 1) {
      expect(details.getPhotoDetail(photoId).fullImageUrl).toBeUndefined();
    }
  });

  it('derives all approved metadata states from job, revision, and warning state', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1, { desiredMetadataRevision: 2, syncedMetadataRevision: 1 });
    const details = new PhotoDetailQuery(database);
    expect(details.getPhotoDetail(1).metadataState).toBe('pending');

    const expected = {
      pending: 'pending',
      debouncing: 'pending',
      writing: 'writing',
      failed: 'failed',
      suspended: 'suspended_conflict',
      completed_warning: 'synchronized_with_warning',
    } as const;
    for (const [state, result] of Object.entries(expected)) {
      database.prepare('DELETE FROM metadata_jobs WHERE photo_id = 1').run();
      database.prepare(`INSERT INTO metadata_jobs (
        photo_id, requested_revision, writing_revision, state, not_before,
        attempt_count, created_at, updated_at
      ) VALUES (1, 2, ?, ?, ?, 0, ?, ?)`)
        .run(state === 'writing' ? 2 : null, state, timestamp, timestamp, timestamp);
      expect(details.getPhotoDetail(1).metadataState).toBe(result);
    }
    database.prepare('DELETE FROM metadata_jobs WHERE photo_id = 1').run();
    database.prepare(`UPDATE photos SET desired_metadata_revision = 1,
      synced_metadata_revision = 1, metadata_warning_code = 'embedded_thumbnail_capacity'
      WHERE photo_id = 1`).run();
    expect(details.getPhotoDetail(1).metadataState).toBe('synchronized_with_warning');
  });
});

describe('LibraryViewSessionService', () => {
  it('requires an issued fingerprint and selected query member without leaving orphans', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1, { flagged: true });
    insertPhoto(database, 2);
    const { queries, views } = createServices(database);
    expect(() => views.createViewSession('a'.repeat(64), 1)).toThrow(/not issued/i);
    const fingerprint = issue(queries, 'newest-imported', 200, true);
    expect(() => views.createViewSession(fingerprint, 2)).toThrow(/does not belong/i);
    expect(database.prepare('SELECT COUNT(*) AS count FROM temp.view_sessions').get())
      .toEqual({ count: 0n });
    expect(database.prepare('SELECT COUNT(*) AS count FROM temp.view_members').get())
      .toEqual({ count: 0n });
  });

  it('freezes the complete query, records contiguous positions/revision, and does not mutate revision', () => {
    const { database } = createCatalog();
    for (let photoId = 1; photoId <= 5; photoId += 1) {
      insertPhoto(database, photoId);
    }
    database.prepare('UPDATE app_state SET catalog_revision = 19 WHERE singleton = 1').run();
    const { queries, views } = createServices(database);
    const before = revision(database);
    const result = views.createViewSession(issue(queries, 'newest-imported', 1), 3);

    expect(result).toMatchObject({ position: 2, count: 5, detail: { photoId: 3 } });
    expect(memberIds(database, result.viewSessionId)).toEqual([5, 4, 3, 2, 1]);
    expect(database.prepare(`SELECT position FROM temp.view_members
      WHERE view_session_id = ? ORDER BY position`).pluck().all(result.viewSessionId))
      .toEqual([0n, 1n, 2n, 3n, 4n]);
    expect(database.prepare(`SELECT catalog_revision FROM temp.view_sessions
      WHERE view_session_id = ?`).pluck().get(result.viewSessionId)).toBe(19n);
    expect(revision(database)).toBe(before);
  });

  it('matches all four authoritative Library order modes', () => {
    const names = ['Zulu.jpg', 'Alpha.jpg', 'Alpha.jpg'];
    const expected: Record<LibraryOrder, number[]> = {
      'newest-imported': [3, 2, 1],
      'oldest-imported': [1, 2, 3],
      'original-filename-asc': [2, 3, 1],
      'original-filename-desc': [1, 3, 2],
    };
    for (const order of Object.keys(expected) as LibraryOrder[]) {
      const { database } = createCatalog();
      names.forEach((name, index) => insertPhoto(database, index + 1, { originalFilename: name }));
      const { queries, views } = createServices(database);
      const result = views.createViewSession(issue(queries, order, 1), expected[order][1]);
      expect(memberIds(database, result.viewSessionId)).toEqual(expected[order]);
      database.close();
    }
  });

  it('rolls back a forced membership failure atomically', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1);
    insertPhoto(database, 2);
    const { queries, views } = createServices(database);
    const fingerprint = issue(queries);
    database.exec(`CREATE TEMP TRIGGER fail_view_member
      BEFORE INSERT ON view_members
      WHEN NEW.photo_id = 2
      BEGIN SELECT RAISE(ABORT, 'forced view failure'); END;`);

    expect(() => views.createViewSession(fingerprint, 1)).toThrow(/forced view failure/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM temp.view_sessions').get())
      .toEqual({ count: 0n });
    expect(database.prepare('SELECT COUNT(*) AS count FROM temp.view_members').get())
      .toEqual({ count: 0n });
  });

  it('navigates stored positions without wrapping and keeps missing members navigable', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1);
    insertPhoto(database, 2, { integrityState: 'missing' });
    insertPhoto(database, 3);
    const { queries, views } = createServices(database);
    const created = views.createViewSession(issue(queries, 'oldest-imported'), 1);

    expect(() => views.navigateView(created.viewSessionId, 'previous')).toThrow(/first member/i);
    const missing = views.navigateView(created.viewSessionId, 'next');
    expect(missing).toMatchObject({ position: 1, count: 3, detail: { photoId: 2 } });
    expect(missing.detail.fullImageUrl).toBeUndefined();
    const final = views.navigateView(created.viewSessionId, 'next');
    expect(final.detail.photoId).toBe(3);
    expect(views.navigateView(created.viewSessionId, 'previous').detail.photoId).toBe(2);
    views.navigateView(created.viewSessionId, 'next');
    expect(() => views.navigateView(created.viewSessionId, 'next')).toThrow(/final member/i);
  });

  it('keeps membership frozen after catalog changes and rejects unknown sessions', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1);
    insertPhoto(database, 2);
    const { queries, views } = createServices(database);
    const created = views.createViewSession(issue(queries, 'oldest-imported'), 1);
    insertPhoto(database, 3);
    database.prepare('UPDATE photos SET flagged = 1 WHERE photo_id = 2').run();

    expect(memberIds(database, created.viewSessionId)).toEqual([1, 2]);
    expect(views.navigateView(created.viewSessionId, 'next').detail.photoId).toBe(2);
    expect(() => views.navigateView('00000000-0000-4000-8000-999999999999', 'next'))
      .toThrow(/not found/i);
  });

  it('loses TEMP view sessions after catalog close and reopen', () => {
    const { database, databasePath } = createCatalog();
    insertPhoto(database, 1);
    const { queries, views } = createServices(database);
    const created = views.createViewSession(issue(queries), 1);
    expect(memberIds(database, created.viewSessionId)).toEqual([1]);

    database.close();
    const reopened = openProductionCatalog(databasePath).database;
    databases.push(reopened);
    createSessionTables(reopened);
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM temp.view_sessions').get())
      .toEqual({ count: 0n });
    const services = createServices(reopened);
    expect(() => services.views.navigateView(created.viewSessionId, 'next')).toThrow(/not found/i);
  });
});
