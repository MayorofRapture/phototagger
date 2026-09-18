import { createHash } from 'crypto';

export const LibraryOrders = [
  'newest-imported',
  'oldest-imported',
  'original-filename-asc',
  'original-filename-desc',
] as const;

export type LibraryOrder = (typeof LibraryOrders)[number];

export interface LibraryQuery {
  tagIds: number[];
  flaggedOnly: boolean;
  order: LibraryOrder;
}

export interface IssuedLibraryQuery {
  query: LibraryQuery;
  canonicalJson: string;
  fingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

export function isLibraryOrder(value: unknown): value is LibraryOrder {
  return typeof value === 'string' && (LibraryOrders as readonly string[]).includes(value);
}

export function requirePositiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

export function normalizeLibraryQuery(input: unknown): LibraryQuery {
  if (!isRecord(input) || !hasExactKeys(input, ['tagIds', 'flaggedOnly', 'order'])) {
    throw new Error('Library query must contain only tagIds, flaggedOnly, and order');
  }
  if (!Array.isArray(input.tagIds)) {
    throw new Error('Library query tagIds must be an array');
  }
  if (typeof input.flaggedOnly !== 'boolean') {
    throw new Error('Library query flaggedOnly must be a boolean');
  }
  if (!isLibraryOrder(input.order)) {
    throw new Error('Library query order is invalid');
  }

  const tagIds = input.tagIds.map((tagId, index) =>
    requirePositiveSafeInteger(tagId, `Library query tagIds[${index}]`)
  );
  const normalizedTagIds = [...new Set(tagIds)].sort((left, right) => left - right);
  return {
    tagIds: normalizedTagIds,
    flaggedOnly: input.flaggedOnly,
    order: input.order,
  };
}

export function canonicalizeLibraryQuery(query: LibraryQuery): string {
  return `{"flaggedOnly":${query.flaggedOnly},"order":${JSON.stringify(query.order)},"tagIds":[${query.tagIds.join(',')}]}`;
}

export function fingerprintLibraryQuery(query: LibraryQuery): string {
  return createHash('sha256')
    .update(canonicalizeLibraryQuery(query), 'utf8')
    .digest('hex');
}

export function requireQueryFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Library query fingerprint must be lowercase SHA-256 hexadecimal');
  }
  return value;
}

export class IssuedLibraryQueryRegistry {
  private readonly queries = new Map<string, IssuedLibraryQuery>();
  private readonly cursors = new Set<string>();

  public issue(query: LibraryQuery): IssuedLibraryQuery {
    const canonicalJson = canonicalizeLibraryQuery(query);
    const fingerprint = fingerprintLibraryQuery(query);
    const existing = this.queries.get(fingerprint);
    if (existing && existing.canonicalJson !== canonicalJson) {
      throw new Error('Library query fingerprint collision');
    }
    const issued = existing ?? {
      query: {
        tagIds: [...query.tagIds],
        flaggedOnly: query.flaggedOnly,
        order: query.order,
      },
      canonicalJson,
      fingerprint,
    };
    this.queries.set(fingerprint, issued);
    return issued;
  }

  public requireIssued(fingerprintInput: unknown): IssuedLibraryQuery {
    const fingerprint = requireQueryFingerprint(fingerprintInput);
    const issued = this.queries.get(fingerprint);
    if (!issued) {
      throw new Error('Library query fingerprint was not issued by this process');
    }
    return issued;
  }

  public issueCursor(cursor: string): void {
    this.cursors.add(cursor);
  }

  public requireIssuedCursor(cursor: string): void {
    if (!this.cursors.has(cursor)) {
      throw new Error('Library cursor was not issued by this process');
    }
  }
}
