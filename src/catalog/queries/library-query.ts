import { Buffer } from 'buffer';
import type { CatalogDatabase } from '../migrations/schema';
import {
  canonicalizeLibraryQuery,
  fingerprintLibraryQuery,
  isLibraryOrder,
  IssuedLibraryQueryRegistry,
  normalizeLibraryQuery,
  requirePositiveSafeInteger,
  requireQueryFingerprint,
  type LibraryOrder,
  type LibraryQuery,
} from '../library/library-query-model';

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 200;
const CURSOR_VERSION = 1;

const IntegrityStates = [
  'clean',
  'missing',
  'unreadable',
  'metadata_conflict',
  'content_conflict',
  'recovery_required',
] as const;

export type IntegrityState = (typeof IntegrityStates)[number];

export interface PhotoSummaryDto {
  photoId: number;
  canonicalFilename: string;
  originalFilename: string;
  flagged: boolean;
  integrityState: IntegrityState;
  width: number;
  height: number;
  contentRevision: number;
  thumbnailRevision: number;
  thumbnailUrl: string;
}

export interface LibraryPageOptions {
  cursor?: string | null;
  pageSize?: number;
}

export interface LibraryPageResult {
  queryFingerprint: string;
  totalCount: number;
  photos: PhotoSummaryDto[];
  nextCursor: string | null;
}

interface PhotoRow {
  photo_id: unknown;
  original_filename: unknown;
  flagged: unknown;
  integrity_state: unknown;
  width: unknown;
  height: unknown;
  content_revision: unknown;
  thumbnail_revision: unknown;
}

interface CountRow {
  count: unknown;
}

interface TagIdRow {
  tag_id: unknown;
}

interface CursorPayload {
  v: 1;
  fingerprint: string;
  order: LibraryOrder;
  sortValue: number | string;
  photoId: number;
}

export interface BuiltLibrarySql {
  sql: string;
  parameters: Record<string, string | number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function databaseSafeInteger(value: unknown, field: string): number {
  const numericValue = typeof value === 'bigint' ? Number(value) : value;
  if (typeof numericValue !== 'number' || !Number.isSafeInteger(numericValue)) {
    throw new Error(`${field} is not a safe integer`);
  }
  return numericValue;
}

function positiveDatabaseInteger(value: unknown, field: string): number {
  const numericValue = databaseSafeInteger(value, field);
  if (numericValue <= 0) {
    throw new Error(`${field} must be positive`);
  }
  return numericValue;
}

function booleanFromDatabase(value: unknown, field: string): boolean {
  const numericValue = databaseSafeInteger(value, field);
  if (numericValue !== 0 && numericValue !== 1) {
    throw new Error(`${field} must be 0 or 1`);
  }
  return numericValue === 1;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be non-empty text`);
  }
  return value;
}

function requireIntegrityState(value: unknown): IntegrityState {
  if (
    typeof value !== 'string' ||
    !(IntegrityStates as readonly string[]).includes(value)
  ) {
    throw new Error('photos.integrity_state is invalid');
  }
  return value as IntegrityState;
}

function toPhotoSummary(row: PhotoRow): PhotoSummaryDto {
  const photoId = positiveDatabaseInteger(row.photo_id, 'photos.photo_id');
  const width = positiveDatabaseInteger(row.width, 'photos.width');
  const height = positiveDatabaseInteger(row.height, 'photos.height');
  const contentRevision = positiveDatabaseInteger(
    row.content_revision,
    'photos.content_revision'
  );
  const thumbnailRevision = positiveDatabaseInteger(
    row.thumbnail_revision,
    'photos.thumbnail_revision'
  );
  return {
    photoId,
    canonicalFilename: `${String(photoId).padStart(10, '0')}.jpg`,
    originalFilename: requireText(row.original_filename, 'photos.original_filename'),
    flagged: booleanFromDatabase(row.flagged, 'photos.flagged'),
    integrityState: requireIntegrityState(row.integrity_state),
    width,
    height,
    contentRevision,
    thumbnailRevision,
    thumbnailUrl: `pt-photo://thumb/${photoId}?thumb=${thumbnailRevision}`,
  };
}

function buildFilterParts(query: LibraryQuery): {
  withClause: string;
  matchingJoin: string;
  predicates: string[];
  parameters: Record<string, string | number>;
} {
  const hasTagFilters = query.tagIds.length > 0;
  return {
    withClause: hasTagFilters
      ? `WITH matching AS (
          SELECT pt.photo_id
          FROM photo_tags AS pt
          JOIN tag_closure AS tc ON tc.descendant_tag_id = pt.tag_id
          WHERE tc.ancestor_tag_id IN (
            SELECT value FROM json_each(@filter_tag_ids_json)
          )
          GROUP BY pt.photo_id
          HAVING COUNT(DISTINCT tc.ancestor_tag_id) = @filter_count
        )`
      : '',
    matchingJoin: hasTagFilters ? 'JOIN matching AS m ON m.photo_id = p.photo_id' : '',
    predicates: [
      "p.lifecycle_state = 'active'",
      ...(query.flaggedOnly ? ['p.flagged = 1'] : []),
    ],
    parameters: hasTagFilters
      ? {
          filter_tag_ids_json: JSON.stringify(query.tagIds),
          filter_count: query.tagIds.length,
        }
      : {},
  };
}

