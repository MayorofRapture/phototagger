import { randomUUID } from 'crypto';
import type { CatalogDatabase } from '../migrations/schema';
import {
  IssuedLibraryQueryRegistry,
  requirePositiveSafeInteger,
} from '../library/library-query-model';
import { buildOrderedPhotoIdsWithPositionsSelect } from '../queries/library-query';
import { PhotoDetailQuery } from '../queries/photo-detail';
import type {
  LibraryViewSessionResultDto,
  ViewNavigationDirectionDto,
} from '../../shared/contracts/catalog-api';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AppStateRow {
  catalog_revision: unknown;
}

interface PositionRow {
  position: unknown;
}

interface CountRow {
  count: unknown;
}

interface MemberRow {
  photo_id: unknown;
}

interface SessionRow {
  query_fingerprint: unknown;
}

export interface LibraryViewSessionServiceOptions {
  now?: () => string;
  viewSessionId?: () => string;
}

function safeInteger(value: unknown, field: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
    throw new Error(`${field} is not a safe integer`);
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

function requireViewSessionId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('View session ID must be a UUID');
  }
  return value;
}

function requireDirection(value: unknown): ViewNavigationDirectionDto {
  if (value !== 'previous' && value !== 'next') {
    throw new Error('View navigation direction must be previous or next');
  }
  return value;
}

export class LibraryViewSessionService {
  private readonly now: () => string;
  private readonly createViewSessionId: () => string;
  private readonly photoDetails: PhotoDetailQuery;
  private readonly currentPositions = new Map<string, number>();

  constructor(
    private readonly database: CatalogDatabase,
    private readonly registry: IssuedLibraryQueryRegistry,
    options: LibraryViewSessionServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createViewSessionId = options.viewSessionId ?? randomUUID;
    this.photoDetails = new PhotoDetailQuery(database);
  }

  public createViewSession(
    queryFingerprintInput: unknown,
    selectedPhotoIdInput: unknown
  ): LibraryViewSessionResultDto {
    const issued = this.registry.requireIssued(queryFingerprintInput);
    const selectedPhotoId = requirePositiveSafeInteger(
      selectedPhotoIdInput,
      'Selected photo ID'
    );
    const create = this.database.transaction(() => {
      const viewSessionId = requireViewSessionId(this.createViewSessionId());
      const createdAt = this.now();
      if (typeof createdAt !== 'string' || createdAt.length === 0) {
        throw new Error('View session creation timestamp is invalid');
      }
      const catalogRevision = this.readCatalogRevision();
      this.database.prepare(`INSERT INTO temp.view_sessions
        (view_session_id, query_fingerprint, catalog_revision, created_at)
        VALUES (?, ?, ?, ?)`)
        .run(viewSessionId, issued.fingerprint, catalogRevision, createdAt);

      const ordered = buildOrderedPhotoIdsWithPositionsSelect(issued.query);
      this.database.prepare(`INSERT INTO temp.view_members
        (view_session_id, position, photo_id)
        SELECT @view_session_id, candidates.position, candidates.photo_id
        FROM (${ordered.sql}) AS candidates`)
        .run({ ...ordered.parameters, view_session_id: viewSessionId });

      const selected = this.database.prepare(`SELECT position
        FROM temp.view_members
        WHERE view_session_id = ? AND photo_id = ?`)
        .get(viewSessionId, selectedPhotoId) as PositionRow | undefined;
      if (!selected) {
        throw new Error('Selected photo does not belong to the Library query');
      }
      const count = this.readCount(viewSessionId);
      const position = nonNegativeInteger(selected.position, 'view_members.position');
      return {
        viewSessionId,
        position,
        count,
        detail: this.photoDetails.getPhotoDetail(selectedPhotoId),
      };
    });
    const result = create.immediate();
    this.currentPositions.set(result.viewSessionId, result.position);
    return result;
  }

  public navigateView(
    viewSessionIdInput: unknown,
    directionInput: unknown
  ): LibraryViewSessionResultDto {
    const viewSessionId = requireViewSessionId(viewSessionIdInput);
    const direction = requireDirection(directionInput);
    this.requireSession(viewSessionId);
    const currentPosition = this.currentPositions.get(viewSessionId);
    if (currentPosition === undefined) {
      throw new Error('View session is not active in this catalog process');
    }
    const count = this.readCount(viewSessionId);
    const targetPosition = currentPosition + (direction === 'next' ? 1 : -1);
    if (targetPosition < 0 || targetPosition >= count) {
      throw new Error(
        direction === 'next'
          ? 'View session is already at the final member'
          : 'View session is already at the first member'
      );
    }
    const member = this.database.prepare(`SELECT photo_id
      FROM temp.view_members
      WHERE view_session_id = ? AND position = ?`)
      .get(viewSessionId, targetPosition) as MemberRow | undefined;
    if (!member) {
      throw new Error('View session membership is incomplete');
    }
    const photoId = safeInteger(member.photo_id, 'view_members.photo_id');
    if (photoId <= 0) {
      throw new Error('view_members.photo_id must be positive');
    }
    const detail = this.photoDetails.getPhotoDetail(photoId);
    this.currentPositions.set(viewSessionId, targetPosition);
    return { viewSessionId, position: targetPosition, count, detail };
  }

  private readCatalogRevision(): number {
    const row = this.database.prepare(
      'SELECT catalog_revision FROM app_state WHERE singleton = 1'
    ).get() as AppStateRow | undefined;
    if (!row) {
      throw new Error('View session creation requires the app_state singleton');
    }
    return nonNegativeInteger(row.catalog_revision, 'app_state.catalog_revision');
  }

  private readCount(viewSessionId: string): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS count
      FROM temp.view_members
      WHERE view_session_id = ?`).get(viewSessionId) as CountRow;
    const count = nonNegativeInteger(row.count, 'View session member count');
    if (count === 0) {
      throw new Error('View session has no members');
    }
    return count;
  }

  private requireSession(viewSessionId: string): void {
    const row = this.database.prepare(`SELECT query_fingerprint
      FROM temp.view_sessions
      WHERE view_session_id = ?`).get(viewSessionId) as SessionRow | undefined;
    if (!row || typeof row.query_fingerprint !== 'string') {
      throw new Error('View session was not found');
    }
    this.registry.requireIssued(row.query_fingerprint);
  }
}
