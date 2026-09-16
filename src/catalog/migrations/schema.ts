import Database from 'better-sqlite3/win32-x64';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const APPLICATION_ID = 0x50544147;
export const CURRENT_SCHEMA_VERSION = 1;

export function resolveInitialMigrationPath(): string {
  const candidates = [
    path.resolve(process.cwd(), 'migrations', '001_initial.sql'),
    path.resolve(__dirname, '..', '..', '..', 'migrations', '001_initial.sql'),
    ...(typeof process.resourcesPath === 'string'
      ? [path.join(process.resourcesPath, 'migrations', '001_initial.sql')]
      : []),
  ];
  const migrationPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!migrationPath) {
    throw new Error('Migration 001 could not be located');
  }
  return migrationPath;
}

export function readInitialMigrationSql(): string {
  return fs.readFileSync(resolveInitialMigrationPath(), 'utf8');
}

export type CatalogDatabase = Database.Database;

/**
 * Configures a newly created catalog connection before its first migration.
 * Existing-catalog validation is intentionally outside M1A.
 */
export function configureNewCatalogConnection(database: CatalogDatabase): void {
  database.defaultSafeIntegers(true);
  database.pragma(`application_id = ${APPLICATION_ID}`);
  configureCatalogConnection(database);
}

function configureCatalogConnection(database: CatalogDatabase): void {
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('temp_store = MEMORY');
  database.pragma('wal_autocheckpoint = 1000');
  database.pragma('journal_size_limit = 67108864');
  database.pragma('trusted_schema = OFF');
  database.pragma('recursive_triggers = ON');
}

export function applyInitialMigration(database: CatalogDatabase): void {
  database.exec(readInitialMigrationSql());
}

export function createSessionTables(database: CatalogDatabase): void {
  database.exec(`
    CREATE TEMP TABLE selection_sessions (
      selection_id       TEXT PRIMARY KEY,
      query_fingerprint  TEXT NOT NULL,
      catalog_revision   INTEGER NOT NULL,
      created_at         TEXT NOT NULL
    ) STRICT;

    CREATE TEMP TABLE selection_members (
      selection_id  TEXT NOT NULL REFERENCES selection_sessions(selection_id) ON DELETE CASCADE,
      photo_id      INTEGER NOT NULL,
      selected      INTEGER NOT NULL CHECK (selected IN (0, 1)),
      PRIMARY KEY (selection_id, photo_id)
    ) STRICT, WITHOUT ROWID;

    CREATE TEMP TABLE view_sessions (
      view_session_id    TEXT PRIMARY KEY,
      query_fingerprint TEXT NOT NULL,
      catalog_revision  INTEGER NOT NULL,
      created_at        TEXT NOT NULL
    ) STRICT;

    CREATE TEMP TABLE view_members (
      view_session_id  TEXT NOT NULL REFERENCES view_sessions(view_session_id) ON DELETE CASCADE,
      position         INTEGER NOT NULL CHECK (position >= 0),
      photo_id         INTEGER NOT NULL,
      PRIMARY KEY (view_session_id, position),
      UNIQUE (view_session_id, photo_id)
    ) STRICT, WITHOUT ROWID;
  `);
}

/** Opens a previously unused file path with fresh-catalog connection configuration. */
export function openNewCatalogForSchemaValidation(databasePath: string): CatalogDatabase {
  if (catalogArtifactPaths(databasePath).some((artifactPath) => fs.existsSync(artifactPath))) {
    throw new Error('A fresh catalog path is required for schema validation');
  }
  const database = new Database(databasePath);
  try {
    configureNewCatalogConnection(database);
    return database;
  } catch (error) {
    if (database.open) {
      database.close();
    }
    cleanupNewCatalogArtifacts(databasePath);
    throw error;
  }
}

/** Removes artifacts for a path that was confirmed fresh before opening. */
export function cleanupNewCatalogArtifacts(databasePath: string): void {
  for (const artifactPath of catalogArtifactPaths(databasePath)) {
    try {
      fs.rmSync(artifactPath, { force: true });
    } catch {
      // Cleanup is best effort; the initialization failure remains authoritative.
    }
  }
}

function catalogArtifactPaths(databasePath: string): string[] {
  return [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ];
}

export interface ProductionCatalogConnection {
  database: CatalogDatabase;
  created: boolean;
}

/** Opens either a fresh catalog or an existing catalog at the one supported schema version. */
export function openProductionCatalog(databasePath: string): ProductionCatalogConnection {
  if (!fs.existsSync(databasePath)) {
    return {
      database: openNewCatalogForSchemaValidation(databasePath),
      created: true,
    };
  }

  const database = new Database(databasePath);
  database.defaultSafeIntegers(true);
  try {
    const applicationId = Number(database.pragma('application_id', { simple: true }));
    if (applicationId !== APPLICATION_ID) {
      throw new Error('Catalog application_id is not PTAG');
    }

    const userVersion = Number(database.pragma('user_version', { simple: true }));
    if (userVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        userVersion > CURRENT_SCHEMA_VERSION
          ? `Catalog schema version ${userVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`
          : `Catalog schema version ${userVersion} is not supported by this application`
      );
    }

    configureCatalogConnection(database);
    if (database.pragma('quick_check', { simple: true }) !== 'ok') {
      throw new Error('Catalog quick_check failed');
    }
    if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new Error('Catalog foreign_key_check failed');
    }
    validateExistingCatalogState(database);
    return { database, created: false };
  } catch (error) {
    if (database.open) {
      database.close();
    }
    throw error;
  }
}

function validateExistingCatalogState(database: CatalogDatabase): void {
  const appState = database
    .prepare('SELECT singleton FROM app_state WHERE singleton = 1')
    .get();
  if (!appState) {
    throw new Error('Catalog is missing the required app_state singleton');
  }

  const migration = database
    .prepare("SELECT name, sha256 FROM schema_migrations WHERE version = 1")
    .get() as { name: string; sha256: Buffer } | undefined;
  const expectedMigrationSha256 = createHash('sha256')
    .update(readInitialMigrationSql(), 'utf8')
    .digest();
  if (
    !migration ||
    migration.name !== '001_initial.sql' ||
    !Buffer.isBuffer(migration.sha256) ||
    !migration.sha256.equals(expectedMigrationSha256)
  ) {
    throw new Error('Catalog is missing the required Migration 001 history row');
  }

  const requiredSettings = [
    'conversion.jpegQuality',
    'conversion.alphaBackground',
    'library.defaultOrder',
    'batch.warningThreshold',
    'backup.secondaryDestination',
  ];
  const settingExists = database.prepare('SELECT 1 FROM settings WHERE key = ?');
  for (const key of requiredSettings) {
    if (!settingExists.get(key)) {
      throw new Error(`Catalog is missing required initial setting ${key}`);
    }
  }
}