export function buildFilteredPhotoIdsSelect(query: LibraryQuery): BuiltLibrarySql {
  const filter = buildFilterParts(query);
  return {
    sql: `${filter.withClause}
      SELECT p.photo_id
      FROM photos AS p
      ${filter.matchingJoin}
      WHERE ${filter.predicates.join('\n        AND ')}`,
    parameters: filter.parameters,
  };
}

export function photoBelongsToLibraryQuery(
  database: CatalogDatabase,
  query: LibraryQuery,
  photoId: number
): boolean {
  const filtered = buildFilteredPhotoIdsSelect(query);
  const row = database.prepare(`${filtered.sql}
    AND p.photo_id = @candidate_photo_id
    LIMIT 1`).get({
    ...filtered.parameters,
    candidate_photo_id: photoId,
  });
  return row !== undefined;
}

function normalizePageOptions(input: unknown): Required<LibraryPageOptions> {
  if (!isRecord(input) || !hasOnlyKeys(input, ['cursor', 'pageSize'])) {
    throw new Error('Library page options are invalid');
  }
  const cursor = input.cursor === undefined || input.cursor === null
    ? null
    : input.cursor;
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0)) {
    throw new Error('Library cursor must be non-empty opaque text or null');
  }
  const pageSize = input.pageSize === undefined ? DEFAULT_PAGE_SIZE : input.pageSize;
  if (
    typeof pageSize !== 'number' ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_PAGE_SIZE
  ) {
    throw new Error('Library page size must be an integer between 1 and 200');
  }
  return { cursor, pageSize };
}

function encodeCursor(payload: CursorPayload): string {
  const canonicalJson = JSON.stringify({
    v: payload.v,
    fingerprint: payload.fingerprint,
    order: payload.order,
    sortValue: payload.sortValue,
    photoId: payload.photoId,
  });
  return Buffer.from(canonicalJson, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): CursorPayload {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error('Library cursor is not valid base64url');
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(cursor, 'base64url');
  } catch {
    throw new Error('Library cursor is not valid base64url');
  }
  if (decoded.length === 0 || decoded.toString('base64url') !== cursor) {
    throw new Error('Library cursor is not canonical base64url');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error('Library cursor does not contain valid JSON');
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 5 ||
    !['v', 'fingerprint', 'order', 'sortValue', 'photoId'].every((key) => key in parsed)
  ) {
    throw new Error('Library cursor shape is invalid');
  }
  if (parsed.v !== CURSOR_VERSION) {
    throw new Error('Library cursor version is unsupported');
  }
  const fingerprint = requireQueryFingerprint(parsed.fingerprint);
  if (!isLibraryOrder(parsed.order)) {
    throw new Error('Library cursor order is invalid');
  }
  const photoId = requirePositiveSafeInteger(parsed.photoId, 'Library cursor photoId');
  const idOrdered = parsed.order === 'newest-imported' || parsed.order === 'oldest-imported';
  if (idOrdered) {
    if (
      typeof parsed.sortValue !== 'number' ||
      !Number.isSafeInteger(parsed.sortValue) ||
      parsed.sortValue !== photoId
    ) {
      throw new Error('Library cursor sort value is invalid for photo-ID ordering');
    }
  } else if (typeof parsed.sortValue !== 'string' || parsed.sortValue.length === 0) {
    throw new Error('Library cursor sort value is invalid for filename ordering');
  }
  return {
    v: CURSOR_VERSION,
    fingerprint,
    order: parsed.order,
    sortValue: parsed.sortValue,
    photoId,
  };
}

function orderSql(order: LibraryOrder): string {
  switch (order) {
    case 'newest-imported':
      return 'p.photo_id DESC';
    case 'oldest-imported':
      return 'p.photo_id ASC';
    case 'original-filename-asc':
      return 'p.original_filename ASC, p.photo_id ASC';
    case 'original-filename-desc':
      return 'p.original_filename DESC, p.photo_id DESC';
  }
}

function cursorPredicate(payload: CursorPayload | null): string | null {
  if (!payload) {
    return null;
  }
  switch (payload.order) {
    case 'newest-imported':
      return 'p.photo_id < @cursor_photo_id';
    case 'oldest-imported':
      return 'p.photo_id > @cursor_photo_id';
    case 'original-filename-asc':
      return `(p.original_filename > @cursor_sort_text OR
        (p.original_filename = @cursor_sort_text AND p.photo_id > @cursor_photo_id))`;
    case 'original-filename-desc':
      return `(p.original_filename < @cursor_sort_text OR
        (p.original_filename = @cursor_sort_text AND p.photo_id < @cursor_photo_id))`;
  }
}

