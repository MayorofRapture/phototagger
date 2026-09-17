import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeNewCatalogState } from '../../src/catalog/migrations/initial-state';
import {
  openNewCatalogForSchemaValidation,
  type CatalogDatabase,
} from '../../src/catalog/migrations/schema';
import { TagRepository } from '../../src/catalog/repositories/tag-repository';
import { TagSuggestionsQuery } from '../../src/catalog/queries/tag-suggestions';

const temporaryDirectories: string[] = [];
const temporaryDatabases: CatalogDatabase[] = [];
const initialTimestamp = '2026-09-16T12:00:00.000Z';
const updateTimestamp = '2026-09-16T12:01:00.000Z';

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

function createCatalog(): CatalogDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phototagger-suggestions-'));
  temporaryDirectories.push(directory);
  const database = openNewCatalogForSchemaValidation(path.join(directory, 'catalog.sqlite'));
  temporaryDatabases.push(database);
  initializeNewCatalogState(database, {
    appVersion: '1.0.0-test',
    now: () => initialTimestamp,
    catalogUuid: () => '00000000-0000-4000-8000-000000000030',
  });
  return database;
}

function createRepository(database: CatalogDatabase): TagRepository {
  return new TagRepository(database, { now: () => updateTimestamp });
}

function readRevision(database: CatalogDatabase): bigint {
  return (database.prepare(
    'SELECT catalog_revision FROM app_state WHERE singleton = 1'
  ).get() as { catalog_revision: bigint }).catalog_revision;
}

function pinTag(database: CatalogDatabase, tagId: number, position: number): void {
  database.prepare(`INSERT INTO palette_entries (tag_id, position, pinned_at)
    VALUES (?, ?, ?)`).run(tagId, position, updateTimestamp);
}

