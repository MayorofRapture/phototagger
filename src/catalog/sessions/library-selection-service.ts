import { randomUUID } from 'crypto';
import type { CatalogDatabase } from '../migrations/schema';
import {
  IssuedLibraryQueryRegistry,
  requirePositiveSafeInteger,
  type LibraryQuery,
} from '../library/library-query-model';
import {
  buildFilteredPhotoIdsSelect,
  photoBelongsToLibraryQuery,
} from '../queries/library-query';

export type SelectionSeed =
  | { type: 'none' }
  | { type: 'all' }
  | { type: 'one'; photoId: number };

export interface SelectionRef {
  selectionId: string;
  count: number;
  catalogRevisionAtCapture: number;
}

export interface LibrarySelectionServiceOptions {
  now?: () => string;
  selectionId?: () => string;
}

interface SelectionSessionRow {
  selection_id: unknown;
  query_fingerprint: unknown;
  catalog_revision: unknown;
}

interface CountRow {
  count: unknown;
}

interface AppStateRow {
  catalog_revision: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function databaseSafeInteger(value: unknown, field: string): number {
  const numericValue = typeof value === 'bigint' ? Number(value) : value;
  if (typeof numericValue !== 'number' || !Number.isSafeInteger(numericValue)) {
    throw new Error(`${field} is not a safe integer`);
  }
  return numericValue;
}

function requireSelectionId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('Selection ID must be a UUID');
  }
  return value;
}

function normalizeSeed(value: unknown): SelectionSeed {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Selection seed is invalid');
  }
  if (value.type === 'none' || value.type === 'all') {
    if (!hasExactKeys(value, ['type'])) {
      throw new Error('Selection seed contains unknown fields');
    }
    return { type: value.type };
  }
  if (value.type === 'one' && hasExactKeys(value, ['type', 'photoId'])) {
    return {
      type: 'one',
      photoId: requirePositiveSafeInteger(value.photoId, 'Selection seed photoId'),
    };
  }
  throw new Error('Selection seed is invalid');
}

function normalizePhotoIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error('Selection photoIds must be an array');
  }
  const photoIds = value.map((photoId, index) =>
    requirePositiveSafeInteger(photoId, `Selection photoIds[${index}]`)
  );
  return [...new Set(photoIds)].sort((left, right) => left - right);
}

export class LibrarySelectionService {
  private readonly now: () => string;
  private readonly createSelectionId: () => string;

  constructor(
    private readonly database: CatalogDatabase,
    private readonly registry: IssuedLibraryQueryRegistry,
    options: LibrarySelectionServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createSelectionId = options.selectionId ?? randomUUID;
  }

  public createSelection(queryFingerprint: unknown, seedInput: unknown): SelectionRef {
    const issued = this.registry.requireIssued(queryFingerprint);
    const seed = normalizeSeed(seedInput);
    const create = this.database.transaction(() => {
      const catalogRevisionAtCapture = this.readCatalogRevision();
      const selectionId = requireSelectionId(this.createSelectionId());
      const createdAt = this.now();
      if (typeof createdAt !== 'string' || createdAt.length === 0) {
        throw new Error('Selection creation timestamp is invalid');
      }

      this.database.prepare(`INSERT INTO temp.selection_sessions
        (selection_id, query_fingerprint, catalog_revision, created_at)
        VALUES (?, ?, ?, ?)`)
        .run(selectionId, issued.fingerprint, catalogRevisionAtCapture, createdAt);

      if (seed.type === 'one') {
        if (!photoBelongsToLibraryQuery(this.database, issued.query, seed.photoId)) {
          throw new Error('Selection seed photo does not belong to the Library query');
        }
        this.database.prepare(`INSERT INTO temp.selection_members
          (selection_id, photo_id, selected) VALUES (?, ?, 1)`)
          .run(selectionId, seed.photoId);
      } else if (seed.type === 'all') {
        this.insertAllMembers(selectionId, issued.query);
      }

      return this.readSelectionRef(selectionId);
    });
    return create();
  }

