import type { CatalogDatabase } from '../migrations/schema';
import {
  PhotoDetailDtoSchema,
  type PhotoDetailDto,
  type TagPathDto,
} from '../../shared/contracts/catalog-api';
import { requirePositiveSafeInteger } from '../library/library-query-model';

type MetadataJobState =
  | 'pending'
  | 'debouncing'
  | 'writing'
  | 'failed'
  | 'suspended'
  | 'completed_warning';

interface PhotoDetailRow {
  photo_id: unknown;
  original_filename: unknown;
  lifecycle_state: unknown;
  integrity_state: unknown;
  flagged: unknown;
  width: unknown;
  height: unknown;
  content_revision: unknown;
  thumbnail_revision: unknown;
  desired_metadata_revision: unknown;
  synced_metadata_revision: unknown;
  metadata_warning_code: unknown;
  imported_at: unknown;
  last_verified_at: unknown;
  metadata_job_state: unknown;
}

interface TagPathRow {
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
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
    throw new Error(`${field} is not a safe integer`);
  }
  return number;
}

function positiveInteger(value: unknown, field: string): number {
  const number = safeInteger(value, field);
  if (number <= 0) {
    throw new Error(`${field} must be positive`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const number = safeInteger(value, field);
  if (number < 0) {
    throw new Error(`${field} must not be negative`);
  }
  return number;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be non-empty text`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  const number = safeInteger(value, field);
  if (number !== 0 && number !== 1) {
    throw new Error(`${field} must be 0 or 1`);
  }
  return number === 1;
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value === null ? null : positiveInteger(value, field);
}

function metadataState(
  jobStateValue: unknown,
  desiredRevision: number,
  syncedRevision: number,
  warningCode: unknown
): PhotoDetailDto['metadataState'] {
  if (jobStateValue !== null) {
    if (
      typeof jobStateValue !== 'string' ||
      !['pending', 'debouncing', 'writing', 'failed', 'suspended', 'completed_warning']
        .includes(jobStateValue)
    ) {
      throw new Error('metadata_jobs.state is invalid');
    }
    const jobState = jobStateValue as MetadataJobState;
    switch (jobState) {
      case 'pending':
      case 'debouncing':
        return 'pending';
      case 'writing':
        return 'writing';
      case 'failed':
        return 'failed';
      case 'suspended':
        return 'suspended_conflict';
      case 'completed_warning':
        return 'synchronized_with_warning';
    }
  }
  if (desiredRevision > syncedRevision) {
    return 'pending';
  }
  if (warningCode !== null) {
    text(warningCode, 'photos.metadata_warning_code');
    return 'synchronized_with_warning';
  }
  return 'synchronized';
}

function toTagPath(row: TagPathRow): TagPathDto {
  return {
    tagId: positiveInteger(row.tag_id, 'tags.tag_id'),
    parentTagId: nullablePositiveInteger(row.parent_tag_id, 'tags.parent_tag_id'),
    displayName: text(row.display_name, 'tags.display_name'),
    fullPath: text(row.full_path, 'tag_paths.path_display'),
    depth: positiveInteger(row.depth, 'tag_paths.depth'),
    childCount: nonNegativeInteger(row.child_count, 'tag child count'),
    pinned: boolean(row.pinned, 'palette membership'),
    legacyFlatOnly: boolean(row.legacy_flat_only, 'tags.legacy_flat_only'),
  };
}

export class PhotoDetailQuery {
  constructor(private readonly database: CatalogDatabase) {}

  public getPhotoDetail(photoIdInput: unknown): PhotoDetailDto {
    const photoId = requirePositiveSafeInteger(photoIdInput, 'Photo ID');
    const row = this.database.prepare(`
      SELECT
        p.photo_id,
        p.original_filename,
        p.lifecycle_state,
        p.integrity_state,
        p.flagged,
        p.width,
        p.height,
        p.content_revision,
        p.thumbnail_revision,
        p.desired_metadata_revision,
        p.synced_metadata_revision,
        p.metadata_warning_code,
        p.imported_at,
        p.last_verified_at,
        mj.state AS metadata_job_state
      FROM photos AS p
      LEFT JOIN metadata_jobs AS mj ON mj.photo_id = p.photo_id
      WHERE p.photo_id = ?
        AND p.lifecycle_state IN ('active', 'trashed')
    `).get(photoId) as PhotoDetailRow | undefined;
    if (!row) {
      throw new Error('Photo was not found');
    }

    const id = positiveInteger(row.photo_id, 'photos.photo_id');
    const integrityState = text(row.integrity_state, 'photos.integrity_state') as PhotoDetailDto['integrityState'];
    const lifecycleState = text(row.lifecycle_state, 'photos.lifecycle_state') as PhotoDetailDto['lifecycleState'];
    const contentRevision = positiveInteger(row.content_revision, 'photos.content_revision');
    const thumbnailRevision = positiveInteger(row.thumbnail_revision, 'photos.thumbnail_revision');
    const desiredMetadataRevision = nonNegativeInteger(
      row.desired_metadata_revision,
      'photos.desired_metadata_revision'
    );
    const syncedMetadataRevision = nonNegativeInteger(
      row.synced_metadata_revision,
      'photos.synced_metadata_revision'
    );
    const explicitTags = this.database.prepare(`
      SELECT
        t.tag_id,
        t.parent_tag_id,
        t.display_name,
        tp.path_display AS full_path,
        tp.depth,
        (
          SELECT COUNT(*)
          FROM tags AS child
          WHERE child.parent_tag_id = t.tag_id
        ) AS child_count,
        CASE WHEN pe.tag_id IS NULL THEN 0 ELSE 1 END AS pinned,
        t.legacy_flat_only
      FROM photo_tags AS pt
      JOIN tags AS t ON t.tag_id = pt.tag_id
      JOIN tag_paths AS tp ON tp.tag_id = t.tag_id
      LEFT JOIN palette_entries AS pe ON pe.tag_id = t.tag_id
      WHERE pt.photo_id = ?
      ORDER BY tp.path_key, t.tag_id
    `).all(photoId) as TagPathRow[];

    const detail: PhotoDetailDto = {
      photoId: id,
      canonicalFilename: `${String(id).padStart(10, '0')}.jpg`,
      originalFilename: text(row.original_filename, 'photos.original_filename'),
      flagged: boolean(row.flagged, 'photos.flagged'),
      integrityState,
      width: positiveInteger(row.width, 'photos.width'),
      height: positiveInteger(row.height, 'photos.height'),
      contentRevision,
      thumbnailRevision,
      thumbnailUrl: `pt-photo://thumb/${id}?thumb=${thumbnailRevision}`,
      lifecycleState,
      ...(integrityState === 'clean'
        ? { fullImageUrl: `pt-photo://full/${id}?content=${contentRevision}` }
        : {}),
      explicitTags: explicitTags.map(toTagPath),
      desiredMetadataRevision,
      syncedMetadataRevision,
      metadataState: metadataState(
        row.metadata_job_state,
        desiredMetadataRevision,
        syncedMetadataRevision,
        row.metadata_warning_code
      ),
      importedAt: text(row.imported_at, 'photos.imported_at'),
      ...(row.last_verified_at === null
        ? {}
        : { lastVerifiedAt: text(row.last_verified_at, 'photos.last_verified_at') }),
    };
    return PhotoDetailDtoSchema.parse(detail);
  }
}

