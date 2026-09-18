import { describe, expect, it } from 'vitest';
import type { PhotoSummaryDto } from '../../src/shared/contracts/catalog-api';
import {
  calculateLibraryColumns,
  createLibraryQuery,
  createLibraryRows,
  deduplicatePhotos,
} from '../../src/renderer/app/library/library-model';

function photo(photoId: number): PhotoSummaryDto {
  return {
    photoId,
    canonicalFilename: `${photoId}.jpg`,
    originalFilename: `${photoId}.jpg`,
    flagged: false,
    integrityState: 'clean',
    width: 100,
    height: 100,
    contentRevision: 1,
    thumbnailRevision: 1,
    thumbnailUrl: `pt-photo://thumb/${photoId}?thumb=1`,
  };
}

describe('Library renderer model', () => {
  it('creates the expected initial Library query from the persisted default order', () => {
    expect(createLibraryQuery('oldest-imported')).toEqual({
      tagIds: [],
      flaggedOnly: false,
      order: 'oldest-imported',
    });
  });

  it('deduplicates paged photos without changing the first-seen ordering', () => {
    expect(deduplicatePhotos([photo(4), photo(2), photo(4), photo(9)]).map(({ photoId }) => photoId))
      .toEqual([4, 2, 9]);
  });

  it('creates rows from the current responsive column count', () => {
    expect(createLibraryRows([photo(1), photo(2), photo(3), photo(4), photo(5)], 2)
      .map((row) => row.map(({ photoId }) => photoId)))
      .toEqual([[1, 2], [3, 4], [5]]);
  });

  it('derives a safe positive column count from ResizeObserver dimensions', () => {
    expect(calculateLibraryColumns(0)).toBe(1);
    expect(calculateLibraryColumns(176)).toBe(1);
    expect(calculateLibraryColumns(364)).toBe(2);
  });
});