  public updateSelection(
    selectionIdInput: unknown,
    photoIdsInput: unknown,
    selectedInput: unknown
  ): SelectionRef {
    const selectionId = requireSelectionId(selectionIdInput);
    const photoIds = normalizePhotoIds(photoIdsInput);
    if (typeof selectedInput !== 'boolean') {
      throw new Error('Selection selected value must be a boolean');
    }

    const update = this.database.transaction(() => {
      const { query } = this.requireSelectionQuery(selectionId);
      const photoIdsJson = JSON.stringify(photoIds);

      if (selectedInput) {
        const filtered = buildFilteredPhotoIdsSelect(query);
        const disallowed = this.database.prepare(`SELECT candidate.value AS photo_id
          FROM json_each(@candidate_photo_ids_json) AS candidate
          LEFT JOIN temp.selection_members AS existing
            ON existing.selection_id = @selection_id
           AND existing.photo_id = candidate.value
          LEFT JOIN (${filtered.sql}) AS current_match
            ON current_match.photo_id = candidate.value
          WHERE existing.photo_id IS NULL
            AND current_match.photo_id IS NULL
          LIMIT 1
        `).get({
          ...filtered.parameters,
          candidate_photo_ids_json: photoIdsJson,
          selection_id: selectionId,
        }) as { photo_id: unknown } | undefined;
        if (disallowed) {
          throw new Error(
            `Photo ${databaseSafeInteger(disallowed.photo_id, 'Selection candidate photo ID')} ` +
            'does not belong to the selection query'
          );
        }
        this.database.prepare(`
          INSERT INTO temp.selection_members (selection_id, photo_id, selected)
          SELECT @selection_id, value, 1
          FROM json_each(@candidate_photo_ids_json)
          WHERE 1
          ON CONFLICT(selection_id, photo_id) DO UPDATE SET selected = 1
        `).run({
          selection_id: selectionId,
          candidate_photo_ids_json: photoIdsJson,
        });
      } else {
        this.database.prepare(`UPDATE temp.selection_members
          SET selected = 0
          WHERE selection_id = @selection_id
            AND photo_id IN (
              SELECT value FROM json_each(@candidate_photo_ids_json)
            )`).run({
          selection_id: selectionId,
          candidate_photo_ids_json: photoIdsJson,
        });
      }
      return this.readSelectionRef(selectionId);
    });
    return update();
  }

  public clearSelection(selectionIdInput: unknown): void {
    const selectionId = requireSelectionId(selectionIdInput);
    const clear = this.database.transaction(() => {
      this.requireSelectionQuery(selectionId);
      const result = this.database.prepare(
        'DELETE FROM temp.selection_sessions WHERE selection_id = ?'
      ).run(selectionId);
      if (result.changes !== 1) {
        throw new Error('Selection was not found');
      }
    });
    clear();
  }

  public getSelection(selectionIdInput: unknown): SelectionRef {
    const selectionId = requireSelectionId(selectionIdInput);
    this.requireSelectionQuery(selectionId);
    return this.readSelectionRef(selectionId);
  }

  private insertAllMembers(selectionId: string, query: LibraryQuery): void {
    const filtered = buildFilteredPhotoIdsSelect(query);
    this.database.prepare(`INSERT INTO temp.selection_members
      (selection_id, photo_id, selected)
      SELECT @selection_id, candidates.photo_id, 1
      FROM (${filtered.sql}) AS candidates
    `).run({
      ...filtered.parameters,
      selection_id: selectionId,
    });
  }

  private readCatalogRevision(): number {
    const row = this.database.prepare(
      'SELECT catalog_revision FROM app_state WHERE singleton = 1'
    ).get() as AppStateRow | undefined;
    if (!row) {
      throw new Error('Selection creation requires the app_state singleton');
    }
    const revision = databaseSafeInteger(row.catalog_revision, 'app_state.catalog_revision');
    if (revision < 0) {
      throw new Error('app_state.catalog_revision must not be negative');
    }
    return revision;
  }

  private requireSelectionQuery(selectionId: string): { query: LibraryQuery } {
    const row = this.database.prepare(`SELECT
      selection_id, query_fingerprint, catalog_revision
      FROM temp.selection_sessions
      WHERE selection_id = ?`).get(selectionId) as SelectionSessionRow | undefined;
    if (!row) {
      throw new Error('Selection was not found');
    }
    if (typeof row.query_fingerprint !== 'string') {
      throw new Error('Selection query fingerprint is invalid');
    }
    const issued = this.registry.requireIssued(row.query_fingerprint);
    return { query: issued.query };
  }

  private readSelectionRef(selectionId: string): SelectionRef {
    const row = this.database.prepare(`SELECT
      selection_id, query_fingerprint, catalog_revision
      FROM temp.selection_sessions
      WHERE selection_id = ?`).get(selectionId) as SelectionSessionRow | undefined;
    if (!row) {
      throw new Error('Selection was not found');
    }
    if (typeof row.selection_id !== 'string') {
      throw new Error('Selection ID is invalid');
    }
    const catalogRevisionAtCapture = databaseSafeInteger(
      row.catalog_revision,
      'selection_sessions.catalog_revision'
    );
    if (catalogRevisionAtCapture < 0) {
      throw new Error('selection_sessions.catalog_revision must not be negative');
    }
    const countRow = this.database.prepare(`SELECT COUNT(*) AS count
      FROM temp.selection_members
      WHERE selection_id = ? AND selected = 1`).get(selectionId) as CountRow;
    const count = databaseSafeInteger(countRow.count, 'Selection member count');
    if (count < 0) {
      throw new Error('Selection member count must not be negative');
    }
    return {
      selectionId: row.selection_id,
      count,
      catalogRevisionAtCapture,
    };
  }
}
