import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyInitialMigration,
  createSessionTables,
  openNewCatalogForSchemaValidation,
  type CatalogDatabase,
} from '../../src/catalog/migrations/schema';

const temporaryDirectories: string[] = [];
const temporaryDatabases: CatalogDatabase[] = [];
const timestamp = '2026-09-14T12:00:00.000Z';
const hash = Buffer.alloc(32, 7);

const durableObjects = {
  table: [
    'app_state', 'audit_events', 'backup_records', 'content_revisions', 'external_change_events',
    'id_reservations', 'import_batches', 'import_jobs', 'maintenance_jobs', 'metadata_jobs',
    'operation_journal', 'palette_entries', 'photo_tags', 'photos', 'schema_migrations', 'settings',
    'tag_aliases', 'tag_closure', 'tag_paths', 'tags', 'trash_batch_items', 'trash_batches',
  ],
  index: [
    'ix_audit_events_time', 'ix_backup_records_retention', 'ix_external_events_open',
    'ix_import_jobs_work', 'ix_metadata_jobs_work', 'ix_operation_journal_open',
    'ix_photo_tags_tag_photo', 'ix_photos_active_flagged_order', 'ix_photos_active_order',
    'ix_photos_current_hash', 'ix_photos_image_hash', 'ix_photos_integrity', 'ix_photos_source_hash',
    'ix_tag_closure_descendant', 'ix_tag_paths_leaf', 'ix_trash_items_state',
    'ux_external_events_one_open', 'ux_tags_sibling_normalized',
  ],
  trigger: [
    'trg_legacy_tag_cannot_gain_parent', 'trg_no_delete_id_reservation', 'trg_no_delete_photo',
    'trg_photo_identity_immutable', 'trg_photo_no_unpurge', 'trg_photo_source_format_immutable',
    'trg_photo_tag_not_purged', 'trg_tag_cannot_become_legacy_with_children',
    'trg_tag_cannot_use_legacy_parent_insert', 'trg_tag_cannot_use_legacy_parent_update',
    'trg_tag_insert_depth', 'trg_tag_update_depth', 'trg_tag_update_no_cycle',
  ],
} as const;

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

function createDatabase(): { database: CatalogDatabase; databasePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phototagger-catalog-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'catalog.sqlite');
  const database = openNewCatalogForSchemaValidation(databasePath);
  temporaryDatabases.push(database);
  applyInitialMigration(database);
  return { database, databasePath };
}

