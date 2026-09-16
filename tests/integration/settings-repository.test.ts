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
  GeneralSettingsDefaults,
  SettingsRepository,
} from '../../src/catalog/repositories/settings-repository';

const temporaryDirectories: string[] = [];
const temporaryDatabases: CatalogDatabase[] = [];
const initialTimestamp = '2026-09-15T12:00:00.000Z';
const updateTimestamp = '2026-09-15T12:01:00.000Z';

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

function createSeededCatalog(): CatalogDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phototagger-settings-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'catalog.sqlite');
  const database = openNewCatalogForSchemaValidation(databasePath);
  temporaryDatabases.push(database);
  initializeNewCatalogState(database, {
    appVersion: '1.0.0-test',
    now: () => initialTimestamp,
    catalogUuid: () => '00000000-0000-4000-8000-000000000010',
  });
  return database;
}

describe('SettingsRepository', () => {
  it('reads valid stored general settings without warnings', () => {
    const database = createSeededCatalog();
    const repository = new SettingsRepository(database);

    expect(repository.readGeneralSettings()).toEqual({
      settings: GeneralSettingsDefaults,
      warnings: [],
    });
  });

  it('falls back to defaults and warns for missing known settings', () => {
    const database = createSeededCatalog();
    database.prepare(`DELETE FROM settings WHERE key IN (?, ?, ?, ?)`)
      .run(
        'conversion.jpegQuality',
        'conversion.alphaBackground',
        'library.defaultOrder',
        'batch.warningThreshold'
      );
    const repository = new SettingsRepository(database);

    expect(repository.readGeneralSettings()).toEqual({
      settings: GeneralSettingsDefaults,
      warnings: [
        { key: 'conversion.jpegQuality', reason: 'missing' },
        { key: 'conversion.alphaBackground', reason: 'missing' },
        { key: 'library.defaultOrder', reason: 'missing' },
        { key: 'batch.warningThreshold', reason: 'missing' },
      ],
    });
  });

  it('falls back to defaults and warns for invalid known values', () => {
    const database = createSeededCatalog();
    database.prepare(`UPDATE settings SET value_json = CASE key
      WHEN 'conversion.jpegQuality' THEN '0'
      WHEN 'conversion.alphaBackground' THEN '"not-rgb"'
      WHEN 'library.defaultOrder' THEN '"unsupported"'
      WHEN 'batch.warningThreshold' THEN '100001'
      ELSE value_json END
      WHERE key IN (?, ?, ?, ?)`)
      .run(
        'conversion.jpegQuality',
        'conversion.alphaBackground',
        'library.defaultOrder',
        'batch.warningThreshold'
      );
    const repository = new SettingsRepository(database);

    expect(repository.readGeneralSettings()).toEqual({
      settings: GeneralSettingsDefaults,
      warnings: [
        { key: 'conversion.jpegQuality', reason: 'invalid value' },
        { key: 'conversion.alphaBackground', reason: 'invalid value' },
        { key: 'library.defaultOrder', reason: 'invalid value' },
        { key: 'batch.warningThreshold', reason: 'invalid value' },
      ],
    });
  });

  it('does not overwrite invalid stored values while reading', () => {
    const database = createSeededCatalog();
    database.prepare(`UPDATE settings SET value_json = '100001'
      WHERE key = 'batch.warningThreshold'`).run();
    const repository = new SettingsRepository(database);

    repository.readGeneralSettings();

    expect(database.prepare(`SELECT value_json FROM settings
      WHERE key = 'batch.warningThreshold'`).get())
      .toEqual({ value_json: '100001' });
  });

  it('ignores unknown settings rows on read', () => {
    const database = createSeededCatalog();
    database.prepare(`INSERT INTO settings (key, value_json, updated_at)
      VALUES ('future.setting', '"ignored"', ?)`)
      .run(initialTimestamp);
    const repository = new SettingsRepository(database);

    expect(repository.readGeneralSettings()).toEqual({
      settings: GeneralSettingsDefaults,
      warnings: [],
    });
  });

  it('persists a valid single-setting update with one timestamp and revision', () => {
    const database = createSeededCatalog();
    const repository = new SettingsRepository(database, { now: () => updateTimestamp });

    const result = repository.updateGeneralSettings({ jpegQuality: 95 });

    expect(result).toEqual({
      settings: { ...GeneralSettingsDefaults, jpegQuality: 95 },
      catalogRevision: 1n,
    });
    expect(database.prepare(`SELECT value_json, updated_at FROM settings
      WHERE key = 'conversion.jpegQuality'`).get())
      .toEqual({ value_json: '95', updated_at: updateTimestamp });
    expect(database.prepare('SELECT catalog_revision FROM app_state').get())
      .toEqual({ catalog_revision: 1n });
  });

  it('commits a multi-setting update atomically and increments revision once', () => {
    const database = createSeededCatalog();
    const repository = new SettingsRepository(database, { now: () => updateTimestamp });
    const patch = {
      jpegQuality: 88,
      alphaBackground: '#102030',
      defaultOrder: 'oldest-imported' as const,
      warningThreshold: 750,
    };

    const result = repository.updateGeneralSettings(patch);

    expect(result).toEqual({
      settings: patch,
      catalogRevision: 1n,
    });
    expect(database.prepare(`SELECT key, value_json, updated_at FROM settings
      WHERE key IN (?, ?, ?, ?) ORDER BY key`).all(
      'conversion.jpegQuality',
      'conversion.alphaBackground',
      'library.defaultOrder',
      'batch.warningThreshold'
    )).toEqual([
      { key: 'batch.warningThreshold', value_json: '750', updated_at: updateTimestamp },
      { key: 'conversion.alphaBackground', value_json: '"#102030"', updated_at: updateTimestamp },
      { key: 'conversion.jpegQuality', value_json: '88', updated_at: updateTimestamp },
      { key: 'library.defaultOrder', value_json: '"oldest-imported"', updated_at: updateTimestamp },
    ]);
    expect(database.prepare('SELECT catalog_revision FROM app_state').get())
      .toEqual({ catalog_revision: 1n });
  });

  it.each([
    [{ jpegQuality: 0 }, 'quality'],
    [{ jpegQuality: 101 }, 'quality'],
    [{ jpegQuality: 92.5 }, 'quality integer'],
    [{ alphaBackground: '#12345' }, 'RGB form'],
    [{ alphaBackground: '123456' }, 'RGB prefix'],
    [{ defaultOrder: 'unsupported' }, 'Library order'],
    [{ warningThreshold: 0 }, 'threshold'],
    [{ warningThreshold: 100001 }, 'threshold'],
    [{ warningThreshold: 500.5 }, 'threshold integer'],
  ] as const)('rejects invalid %s update input before mutation (%s)', (patch, _description) => {
    const database = createSeededCatalog();
    const repository = new SettingsRepository(database);

    expect(() => repository.updateGeneralSettings(patch)).toThrow(/Invalid general settings patch/);
    expect(database.prepare('SELECT catalog_revision FROM app_state').get())
      .toEqual({ catalog_revision: 0n });
  });

  it('rejects unknown update fields and empty patches', () => {
    const database = createSeededCatalog();
    const repository = new SettingsRepository(database);

    expect(() => repository.updateGeneralSettings({ unknown: 1 })).toThrow(/Invalid general settings patch/);
    expect(() => repository.updateGeneralSettings({})).toThrow(/At least one general setting/);
    expect(database.prepare('SELECT catalog_revision FROM app_state').get())
      .toEqual({ catalog_revision: 0n });
  });

  it('does not mutate on a valid no-op patch', () => {
    const database = createSeededCatalog();
    const originalRows = database.prepare(`SELECT key, updated_at FROM settings
      WHERE key IN (?, ?, ?, ?) ORDER BY key`).all(
      'conversion.jpegQuality',
      'conversion.alphaBackground',
      'library.defaultOrder',
      'batch.warningThreshold'
    );
    const repository = new SettingsRepository(database, {
      now: () => {
        throw new Error('timestamp must not be requested for a no-op');
      },
    });

    const result = repository.updateGeneralSettings({
      jpegQuality: 92,
      alphaBackground: '#ffffff',
      defaultOrder: 'newest-imported',
      warningThreshold: 500,
    });

    expect(result.catalogRevision).toBe(0n);
    expect(result.settings).toEqual(GeneralSettingsDefaults);
    expect(database.prepare(`SELECT key, updated_at FROM settings
      WHERE key IN (?, ?, ?, ?) ORDER BY key`).all(
      'conversion.jpegQuality',
      'conversion.alphaBackground',
      'library.defaultOrder',
      'batch.warningThreshold'
    )).toEqual(originalRows);
    expect(database.prepare('SELECT catalog_revision FROM app_state').get())
      .toEqual({ catalog_revision: 0n });
  });

  it('repairs an invalid known value when explicitly saved and increments revision', () => {
    const database = createSeededCatalog();
    database.prepare(`UPDATE settings SET value_json = '0'
      WHERE key = 'conversion.jpegQuality'`).run();
    const repository = new SettingsRepository(database, { now: () => updateTimestamp });

    const result = repository.updateGeneralSettings({ jpegQuality: 92 });

    expect(result.catalogRevision).toBe(1n);
    expect(result.settings.jpegQuality).toBe(92);
    expect(database.prepare(`SELECT value_json, updated_at FROM settings
      WHERE key = 'conversion.jpegQuality'`).get())
      .toEqual({ value_json: '92', updated_at: updateTimestamp });
  });

  it('fails without the app_state singleton and does not create unrelated state', () => {
    const database = createSeededCatalog();
    database.prepare('DELETE FROM app_state WHERE singleton = 1').run();
    const repository = new SettingsRepository(database, { now: () => updateTimestamp });

    expect(() => repository.updateGeneralSettings({ jpegQuality: 95 }))
      .toThrow(/app_state singleton/);
    expect(database.prepare(`SELECT value_json FROM settings
      WHERE key = 'conversion.jpegQuality'`).get())
      .toEqual({ value_json: '92' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM app_state').get())
      .toEqual({ count: 0n });
  });

  it('leaves backup.secondaryDestination untouched by general-settings updates', () => {
    const database = createSeededCatalog();
    const before = database.prepare(`SELECT value_json, updated_at FROM settings
      WHERE key = 'backup.secondaryDestination'`).get();
    const repository = new SettingsRepository(database, { now: () => updateTimestamp });

    repository.updateGeneralSettings({ warningThreshold: 900 });

    expect(database.prepare(`SELECT value_json, updated_at FROM settings
      WHERE key = 'backup.secondaryDestination'`).get()).toEqual(before);
  });
});
