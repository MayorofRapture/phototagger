import { createHash, randomUUID } from 'crypto';
import type { CatalogDatabase } from './schema';
import { applyInitialMigration, readInitialMigrationSql } from './schema';

export interface InitialCatalogStateOptions {
  appVersion: string;
  now?: () => string;
  catalogUuid?: () => string;
  /** Migration callback runs inside this helper's IMMEDIATE transaction. */
  applyMigration?: (database: CatalogDatabase) => void;
}

/** Applies Migration 001 and creates the required durable seed state atomically. */
export function initializeNewCatalogState(
  database: CatalogDatabase,
  options: InitialCatalogStateOptions
): void {
  const now = options.now ?? (() => new Date().toISOString());
  const catalogUuid = options.catalogUuid ?? randomUUID;
  const applyMigration = options.applyMigration ?? applyInitialMigration;

  const initialize = database.transaction(() => {
    applyMigration(database);

    const appliedAt = now();
    const migrationSha256 = createHash('sha256')
      .update(readInitialMigrationSql(), 'utf8')
      .digest();

    database.prepare(`INSERT INTO app_state (
      singleton, catalog_uuid, catalog_revision, clean_shutdown, last_app_version,
      last_started_at, last_clean_shutdown_at, last_automatic_backup_local_date,
      last_backup_catalog_revision
    ) VALUES (1, ?, 0, 1, ?, NULL, NULL, NULL, 0)`).run(
      catalogUuid(),
      options.appVersion
    );

    database.prepare(`INSERT INTO schema_migrations
      (version, name, sha256, applied_at, app_version)
      VALUES (1, '001_initial.sql', ?, ?, ?)`).run(
      migrationSha256,
      appliedAt,
      options.appVersion
    );

    const insertSetting = database.prepare(
      'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)'
    );
    const settings: Array<[string, string]> = [
      ['conversion.jpegQuality', '92'],
      ['conversion.alphaBackground', '"#ffffff"'],
      ['library.defaultOrder', '"newest-imported"'],
      ['batch.warningThreshold', '500'],
      ['backup.secondaryDestination', 'null'],
    ];
    for (const [key, valueJson] of settings) {
      insertSetting.run(key, valueJson, appliedAt);
    }
  });

  initialize.immediate();
}