describe('TagSuggestionsQuery', () => {
  it('returns no rows for an empty normalized query and normalizes case/Unicode whitespace', () => {
    const database = createCatalog();
    const repository = createRepository(database);
    repository.resolveOrCreatePath('Café');
    const query = new TagSuggestionsQuery(database);

    expect(query.findTagSuggestions('')).toEqual([]);
    expect(query.findTagSuggestions('\u0085 cAfÉ \u0085').map((tag) => tag.fullPath)).toEqual(['Café']);
  });

  it('matches NFC-equivalent queries to the same tag', () => {
    const database = createCatalog();
    const repository = createRepository(database);
    const created = repository.resolveOrCreatePath('Café').path[0];
    const suggestions = new TagSuggestionsQuery(database).findTagSuggestions('Cafe\u0301');

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].tagId).toBe(created.tagId);
    expect(suggestions[0].fullPath).toBe('Café');
  });

  it('ranks exact leaf matches before leaf prefixes and full-path-only prefixes', () => {
    const database = createCatalog();
    const repository = createRepository(database);
    repository.resolveOrCreatePath('Cat');
    repository.resolveOrCreatePath('Cats');
    repository.resolveOrCreatePath('CatGroup/Animals');

    const suggestions = new TagSuggestionsQuery(database).findTagSuggestions('cat');
    expect(suggestions.map((tag) => tag.fullPath)).toEqual([
      'Cat',
      'CatGroup',
      'Cats',
      'CatGroup/Animals',
    ]);
  });

  it('matches full hierarchy path prefixes', () => {
    const database = createCatalog();
    createRepository(database).resolveOrCreatePath('Pets/Cats');

    expect(new TagSuggestionsQuery(database).findTagSuggestions('\u0085pets/c\u0085')).toEqual([
      expect.objectContaining({
        fullPath: 'Pets/Cats',
        depth: 2,
      }),
    ]);
  });

  it('returns ambiguous leaf names with distinct full paths', () => {
    const database = createCatalog();
    const repository = createRepository(database);
    repository.resolveOrCreatePath('Pets/Cats');
    repository.resolveOrCreatePath('People/Cats');

    expect(new TagSuggestionsQuery(database).findTagSuggestions('cat').map((tag) => tag.fullPath))
      .toEqual(['People/Cats', 'Pets/Cats']);
  });

  it('uses palette membership after match quality and reports direct child counts', () => {
    const database = createCatalog();
    const repository = createRepository(database);
    const alpha = repository.resolveOrCreatePath('Alpha').path[0];
    const alpine = repository.resolveOrCreatePath('Alpine').path[0];
    repository.resolveOrCreatePath('Alpha/One');
    repository.resolveOrCreatePath('Alpha/Two');
    repository.resolveOrCreatePath('Alpha/One/Deep');
    pinTag(database, alpine.tagId, 0);

    const suggestions = new TagSuggestionsQuery(database).findTagSuggestions('al');
    expect(suggestions.slice(0, 2).map((tag) => tag.fullPath)).toEqual(['Alpine', 'Alpha']);
    expect(suggestions.find((tag) => tag.tagId === alpha.tagId)).toMatchObject({
      childCount: 2,
      pinned: false,
    });
    expect(suggestions.find((tag) => tag.tagId === alpine.tagId)).toMatchObject({
      childCount: 0,
      pinned: true,
    });
  });

  it('orders equal-quality unpinned results by path key', () => {
    const database = createCatalog();
    const repository = createRepository(database);
    repository.resolveOrCreatePath('Pets/Cats');
    repository.resolveOrCreatePath('People/Cats');

    expect(new TagSuggestionsQuery(database).findTagSuggestions('cat').map((tag) => tag.fullPath))
      .toEqual(['People/Cats', 'Pets/Cats']);
  });

  it('finds legacy flat-only tags by leaf key without parsing their display slash', () => {
    const database = createCatalog();
    const inserted = database.prepare(`INSERT INTO tags
      (parent_tag_id, display_name, normalized_key, legacy_flat_only, created_at, updated_at)
      VALUES (NULL, ?, ?, 1, ?, ?)`)
      .run('Legacy/Flat', 'legacy/flat', initialTimestamp, initialTimestamp);
    const legacyTagId = Number(inserted.lastInsertRowid);
    database.prepare(`INSERT INTO tag_closure (ancestor_tag_id, descendant_tag_id, depth)
      VALUES (?, ?, 0)`).run(legacyTagId, legacyTagId);
    database.prepare(`INSERT INTO tag_paths
      (tag_id, path_display, path_key, leaf_key, depth, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)`)
      .run(legacyTagId, 'Legacy/Flat', 'legacy-flat:legacy/flat', 'legacy/flat', initialTimestamp);

    const suggestion = new TagSuggestionsQuery(database).findTagSuggestions('legacy/flat')[0];
    expect(suggestion).toMatchObject({
      tagId: legacyTagId,
      fullPath: 'Legacy/Flat',
      depth: 1,
      childCount: 0,
      legacyFlatOnly: true,
    });
  });

  it('treats percent and underscore query characters literally', () => {
    const database = createCatalog();
    const repository = createRepository(database);
    repository.resolveOrCreatePath('%tag');
    repository.resolveOrCreatePath('Xtag');
    repository.resolveOrCreatePath('_tag');
    repository.resolveOrCreatePath('Atag');
    const query = new TagSuggestionsQuery(database);

    expect(query.findTagSuggestions('%').map((tag) => tag.fullPath)).toEqual(['%tag']);
    expect(query.findTagSuggestions('_').map((tag) => tag.fullPath)).toEqual(['_tag']);
  });

  it('validates query size and limits without silently clamping', () => {
    const database = createCatalog();
    const query = new TagSuggestionsQuery(database);
    expect(query.findTagSuggestions('A'.repeat(768))).toEqual([]);
    expect(() => query.findTagSuggestions('A'.repeat(769))).toThrow();
    expect(() => query.findTagSuggestions(null as unknown as string)).toThrow();
    for (const invalidLimit of [0, -1, 1.5, 51, Number.NaN]) {
      expect(() => query.findTagSuggestions('tag', invalidLimit)).toThrow();
    }
  });

  it('respects requested limits and never returns more than 50 rows', () => {
    const database = createCatalog();
    const repository = createRepository(database);
    for (let index = 0; index < 55; index += 1) {
      repository.resolveOrCreatePath(`Bulk${index.toString().padStart(2, '0')}`);
    }
    const query = new TagSuggestionsQuery(database);

    expect(query.findTagSuggestions('bulk', 2)).toHaveLength(2);
    expect(query.findTagSuggestions('bulk', 50)).toHaveLength(50);
  });

  it('performs read-only bounded suggestions and returns safe numeric fields', () => {
    const database = createCatalog();
    const repository = createRepository(database);
    repository.resolveOrCreatePath('Pets/Cats');
    const beforeRevision = readRevision(database);
    const beforeTags = database.prepare('SELECT tag_id, updated_at FROM tags ORDER BY tag_id').all();
    const beforePaths = database.prepare('SELECT tag_id, updated_at FROM tag_paths ORDER BY tag_id').all();

    const suggestions = new TagSuggestionsQuery(database).findTagSuggestions('pets');
    expect(suggestions[0]).toMatchObject({
      tagId: expect.any(Number),
      parentTagId: null,
      depth: expect.any(Number),
      childCount: expect.any(Number),
      pinned: expect.any(Boolean),
      legacyFlatOnly: false,
    });
    expect(readRevision(database)).toBe(beforeRevision);
    expect(database.prepare('SELECT tag_id, updated_at FROM tags ORDER BY tag_id').all()).toEqual(beforeTags);
    expect(database.prepare('SELECT tag_id, updated_at FROM tag_paths ORDER BY tag_id').all()).toEqual(beforePaths);
    expect(new TagSuggestionsQuery(database).findTagSuggestions('does-not-exist')).toEqual([]);
  });
});
