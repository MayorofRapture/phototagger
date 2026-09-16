import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogProcessHandler } from '../../src/catalog/catalog-process';
import { initializeNewCatalogState } from '../../src/catalog/migrations/initial-state';
import {
  applyInitialMigration,
  openNewCatalogForSchemaValidation,
  type CatalogDatabase,
} from '../../src/catalog/migrations/schema';

const temporaryDirectories: string[] = [];
const temporaryDatabases: CatalogDatabase[] = [];
const timestamp = '2026-09-14T12:00:00.000Z';
const appVersion = '1.0.0-test';

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

function createMigratedDatabase(): { database: CatalogDatabase; databasePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phototagger-catalog-state-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'catalog.sqlite');
  const database = openNewCatalogForSchemaValidation(databasePath);
  temporaryDatabases.push(database);
  applyInitialMigration(database);
  return { database, databasePath };
}

function createFreshDatabase(): { database: CatalogDatabase; databasePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phototagger-catalog-state-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'catalog.sqlite');
  const database = openNewCatalogForSchemaValidation(databasePath);
  temporaryDatabases.push(database);
  return { database, databasePath };
}

describe('new catalog initial state', () => {
  it('seeds the approved durable rows atomically with exact initial values', () => {
    const { database } = createFreshDatabase();
    const catalogUuid = '00000000-0000-4000-8000-000000000001';

    initializeNewCatalogState(database, {
      appVersion,
      now: () => timestamp,
      catalogUuid: () => catalogUuid,
    });

    const appState = database.prepare('SELECT * FROM app_state').get() as {
      singleton: bigint;
      catalog_uuid: string;
      catalog_revision: bigint;
      clean_shutdown: bigint;
      last_app_version: string;
      last_started_at: string | null;
      last_clean_shutdown_at: string | null;
      last_automatic_backup_local_date: string | null;
      last_backup_catalog_revision: bigint;
    };
    expect(appState).toEqual({
      singleton: 1n,
      catalog_uuid: catalogUuid,
      catalog_revision: 0n,
      clean_shutdown: 1n,
      last_app_version: appVersion,
      last_started_at: null,
      last_clean_shutdown_at: null,
      last_automatic_backup_local_date: null,
      last_backup_catalog_revision: 0n,
    });

    const migration = database.prepare(`SELECT version, name, sha256, applied_at, app_version
      FROM schema_migrations`).get() as {
      version: bigint;
      name: string;
      sha256: Buffer;
      applied_at: string;
      app_version: string;
    };
    const migrationSql = fs.readFileSync(
      path.resolve(process.cwd(), 'migrations', '001_initial.sql'),
      'utf8'
    );
    expect(migration.version).toBe(1n);
    expect(migration.name).toBe('001_initial.sql');
    expect(migration.sha256).toEqual(createHash('sha256').update(migrationSql, 'utf8').digest());
    expect(migration.applied_at).toBe(timestamp);
    expect(migration.app_version).toBe(appVersion);

    const settings = database.prepare(`SELECT key, value_json, updated_at
      FROM settings ORDER BY key`).all();
    expect(settings).toEqual([
      { key: 'backup.secondaryDestination', value_json: 'null', updated_at: timestamp },
      { key: 'batch.warningThreshold', value_json: '500', updated_at: timestamp },
      { key: 'conversion.alphaBackground', value_json: '"#ffffff"', updated_at: timestamp },
      { key: 'conversion.jpegQuality', value_json: '92', updated_at: timestamp },
      { key: 'library.defaultOrder', value_json: '"newest-imported"', updated_at: timestamp },
    ]);
  });

  it('opens a fresh production catalog only after durable initialization and TEMP tables succeed', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phototagger-catalog-state-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'catalog.sqlite');

    const handler = new CatalogProcessHandler({}, false);
    const response = handler.handleRawMessage({
      requestId: 'initial-state-open',
      type: 'openCatalog',
      payload: { databasePath, appVersion },
    });
    expect(response).toEqual({
      requestId: 'initial-state-open',
      success: true,
      result: {
        opened: true,
        created: true,
        userVersion: 1,
        temporaryTableNames: [
          'selection_members',
          'selection_sessions',
          'view_members',
          'view_sessions',
        ],
      },
    });
    handler.closeDatabase();

    const persisted = new Database(databasePath);
    expect(persisted.prepare('SELECT COUNT(*) AS count FROM app_state').get())
      .toEqual({ count: 1 });
    expect(persisted.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get())
      .toEqual({ count: 1 });
    expect(persisted.prepare('SELECT COUNT(*) AS count FROM settings').get())
      .toEqual({ count: 5 });
    persisted.close();
  });

  it('does not reseed an existing compatible catalog', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phototagger-catalog-state-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'catalog.sqlite');
    const firstHandler = new CatalogProcessHandler({}, false);
    const openPayload = { databasePath, appVersion };
    expect(firstHandler.handleRawMessage({
      requestId: 'initial-state-seed',
      type: 'openCatalog',
      payload: openPayload,
    }).success).toBe(true);
    firstHandler.closeDatabase();

    const database = new Database(databasePath);
    database.prepare(`UPDATE app_state
      SET catalog_revision = 17, last_app_version = '2.0.0-test'`).run();
    database.prepare(`UPDATE settings SET value_json = '91'
      WHERE key = 'conversion.jpegQuality'`).run();
    database.close();

    const secondHandler = new CatalogProcessHandler({}, false);
    const response = secondHandler.handleRawMessage({
      requestId: 'initial-state-reopen',
      type: 'openCatalog',
      payload: openPayload,
    });
    expect(response).toMatchObject({
      success: true,
      result: { created: false },
    });
    secondHandler.closeDatabase();

    const reopened = new Database(databasePath);
    expect(reopened.prepare('SELECT catalog_revision, last_app_version FROM app_state').get())
      .toEqual({ catalog_revision: 17, last_app_version: '2.0.0-test' });
    expect(reopened.prepare(`SELECT value_json FROM settings
      WHERE key = 'conversion.jpegQuality'`).get()).toEqual({ value_json: '91' });
    reopened.close();
  });

  it('fails safely when an existing schema-version-1 catalog lacks mandatory seed state', () => {
    const { database, databasePath } = createMigratedDatabase();
    database.close();

    const handler = new CatalogProcessHandler({}, false);
    const response = handler.handleRawMessage({
      requestId: 'initial-state-missing',
      type: 'openCatalog',
      payload: { databasePath, appVersion },
    });
    expect(response).toMatchObject({
      success: false,
      error: { code: 'EXECUTION_ERROR' },
    });
    if (!response.success) {
      expect(response.error.message).toContain('app_state singleton');
    }
    expect(fs.existsSync(databasePath)).toBe(true);
    const unchanged = new Database(databasePath);
    expect(Number(unchanged.pragma('user_version', { simple: true }))).toBe(1);
    expect(unchanged.prepare('SELECT COUNT(*) AS count FROM app_state').get())
      .toEqual({ count: 0 });
    unchanged.close();
    expect(() => fs.rmSync(databasePath)).not.toThrow();
  });

  it('rolls back durable seed rows when initialization fails', () => {
    const { database } = createFreshDatabase();

    expect(() => initializeNewCatalogState(database, {
      appVersion,
      now: () => {
        throw new Error('simulated durable initialization failure after migration');
      },
      catalogUuid: () => '00000000-0000-4000-8000-000000000002',
    })).toThrow(/after migration/);

    expect(database.prepare(`SELECT name FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all()).toEqual([]);
    expect(Number(database.pragma('user_version', { simple: true }))).toBe(0);
  });

  it('cleans up a failed newly-created catalog and allows a fresh retry', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phototagger-catalog-state-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'catalog.sqlite');
    const handler = new CatalogProcessHandler({
      initializeNewState: (database, options) => initializeNewCatalogState(database, {
        ...options,
        now: () => {
          throw new Error('simulated durable initialization failure');
        },
      }),
    }, false);

    const response = handler.handleRawMessage({
      requestId: 'initial-state-init-failure',
      type: 'openCatalog',
      payload: { databasePath, appVersion },
    });
    expect(response).toMatchObject({
      success: false,
      error: { code: 'EXECUTION_ERROR', message: 'simulated durable initialization failure' },
    });
    for (const artifactPath of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      `${databasePath}-journal`,
    ]) {
      expect(fs.existsSync(artifactPath)).toBe(false);
    }

    const retryHandler = new CatalogProcessHandler({}, false);
    const retryResponse = retryHandler.handleRawMessage({
      requestId: 'initial-state-retry',
      type: 'openCatalog',
      payload: { databasePath, appVersion },
    });
    expect(retryResponse).toMatchObject({
      success: true,
      result: { created: true, userVersion: 1 },
    });
    retryHandler.closeDatabase();

    const persisted = new Database(databasePath);
    expect(persisted.prepare('SELECT COUNT(*) AS count FROM app_state').get())
      .toEqual({ count: 1 });
    expect(persisted.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get())
      .toEqual({ count: 1 });
    expect(persisted.prepare('SELECT COUNT(*) AS count FROM settings').get())
      .toEqual({ count: 5 });
    persisted.close();
  });
});
