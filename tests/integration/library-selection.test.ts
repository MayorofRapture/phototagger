import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeNewCatalogState } from '../../src/catalog/migrations/initial-state';
import {
  createSessionTables,
  openNewCatalogForSchemaValidation,
  openProductionCatalog,
  type CatalogDatabase,
} from '../../src/catalog/migrations/schema';
import {
  IssuedLibraryQueryRegistry,
  type LibraryQuery,
} from '../../src/catalog/library/library-query-model';
import { LibraryQueryService } from '../../src/catalog/queries/library-query';
import {
  LibrarySelectionService,
  type LibrarySelectionServiceOptions,
} from '../../src/catalog/sessions/library-selection-service';
import { TagRepository } from '../../src/catalog/repositories/tag-repository';

const temporaryDirectories: string[] = [];
const temporaryDatabases: CatalogDatabase[] = [];
const timestamp = '2026-09-17T13:00:00.000Z';
const hash = Buffer.alloc(32, 11);
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phototagger-selection-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'catalog.sqlite');
  const database = openNewCatalogForSchemaValidation(databasePath);
  temporaryDatabases.push(database);
  initializeNewCatalogState(database, {
    appVersion: '1.0.0-test',
    now: () => timestamp,
    catalogUuid: () => '00000000-0000-4000-8000-000000000050',
  });
  createSessionTables(database);
  return { database, databasePath };
}

function insertPhoto(
  database: CatalogDatabase,
  photoId: number,
  options: { flagged?: boolean; originalFilename?: string } = {}
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
  ) VALUES (?, ?, 'jpeg', 'active', 'clean', ?, 1200, 800, 1, ?, ?, ?, 1, 0, 0,
    'not_attempted', 'ready', 1, ?, ?)`)
    .run(
      photoId,
      options.originalFilename ?? `photo-${photoId}.jpg`,
      options.flagged ? 1 : 0,
      hash,
      hash,
      hash,
      timestamp,
      timestamp
    );
}

function assignTag(database: CatalogDatabase, photoId: number, tagId: number): void {
  database.prepare(`INSERT INTO photo_tags (photo_id, tag_id, assigned_at)
    VALUES (?, ?, ?)`).run(photoId, tagId, timestamp);
}

function revision(database: CatalogDatabase): bigint {
  return (database.prepare(
    'SELECT catalog_revision FROM app_state WHERE singleton = 1'
  ).get() as { catalog_revision: bigint }).catalog_revision;
}

function selectedIds(database: CatalogDatabase, selectionId: string): number[] {
  const rows = database.prepare(`SELECT photo_id
    FROM temp.selection_members
    WHERE selection_id = ? AND selected = 1
    ORDER BY photo_id`).all(selectionId) as Array<{ photo_id: bigint }>;
  return rows.map((row) => Number(row.photo_id));
}

function createDeterministicOptions(): LibrarySelectionServiceOptions {
  let nextId = 1;
  return {
    now: () => timestamp,
    selectionId: () =>
      `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
  };
}

function createServices(database: CatalogDatabase): {
  registry: IssuedLibraryQueryRegistry;
  queries: LibraryQueryService;
  selections: LibrarySelectionService;
} {
  const registry = new IssuedLibraryQueryRegistry();
  return {
    registry,
    queries: new LibraryQueryService(database, registry),
    selections: new LibrarySelectionService(database, registry, createDeterministicOptions()),
  };
}

function issueQuery(
  queries: LibraryQueryService,
  query: LibraryQuery = defaultQuery,
  pageSize = 200
): string {
  return queries.queryLibrary(query, { pageSize }).queryFingerprint;
}

