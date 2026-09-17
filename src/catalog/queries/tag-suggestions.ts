import { Buffer } from 'buffer';
import type { CatalogDatabase } from '../migrations/schema';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY_BYTES = 768;
const UNICODE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

export interface TagSuggestionDto {
  tagId: number;
  parentTagId: number | null;
  displayName: string;
  fullPath: string;
  depth: number;
  childCount: number;
  pinned: boolean;
  legacyFlatOnly: boolean;
}

interface SuggestionRow {
  tag_id: unknown;
  parent_tag_id: unknown;
  display_name: unknown;
  full_path: unknown;
  depth: unknown;
  child_count: unknown;
  pinned: unknown;
  legacy_flat_only: unknown;
}

function safeInteger(value: unknown, field: string): number {
  const numericValue = typeof value === 'bigint' ? Number(value) : value;
  if (typeof numericValue !== 'number' || !Number.isSafeInteger(numericValue)) {
    throw new Error(`${field} is not a safe integer`);
  }
  return numericValue;
}

function safeTagId(value: unknown, field = 'tag_id'): number {
  const tagId = safeInteger(value, field);
  if (tagId <= 0) {
    throw new Error(`${field} must be positive`);
  }
  return tagId;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} is not text`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  const numericValue = safeInteger(value, field);
  if (numericValue !== 0 && numericValue !== 1) {
    throw new Error(`${field} must be 0 or 1`);
  }
  return numericValue === 1;
}

function normalizeSuggestionQuery(query: string): string {
  if (typeof query !== 'string') {
    throw new Error('Tag suggestion query must be a string');
  }
  if (Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) {
    throw new Error('Tag suggestion query exceeds 768 UTF-8 bytes');
  }

  const normalizedQuery = query
    .replace(UNICODE_WHITE_SPACE, '')
    .normalize('NFC');
  return normalizedQuery.toLocaleLowerCase('en-US').normalize('NFC');
}

function escapeLikePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function toSuggestionDto(row: SuggestionRow): TagSuggestionDto {
  const parentTagId = row.parent_tag_id === null
    ? null
    : safeTagId(row.parent_tag_id, 'parent_tag_id');
  const depth = safeInteger(row.depth, 'tag_paths.depth');
  if (depth < 1 || depth > 12) {
    throw new Error('tag_paths.depth is outside the supported range');
  }
  const childCount = safeInteger(row.child_count, 'child_count');
  if (childCount < 0) {
    throw new Error('child_count must not be negative');
  }

  return {
    tagId: safeTagId(row.tag_id),
    parentTagId,
    displayName: requireText(row.display_name, 'tags.display_name'),
    fullPath: requireText(row.full_path, 'tag_paths.path_display'),
    depth,
    childCount,
    pinned: requireBoolean(row.pinned, 'pinned'),
    legacyFlatOnly: requireBoolean(row.legacy_flat_only, 'tags.legacy_flat_only'),
  };
}

export class TagSuggestionsQuery {
  constructor(private readonly database: CatalogDatabase) {}

  public findTagSuggestions(query: string, limit = DEFAULT_LIMIT): TagSuggestionDto[] {
    const normalizedQuery = normalizeSuggestionQuery(query);
    const validatedLimit = this.validateLimit(limit);
    if (normalizedQuery.length === 0) {
      return [];
    }

    const exactKey = normalizedQuery;
    const prefixKey = escapeLikePrefix(normalizedQuery);
    const rows = this.database.prepare(`
      SELECT
        t.tag_id,
        t.parent_tag_id,
        t.display_name,
        p.path_display AS full_path,
        p.depth,
        (
          SELECT COUNT(*)
          FROM tags AS child
          WHERE child.parent_tag_id = t.tag_id
        ) AS child_count,
        CASE WHEN pe.tag_id IS NULL THEN 0 ELSE 1 END AS pinned,
        t.legacy_flat_only,
        CASE
          WHEN p.leaf_key = @exact_key THEN 1
          WHEN p.leaf_key LIKE @prefix_key ESCAPE '\\' THEN 2
          WHEN p.path_key LIKE @prefix_key ESCAPE '\\' THEN 3
        END AS match_quality
      FROM tags AS t
      JOIN tag_paths AS p ON p.tag_id = t.tag_id
      LEFT JOIN palette_entries AS pe ON pe.tag_id = t.tag_id
      WHERE p.leaf_key = @exact_key
         OR p.leaf_key LIKE @prefix_key ESCAPE '\\'
         OR p.path_key LIKE @prefix_key ESCAPE '\\'
      ORDER BY
        match_quality,
        CASE WHEN pe.tag_id IS NULL THEN 1 ELSE 0 END,
        p.path_key,
        t.tag_id
      LIMIT @limit
    `).all({ exact_key: exactKey, prefix_key: prefixKey, limit: validatedLimit }) as SuggestionRow[];

    return rows.map(toSuggestionDto);
  }

  private validateLimit(limit: number): number {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error('Tag suggestion limit must be an integer between 1 and 50');
    }
    return limit;
  }
}

export function findTagSuggestions(
  database: CatalogDatabase,
  query: string,
  limit = DEFAULT_LIMIT
): TagSuggestionDto[] {
  return new TagSuggestionsQuery(database).findTagSuggestions(query, limit);
}
