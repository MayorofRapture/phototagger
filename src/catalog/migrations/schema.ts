import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const APPLICATION_ID = 0x50544147;
const INITIAL_MIGRATION_PATH = path.resolve(process.cwd(), 'migrations', '001_initial.sql');

export type CatalogDatabase = Database.Database;

/**
 * Configures a newly created catalog connection before its first migration.
 * Existing-catalog validation is intentionally outside M1A.
 */
export function configureNewCatalogConnection(database: CatalogDatabase): void {
  database.defaultSafeIntegers(true);
  database.pragma(`application_id = ${APPLICATION_ID}`);
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
  const migrationSql = fs.readFileSync(INITIAL_MIGRATION_PATH, 'utf8');
  database.exec(migrationSql);
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

/** Opens a previously unused file path for M1A schema validation only. */
export function openNewCatalogForSchemaValidation(databasePath: string): CatalogDatabase {
  if (fs.existsSync(databasePath)) {
    throw new Error('A fresh catalog path is required for schema validation');
  }
  const database = new Database(databasePath);
  configureNewCatalogConnection(database);
  return database;
}