function insertActivePhoto(database: CatalogDatabase, photoId = 1): void {
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
  ) VALUES (?, 'original.jpg', 'jpeg', 'active', 'clean', 0, 1, 1, 1, ?, ?, ?, 1, 0, 0,
    'not_attempted', 'ready', 1, ?, ?)`)
    .run(photoId, hash, hash, hash, timestamp, timestamp);
}

function insertTag(database: CatalogDatabase, parentTagId: number | null, key: string): number {
  const result = database.prepare(`INSERT INTO tags
    (parent_tag_id, display_name, normalized_key, legacy_flat_only, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)`)
    .run(parentTagId, key, key, timestamp, timestamp);
  const tagId = Number(result.lastInsertRowid);
  database.prepare(`INSERT INTO tag_closure (ancestor_tag_id, descendant_tag_id, depth)
    VALUES (?, ?, 0)`).run(tagId, tagId);
  if (parentTagId !== null) {
    const ancestors = database.prepare(`SELECT ancestor_tag_id, depth FROM tag_closure
      WHERE descendant_tag_id = ?`).all(parentTagId) as Array<{ ancestor_tag_id: bigint; depth: bigint }>;
    const insertClosure = database.prepare(`INSERT INTO tag_closure
      (ancestor_tag_id, descendant_tag_id, depth) VALUES (?, ?, ?)`);
    for (const ancestor of ancestors) {
      insertClosure.run(ancestor.ancestor_tag_id, tagId, Number(ancestor.depth) + 1);
    }
  }
  return tagId;
}

describe('Migration 001 catalog schema', () => {
  it('configures a fresh file-backed catalog connection with the required pragmas', () => {
    const { database } = createDatabase();
    const numericPragma = (pragma: string): number => Number(database.pragma(pragma, { simple: true }));

    expect(numericPragma('application_id')).toBe(0x50544147);
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(numericPragma('synchronous')).toBe(2);
    expect(numericPragma('foreign_keys')).toBe(1);
    expect(numericPragma('busy_timeout')).toBe(5000);
    expect(numericPragma('temp_store')).toBe(2);
    expect(numericPragma('wal_autocheckpoint')).toBe(1000);
    expect(numericPragma('journal_size_limit')).toBe(67108864);
    expect(numericPragma('trusted_schema')).toBe(0);
    expect(numericPragma('recursive_triggers')).toBe(1);
    database.close();
  });

  it('migrates a fresh isolated SQLite database with the approved durable object inventory', () => {
    const { database } = createDatabase();
    const objects = database.prepare(`SELECT type, name FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger')
      ORDER BY type, name`).all() as Array<{ type: keyof typeof durableObjects; name: string }>;

    expect(Number(database.pragma('user_version', { simple: true }))).toBe(1);
    for (const type of ['table', 'index', 'trigger'] as const) {
      const names = objects.filter((object) => object.type === type).map((object) => object.name);
      expect(names).toHaveLength(durableObjects[type].length);
      expect(names).toEqual(durableObjects[type]);
    }
    database.close();
  });

  it('keeps session tables connection-scoped and out of the durable catalog', () => {
    const { database, databasePath } = createDatabase();
    createSessionTables(database);
    const sessionNames = database.prepare(`SELECT name FROM sqlite_temp_master
      WHERE type = 'table' ORDER BY name`).pluck().all();
    const durableSessionTables = database.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('selection_sessions', 'selection_members', 'view_sessions', 'view_members')`).all();
    expect(sessionNames).toEqual(['selection_members', 'selection_sessions', 'view_members', 'view_sessions']);
    expect(durableSessionTables).toEqual([]);
    database.close();

    const reopened = new Database(databasePath);
    expect(reopened.prepare(`SELECT name FROM sqlite_temp_master WHERE type = 'table'`).all()).toEqual([]);
    reopened.close();
  });

  it('enforces representative immutable identity, tombstone, and hierarchy protections', () => {
    const { database } = createDatabase();
    insertActivePhoto(database);
    expect(() => database.prepare('DELETE FROM photos WHERE photo_id = 1').run()).toThrow(/tombstones/);
    expect(() => database.prepare("UPDATE photos SET original_filename = 'other.jpg' WHERE photo_id = 1").run())
      .toThrow(/immutable photo identity/);

    database.prepare(`INSERT INTO backup_records
      (backup_id, kind, state, catalog_revision, schema_version, relative_path, manifest_relative_path, created_at, updated_at)
      VALUES ('backup-1', 'safety', 'verified', 0, 1, 'backup.sqlite', 'manifest.json', ?, ?)`)
      .run(timestamp, timestamp);
    database.prepare(`INSERT INTO trash_batches
      (trash_batch_id, action, state, requested_count, known_size_bytes, safety_backup_id, manifest_relative_path, user_authorized_at, created_at, updated_at)
      VALUES ('purge-1', 'purge', 'completed', 1, 0, 'backup-1', 'purge.json', ?, ?, ?)`)
      .run(timestamp, timestamp, timestamp);
    database.prepare(`UPDATE photos SET lifecycle_state = 'purged', source_format = NULL, integrity_state = NULL,
      flagged = NULL, width = NULL, height = NULL, display_orientation = NULL, current_file_sha256 = NULL,
      observed_size_bytes = NULL, observed_mtime_ns = NULL, content_revision = NULL,
      desired_metadata_revision = NULL, synced_metadata_revision = NULL, metadata_warning_code = NULL,
      embedded_thumbnail_status = NULL, thumbnail_state = NULL, thumbnail_revision = NULL,
      last_verified_at = NULL, purge_batch_id = 'purge-1', trashed_at = ?, purged_at = ? WHERE photo_id = 1`)
      .run(timestamp, timestamp);
    expect(() => database.prepare("UPDATE photos SET lifecycle_state = 'active' WHERE photo_id = 1").run())
      .toThrow(/purged photo cannot return/);

    const legacy = database.prepare(`INSERT INTO tags
      (display_name, normalized_key, legacy_flat_only, created_at, updated_at)
      VALUES ('legacy', 'legacy', 1, ?, ?)`)
      .run(timestamp, timestamp);
    expect(() => database.prepare(`INSERT INTO tags
      (parent_tag_id, display_name, normalized_key, created_at, updated_at)
      VALUES (?, 'child', 'child', ?, ?)`).run(legacy.lastInsertRowid, timestamp, timestamp))
      .toThrow(/legacy flat-only tag cannot be a parent/);

    let parent: number | null = null;
    const chain: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      parent = insertTag(database, parent, `tag-${index}`);
      chain.push(parent);
    }
    expect(() => insertTag(database, parent, 'too-deep')).toThrow(/exceeds 12 levels/);
    const cycleRoot = insertTag(database, null, 'cycle-root');
    const cycleChild = insertTag(database, cycleRoot, 'cycle-child');
    expect(() => database.prepare('UPDATE tags SET parent_tag_id = ? WHERE tag_id = ?')
      .run(cycleChild, cycleRoot)).toThrow(/tag hierarchy cycle/);
    database.close();
  });

  it('has no foreign-key or integrity violations for a representative valid dataset', () => {
    const { database } = createDatabase();
    insertActivePhoto(database);
    const tagId = insertTag(database, null, 'root');
    database.prepare('INSERT INTO photo_tags (photo_id, tag_id, assigned_at) VALUES (1, ?, ?)')
      .run(tagId, timestamp);
    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
    database.close();
  });
});