function cursorForPhoto(
  fingerprint: string,
  order: LibraryOrder,
  photo: PhotoSummaryDto
): CursorPayload {
  return {
    v: CURSOR_VERSION,
    fingerprint,
    order,
    sortValue: order === 'newest-imported' || order === 'oldest-imported'
      ? photo.photoId
      : photo.originalFilename,
    photoId: photo.photoId,
  };
}

export class LibraryQueryService {
  constructor(
    private readonly database: CatalogDatabase,
    private readonly registry: IssuedLibraryQueryRegistry
  ) {}

  public queryLibrary(
    queryInput: unknown,
    optionsInput: unknown = {}
  ): LibraryPageResult {
    const query = normalizeLibraryQuery(queryInput);
    const options = normalizePageOptions(optionsInput);
    this.validateTagReferences(query.tagIds);
    const fingerprint = fingerprintLibraryQuery(query);
    const cursor = options.cursor === null
      ? null
      : this.validateCursor(options.cursor, query, fingerprint);

    const readPage = this.database.transaction(() => {
      const totalCount = this.countPhotos(query);
      const photosWithLookahead = this.readPhotos(
        query,
        cursor,
        options.pageSize + 1
      );
      return { totalCount, photosWithLookahead };
    });

    // Every page recomputes count with its rows in one current SQLite read snapshot.
    const { totalCount, photosWithLookahead } = readPage();
    const hasMore = photosWithLookahead.length > options.pageSize;
    const photos = hasMore
      ? photosWithLookahead.slice(0, options.pageSize)
      : photosWithLookahead;
    this.registry.issue(query);

    let nextCursor: string | null = null;
    if (hasMore) {
      const finalPhoto = photos[photos.length - 1];
      nextCursor = encodeCursor(cursorForPhoto(fingerprint, query.order, finalPhoto));
      this.registry.issueCursor(nextCursor);
    }
    return {
      queryFingerprint: fingerprint,
      totalCount,
      photos,
      nextCursor,
    };
  }

  private validateTagReferences(tagIds: number[]): void {
    if (tagIds.length === 0) {
      return;
    }
    const rows = this.database.prepare(`
      SELECT tag_id
      FROM tags
      WHERE tag_id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(tagIds)) as TagIdRow[];
    const found = new Set(rows.map((row) =>
      positiveDatabaseInteger(row.tag_id, 'tags.tag_id')
    ));
    const missing = tagIds.filter((tagId) => !found.has(tagId));
    if (missing.length > 0) {
      throw new Error(`Library query references unknown tag ID ${missing[0]}`);
    }
  }

  private validateCursor(
    cursorText: string,
    query: LibraryQuery,
    fingerprint: string
  ): CursorPayload {
    const cursor = decodeCursor(cursorText);
    if (cursor.fingerprint !== fingerprint) {
      throw new Error('Library cursor belongs to a different query');
    }
    if (cursor.order !== query.order) {
      throw new Error('Library cursor order does not match the query');
    }
    const issued = this.registry.requireIssued(cursor.fingerprint);
    if (issued.canonicalJson !== canonicalizeLibraryQuery(query)) {
      throw new Error('Library cursor query identity does not match');
    }
    this.registry.requireIssuedCursor(cursorText);
    return cursor;
  }

  private countPhotos(query: LibraryQuery): number {
    const filter = buildFilterParts(query);
    const row = this.database.prepare(`${filter.withClause}
      SELECT COUNT(*) AS count
      FROM photos AS p
      ${filter.matchingJoin}
      WHERE ${filter.predicates.join('\n        AND ')}
    `).get(filter.parameters) as CountRow;
    const count = databaseSafeInteger(row.count, 'Library total count');
    if (count < 0) {
      throw new Error('Library total count must not be negative');
    }
    return count;
  }

  private readPhotos(
    query: LibraryQuery,
    cursor: CursorPayload | null,
    limit: number
  ): PhotoSummaryDto[] {
    const filter = buildFilterParts(query);
    const keysetPredicate = cursorPredicate(cursor);
    const predicates = [
      ...filter.predicates,
      ...(keysetPredicate ? [keysetPredicate] : []),
    ];
    const parameters: Record<string, string | number> = {
      ...filter.parameters,
      page_limit: limit,
    };
    if (cursor) {
      parameters.cursor_photo_id = cursor.photoId;
      if (typeof cursor.sortValue === 'string') {
        parameters.cursor_sort_text = cursor.sortValue;
      }
    }
    const rows = this.database.prepare(`${filter.withClause}
      SELECT
        p.photo_id,
        p.original_filename,
        p.flagged,
        p.integrity_state,
        p.width,
        p.height,
        p.content_revision,
        p.thumbnail_revision
      FROM photos AS p
      ${filter.matchingJoin}
      WHERE ${predicates.join('\n        AND ')}
      ORDER BY ${orderSql(query.order)}
      LIMIT @page_limit
    `).all(parameters) as PhotoRow[];
    return rows.map(toPhotoSummary);
  }
}
