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
import { normalizeTagSegment, normalizeTagPath } from '../../src/catalog/tags/tag-normalization';

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

function createCatalog(): CatalogDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phototagger-tags-'));
  temporaryDirectories.push(directory);
  const database = openNewCatalogForSchemaValidation(path.join(directory, 'catalog.sqlite'));
  temporaryDatabases.push(database);
  initializeNewCatalogState(database, {
    appVersion: '1.0.0-test',
    now: () => initialTimestamp,
    catalogUuid: () => '00000000-0000-4000-8000-000000000020',
  });
  return database;
}

function revision(database: CatalogDatabase): bigint {
  return (database.prepare(
    'SELECT catalog_revision FROM app_state WHERE singleton = 1'
  ).get() as { catalog_revision: bigint }).catalog_revision;
}

function counts(database: CatalogDatabase): [number, number, number] {
  return [
    Number((database.prepare('SELECT COUNT(*) AS count FROM tags').get() as { count: bigint }).count),
    Number((database.prepare('SELECT COUNT(*) AS count FROM tag_closure').get() as { count: bigint }).count),
    Number((database.prepare('SELECT COUNT(*) AS count FROM tag_paths').get() as { count: bigint }).count),
  ];
}

describe('TagRepository', () => {
  it('normalizes Unicode names and enforces segment/path limits', () => {
    expect(normalizeTagSegment('  Pets  ')).toEqual({ displayName: 'Pets', normalizedKey: 'pets' });
    expect(normalizeTagSegment('\u0085Pets\u0085')).toEqual({ displayName: 'Pets', normalizedKey: 'pets' });
    expect(normalizeTagSegment('CAFÉ')).toEqual({ displayName: 'CAFÉ', normalizedKey: 'café' });
    expect(normalizeTagSegment('Cafe\u0301')).toEqual({ displayName: 'Café', normalizedKey: 'café' });
    const sixtyFourByteSegment = `${'A'.repeat(62)}\u00E9`;
    const sixtyFiveByteSegment = `${'A'.repeat(63)}\u00E9`;
    expect(normalizeTagSegment(sixtyFourByteSegment).displayName).toBe(sixtyFourByteSegment);
    expect(() => normalizeTagSegment(sixtyFiveByteSegment)).toThrow();
    expect(() => normalizeTagPath('')).toThrow();
    expect(() => normalizeTagPath('Pets//Cats')).toThrow();
    expect(() => normalizeTagPath('Pets/ ')).toThrow();
    expect(() => normalizeTagPath('Pets|Cats')).toThrow();
    expect(() => normalizeTagPath('Pets;Cats')).toThrow();
    expect(() => normalizeTagPath(`Pets/Bad\u0001Name`)).toThrow();
    expect(() => normalizeTagPath(Array.from({ length: 13 }, (_, index) => `L${index}`).join('/'))).toThrow();
  });

  it('creates a root and maintains its path and self closure', () => {
    const database = createCatalog();
    const repository = new TagRepository(database, { now: () => updateTimestamp });

    const result = repository.resolveOrCreatePath('  Pets  ');
    expect(result.created).toBe(true);
    expect(result.catalogRevision).toBe(1n);
    expect(result.path).toHaveLength(1);
    expect(result.path[0]).toMatchObject({
      tagId: 1,
      parentTagId: null,
      displayName: 'Pets',
      normalizedKey: 'pets',
      legacyFlatOnly: false,
      pathDisplay: 'Pets',
      pathKey: 'pets',
      leafKey: 'pets',
      depth: 1,
    });
    expect(database.prepare('SELECT ancestor_tag_id, descendant_tag_id, depth FROM tag_closure').all())
      .toEqual([{ ancestor_tag_id: 1n, descendant_tag_id: 1n, depth: 0n }]);
  });

  it('creates all missing path nodes with ancestor closure rows', () => {
    const database = createCatalog();
    const repository = new TagRepository(database, { now: () => updateTimestamp });

    const result = repository.resolveOrCreatePath('Pets/Cats/Tuxedo');
    expect(result.path.map((tag) => tag.displayName)).toEqual(['Pets', 'Cats', 'Tuxedo']);
    expect(result.catalogRevision).toBe(1n);
    expect(database.prepare(`SELECT ancestor_tag_id, descendant_tag_id, depth
      FROM tag_closure ORDER BY descendant_tag_id, depth`).all()).toEqual([
      { ancestor_tag_id: 1n, descendant_tag_id: 1n, depth: 0n },
      { ancestor_tag_id: 2n, descendant_tag_id: 2n, depth: 0n },
      { ancestor_tag_id: 1n, descendant_tag_id: 2n, depth: 1n },
      { ancestor_tag_id: 3n, descendant_tag_id: 3n, depth: 0n },
      { ancestor_tag_id: 2n, descendant_tag_id: 3n, depth: 1n },
      { ancestor_tag_id: 1n, descendant_tag_id: 3n, depth: 2n },
    ]);
    expect(database.prepare(`SELECT path_display, path_key, leaf_key, depth, updated_at
      FROM tag_paths ORDER BY tag_id`).all()).toEqual([
      { path_display: 'Pets', path_key: 'pets', leaf_key: 'pets', depth: 1n, updated_at: updateTimestamp },
      { path_display: 'Pets/Cats', path_key: 'pets/cats', leaf_key: 'cats', depth: 2n, updated_at: updateTimestamp },
      { path_display: 'Pets/Cats/Tuxedo', path_key: 'pets/cats/tuxedo', leaf_key: 'tuxedo', depth: 3n, updated_at: updateTimestamp },
    ]);
    expect(database.prepare('SELECT created_at, updated_at FROM tags ORDER BY tag_id').all()).toEqual([
      { created_at: updateTimestamp, updated_at: updateTimestamp },
      { created_at: updateTimestamp, updated_at: updateTimestamp },
      { created_at: updateTimestamp, updated_at: updateTimestamp },
    ]);
  });

  it('resolves siblings case-insensitively while preserving existing display spelling', () => {
    const database = createCatalog();
    let nowCalls = 0;
    const repository = new TagRepository(database, {
      now: () => {
        nowCalls += 1;
        return updateTimestamp;
      },
    });

    const first = repository.resolveOrCreatePath('Pets/Cats');
    const second = repository.resolveOrCreatePath(' pets / CATS ');
    expect(second.created).toBe(false);
    expect(second.catalogRevision).toBe(1n);
    expect(second.path.map((tag) => tag.displayName)).toEqual(['Pets', 'Cats']);
    expect(nowCalls).toBe(1);
    expect(first.path.map((tag) => tag.tagId)).toEqual(second.path.map((tag) => tag.tagId));
  });

  it('resolves NFC-equivalent repository inputs to the same existing sibling', () => {
    const database = createCatalog();
    const repository = new TagRepository(database, { now: () => updateTimestamp });

    const composed = repository.resolveOrCreatePath('Café');
    const decomposed = repository.resolveOrCreatePath('Cafe\u0301');

    expect(composed.path[0].displayName).toBe('Café');
    expect(decomposed.created).toBe(false);
    expect(decomposed.path[0].tagId).toBe(composed.path[0].tagId);
    expect(decomposed.catalogRevision).toBe(1n);
    expect(database.prepare('SELECT COUNT(*) AS count FROM tags').get()).toEqual({ count: 1n });
    expect(repository.getTagById(composed.path[0].tagId)?.displayName).toBe('Café');
  });

  it('creates only missing suffixes and increments the revision once per mutation', () => {
    const database = createCatalog();
    const repository = new TagRepository(database, { now: () => updateTimestamp });
    repository.resolveOrCreatePath('Pets');

    const result = repository.resolveOrCreatePath('Pets/Cats/Tuxedo');
    expect(result.created).toBe(true);
    expect(result.catalogRevision).toBe(2n);
    expect(revision(database)).toBe(2n);
    expect(counts(database)).toEqual([3, 6, 3]);
  });

  it('keeps identical leaf names distinct beneath different parents', () => {
    const database = createCatalog();
    const repository = new TagRepository(database, { now: () => updateTimestamp });
    const petsCats = repository.resolveOrCreatePath('Pets/Cats').path[1];
    const peopleCats = repository.resolveOrCreatePath('People/Cats').path[1];

    expect(peopleCats.tagId).not.toBe(petsCats.tagId);
    expect(peopleCats.pathKey).toBe('people/cats');
    expect(repository.listChildren(null).map((tag) => tag.pathKey)).toEqual(['people', 'pets']);
  });

  it('does not write or advance revision for an existing path no-op', () => {
    const database = createCatalog();
    const first = new TagRepository(database, { now: () => initialTimestamp });
    first.resolveOrCreatePath('Pets/Cats');
    const before = database.prepare(`SELECT t.updated_at AS tag_updated_at, p.updated_at AS path_updated_at
      FROM tags t JOIN tag_paths p ON p.tag_id = t.tag_id ORDER BY t.tag_id`).all();
    const noOp = new TagRepository(database, {
      now: () => {
        throw new Error('now must not be called for a no-op');
      },
    }).resolveOrCreatePath('PETS/cats');
    expect(noOp.created).toBe(false);
    expect(noOp.catalogRevision).toBe(1n);
    expect(database.prepare(`SELECT t.updated_at AS tag_updated_at, p.updated_at AS path_updated_at
      FROM tags t JOIN tag_paths p ON p.tag_id = t.tag_id ORDER BY t.tag_id`).all()).toEqual(before);
    expect(revision(database)).toBe(1n);
  });

  it('rejects malformed paths before changing durable tag state', () => {
    const database = createCatalog();
    const repository = new TagRepository(database, { now: () => updateTimestamp });
    const before = [...counts(database), revision(database)];
    for (const invalidPath of ['/', 'Pets//Cats', 'Pets|Cats', 'Pets;Cats', 'Pets/Bad\u0000Name']) {
      expect(() => repository.resolveOrCreatePath(invalidPath)).toThrow();
    }
    expect([...counts(database), revision(database)]).toEqual(before);
  });

  it('rejects inconsistent existing derived state instead of repairing it', () => {
    const database = createCatalog();
    const repository = new TagRepository(database, { now: () => updateTimestamp });
    repository.resolveOrCreatePath('Pets/Cats');
    database.prepare("UPDATE tag_paths SET path_key = 'wrong' WHERE tag_id = 2").run();

    expect(() => repository.resolveOrCreatePath('Pets/Cats/Kitten')).toThrow();
    expect(database.prepare('SELECT path_key FROM tag_paths WHERE tag_id = 2').get())
      .toEqual({ path_key: 'wrong' });
    expect(revision(database)).toBe(1n);
  });

  it('lists children deterministically and returns null for an unknown id', () => {
    const database = createCatalog();
    const repository = new TagRepository(database, { now: () => updateTimestamp });
    const pets = repository.resolveOrCreatePath('Pets').path[0];
    repository.resolveOrCreatePath('Pets/zebra');
    repository.resolveOrCreatePath('Pets/alpha');
    repository.resolveOrCreatePath('People');

    expect(repository.listChildren(null).map((tag) => tag.displayName)).toEqual(['People', 'Pets']);
    expect(repository.listChildren(pets.tagId).map((tag) => tag.displayName)).toEqual(['alpha', 'zebra']);
    expect(repository.getTagById(999999)).toBeNull();
  });

  it('fails tag creation when app_state is absent without creating bootstrap state', () => {
    const database = createCatalog();
    database.prepare('DELETE FROM app_state').run();
    const repository = new TagRepository(database, { now: () => updateTimestamp });

    expect(() => repository.resolveOrCreatePath('Pets')).toThrow(/app_state singleton/);
    expect(counts(database)).toEqual([0, 0, 0]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM app_state').get()).toEqual({ count: 0n });
  });

  it('rejects a child beyond the maximum hierarchy depth', () => {
    const database = createCatalog();
    const repository = new TagRepository(database, { now: () => updateTimestamp });
    const pathAtLimit = Array.from({ length: 12 }, (_, index) => `L${index}`).join('/');
    repository.resolveOrCreatePath(pathAtLimit);
    const before = [...counts(database), revision(database)];

    expect(() => repository.resolveOrCreatePath(`${pathAtLimit}/TooDeep`)).toThrow();
    expect([...counts(database), revision(database)]).toEqual(before);
  });

  it('does not use a legacy flat-only tag as a normal hierarchy parent', () => {
    const database = createCatalog();
    database.prepare(`INSERT INTO tags
      (parent_tag_id, display_name, normalized_key, legacy_flat_only, created_at, updated_at)
      VALUES (NULL, 'Legacy', 'legacy', 1, ?, ?)`)
      .run(initialTimestamp, initialTimestamp);
    database.prepare(`INSERT INTO tag_closure (ancestor_tag_id, descendant_tag_id, depth)
      VALUES (last_insert_rowid(), last_insert_rowid(), 0)`).run();
    const legacyId = Number((database.prepare("SELECT tag_id FROM tags WHERE normalized_key = 'legacy'").get() as { tag_id: bigint }).tag_id);
    database.prepare(`INSERT INTO tag_paths
      (tag_id, path_display, path_key, leaf_key, depth, updated_at)
      VALUES (?, 'Legacy', 'legacy-flat:legacy', 'legacy', 1, ?)`)
      .run(legacyId, initialTimestamp);

    const repository = new TagRepository(database, { now: () => updateTimestamp });
    expect(repository.getTagById(legacyId)).toMatchObject({
      legacyFlatOnly: true,
      displayName: 'Legacy',
      pathKey: 'legacy-flat:legacy',
    });
    expect(() => repository.resolveOrCreatePath('Legacy/Child')).toThrow(/legacy flat-only/);
    expect(counts(database)).toEqual([1, 1, 1]);
    expect(revision(database)).toBe(0n);
  });
});