describe('LibrarySelectionService', () => {
  it('creates none and one seeds from an issued query', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1);
    insertPhoto(database, 2);
    const { queries, selections } = createServices(database);
    const fingerprint = issueQuery(queries);

    const none = selections.createSelection(fingerprint, { type: 'none' });
    expect(none).toMatchObject({ count: 0, catalogRevisionAtCapture: 0 });
    expect(selectedIds(database, none.selectionId)).toEqual([]);
    const one = selections.createSelection(fingerprint, { type: 'one', photoId: 1 });
    expect(one.count).toBe(1);
    expect(selectedIds(database, one.selectionId)).toEqual([1]);
  });

  it('rejects a one seed outside the issued query without leaving a session', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1, { flagged: true });
    insertPhoto(database, 2, { flagged: false });
    const { queries, selections } = createServices(database);
    const fingerprint = issueQuery(queries, { ...defaultQuery, flaggedOnly: true });

    expect(() => selections.createSelection(fingerprint, { type: 'one', photoId: 2 }))
      .toThrow(/does not belong/i);
    expect(database.prepare('SELECT COUNT(*) AS count FROM temp.selection_sessions').get())
      .toEqual({ count: 0n });
  });

  it('Select All captures the complete query rather than the loaded page', () => {
    const { database } = createCatalog();
    for (let photoId = 1; photoId <= 5; photoId += 1) {
      insertPhoto(database, photoId);
    }
    const { queries, selections } = createServices(database);
    const fingerprint = issueQuery(queries, defaultQuery, 1);

    const selection = selections.createSelection(fingerprint, { type: 'all' });
    expect(selection.count).toBe(5);
    expect(selectedIds(database, selection.selectionId)).toEqual([1, 2, 3, 4, 5]);
  });

  it('Select All respects tag and flagged filters', () => {
    const { database } = createCatalog();
    const cats = new TagRepository(database, { now: () => timestamp })
      .resolveOrCreatePath('Pets/Cats').path[1];
    insertPhoto(database, 1, { flagged: true });
    insertPhoto(database, 2, { flagged: false });
    insertPhoto(database, 3, { flagged: true });
    assignTag(database, 1, cats.tagId);
    assignTag(database, 2, cats.tagId);
    const query = { ...defaultQuery, tagIds: [cats.tagId], flaggedOnly: true };
    const { queries, selections } = createServices(database);
    const fingerprint = issueQuery(queries, query);

    const selection = selections.createSelection(fingerprint, { type: 'all' });
    expect(selectedIds(database, selection.selectionId)).toEqual([1]);
  });

  it('keeps Select All membership frozen across later catalog changes', () => {
    const { database } = createCatalog();
    const cats = new TagRepository(database, { now: () => timestamp })
      .resolveOrCreatePath('Pets/Cats').path[1];
    insertPhoto(database, 1);
    insertPhoto(database, 2);
    assignTag(database, 1, cats.tagId);
    assignTag(database, 2, cats.tagId);
    const query = { ...defaultQuery, tagIds: [cats.tagId] };
    const { queries, selections } = createServices(database);
    const fingerprint = issueQuery(queries, query);
    const selection = selections.createSelection(fingerprint, { type: 'all' });

    insertPhoto(database, 3);
    assignTag(database, 3, cats.tagId);
    database.prepare('DELETE FROM photo_tags WHERE photo_id = 1 AND tag_id = ?').run(cats.tagId);
    expect(selections.getSelection(selection.selectionId).count).toBe(2);
    expect(selectedIds(database, selection.selectionId)).toEqual([1, 2]);
  });

  it('supports deduplicated exact selects and unselects', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1);
    insertPhoto(database, 2);
    const { queries, selections } = createServices(database);
    const fingerprint = issueQuery(queries);
    const selection = selections.createSelection(fingerprint, { type: 'none' });

    expect(selections.updateSelection(selection.selectionId, [1, 1], true).count).toBe(1);
    expect(selections.updateSelection(selection.selectionId, [2, 2], true).count).toBe(2);
    expect(selections.updateSelection(selection.selectionId, [1, 1], false).count).toBe(1);
    expect(selectedIds(database, selection.selectionId)).toEqual([2]);
  });

  it('allows reselecting captured members even after they cease matching', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1, { flagged: true });
    const query = { ...defaultQuery, flaggedOnly: true };
    const { queries, selections } = createServices(database);
    const fingerprint = issueQuery(queries, query);
    const selection = selections.createSelection(fingerprint, { type: 'all' });

    database.prepare('UPDATE photos SET flagged = 0 WHERE photo_id = 1').run();
    expect(selections.getSelection(selection.selectionId).count).toBe(1);
    expect(selections.updateSelection(selection.selectionId, [1], false).count).toBe(0);
    expect(selections.updateSelection(selection.selectionId, [1], true).count).toBe(1);
  });

  it('allows explicit selection of a newly matching row but rejects arbitrary injection atomically', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1, { flagged: true });
    insertPhoto(database, 2, { flagged: false });
    const query = { ...defaultQuery, flaggedOnly: true };
    const { queries, selections } = createServices(database);
    const fingerprint = issueQuery(queries, query);
    const selection = selections.createSelection(fingerprint, { type: 'none' });

    insertPhoto(database, 3, { flagged: true });
    expect(selections.updateSelection(selection.selectionId, [3], true).count).toBe(1);
    expect(() => selections.updateSelection(selection.selectionId, [1, 2], true))
      .toThrow(/does not belong/i);
    expect(selectedIds(database, selection.selectionId)).toEqual([3]);
  });

  it('clears sessions and rejects unknown or unissued identities', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1);
    const { queries, selections } = createServices(database);
    const fingerprint = issueQuery(queries);
    const selection = selections.createSelection(fingerprint, { type: 'all' });

    selections.clearSelection(selection.selectionId);
    expect(() => selections.getSelection(selection.selectionId)).toThrow(/not found/i);
    expect(database.prepare('SELECT COUNT(*) AS count FROM temp.selection_members').get())
      .toEqual({ count: 0n });
    expect(() => selections.clearSelection('00000000-0000-4000-8000-999999999999'))
      .toThrow(/not found/i);
    expect(() => selections.createSelection('0'.repeat(64), { type: 'none' }))
      .toThrow(/not issued/i);
  });

  it('captures but never increments durable catalog revision', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1);
    database.prepare('UPDATE app_state SET catalog_revision = 42 WHERE singleton = 1').run();
    const { queries, selections } = createServices(database);
    const fingerprint = issueQuery(queries);
    const before = revision(database);

    const selection = selections.createSelection(fingerprint, { type: 'none' });
    expect(selection.catalogRevisionAtCapture).toBe(42);
    expect(revision(database)).toBe(before);
    selections.updateSelection(selection.selectionId, [1], true);
    expect(revision(database)).toBe(before);
    selections.clearSelection(selection.selectionId);
    expect(revision(database)).toBe(before);
  });

  it('rolls back failed Select All and one-seed creation without orphan sessions', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1);
    insertPhoto(database, 2);
    const { queries, selections } = createServices(database);
    const fingerprint = issueQuery(queries);
    database.exec(`CREATE TEMP TRIGGER fail_member_insert
      BEFORE INSERT ON selection_members
      WHEN NEW.photo_id = 2
      BEGIN SELECT RAISE(ABORT, 'forced selection failure'); END;`);

    expect(() => selections.createSelection(fingerprint, { type: 'all' }))
      .toThrow(/forced selection failure/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM temp.selection_sessions').get())
      .toEqual({ count: 0n });
    database.exec('DROP TRIGGER temp.fail_member_insert');
    database.exec(`CREATE TEMP TRIGGER fail_one_insert
      BEFORE INSERT ON selection_members
      WHEN NEW.photo_id = 1
      BEGIN SELECT RAISE(ABORT, 'forced one failure'); END;`);
    expect(() => selections.createSelection(fingerprint, { type: 'one', photoId: 1 }))
      .toThrow(/forced one failure/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM temp.selection_sessions').get())
      .toEqual({ count: 0n });
  });

  it('rolls back failed exact updates and rejects malformed IDs before mutation', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1);
    insertPhoto(database, 2);
    const { queries, selections } = createServices(database);
    const selection = selections.createSelection(issueQuery(queries), { type: 'none' });
    database.exec(`CREATE TEMP TRIGGER fail_update_insert
      BEFORE INSERT ON selection_members
      WHEN NEW.photo_id = 2
      BEGIN SELECT RAISE(ABORT, 'forced update failure'); END;`);

    expect(() => selections.updateSelection(selection.selectionId, [1, 2], true))
      .toThrow(/forced update failure/);
    expect(selectedIds(database, selection.selectionId)).toEqual([]);
    expect(() => selections.updateSelection(selection.selectionId, [1, 0], true)).toThrow();
    expect(() => selections.updateSelection(selection.selectionId, [1], 1)).toThrow();
    expect(selectedIds(database, selection.selectionId)).toEqual([]);
  });

  it('fails capture without app_state instead of creating bootstrap state', () => {
    const { database } = createCatalog();
    insertPhoto(database, 1);
    const { queries, selections } = createServices(database);
    const fingerprint = issueQuery(queries);
    database.prepare('DELETE FROM app_state').run();

    expect(() => selections.createSelection(fingerprint, { type: 'all' }))
      .toThrow(/app_state singleton/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM temp.selection_sessions').get())
      .toEqual({ count: 0n });
    expect(database.prepare('SELECT COUNT(*) AS count FROM app_state').get())
      .toEqual({ count: 0n });
  });

  it('loses TEMP selection membership when the catalog connection ends', () => {
    const { database, databasePath } = createCatalog();
    insertPhoto(database, 1);
    const { queries, selections } = createServices(database);
    const selection = selections.createSelection(issueQuery(queries), { type: 'all' });
    expect(selectedIds(database, selection.selectionId)).toEqual([1]);

    database.close();
    const reopened = openProductionCatalog(databasePath).database;
    temporaryDatabases.push(reopened);
    createSessionTables(reopened);
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM temp.selection_sessions').get())
      .toEqual({ count: 0n });
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM temp.selection_members').get())
      .toEqual({ count: 0n });
  });
});
