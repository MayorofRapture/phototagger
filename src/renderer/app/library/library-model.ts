import type { LibraryOrderDto, LibraryQueryDto, PhotoSummaryDto } from '../../../shared/contracts/catalog-api';

export const LIBRARY_PAGE_SIZE = 200;
export const LIBRARY_MIN_CARD_WIDTH = 176;
export const LIBRARY_GRID_GAP = 12;

export function createLibraryQuery(order: LibraryOrderDto): LibraryQueryDto {
  return { tagIds: [], flaggedOnly: false, order };
}

export function deduplicatePhotos(photos: readonly PhotoSummaryDto[]): PhotoSummaryDto[] {
  const photoIds = new Set<number>();
  return photos.filter((photo) => {
    if (photoIds.has(photo.photoId)) {
      return false;
    }
    photoIds.add(photo.photoId);
    return true;
  });
}

export function createLibraryRows(
  photos: readonly PhotoSummaryDto[],
  columns: number
): PhotoSummaryDto[][] {
  const safeColumns = Math.max(1, Math.floor(columns));
  const rows: PhotoSummaryDto[][] = [];
  for (let index = 0; index < photos.length; index += safeColumns) {
    rows.push(photos.slice(index, index + safeColumns));
  }
  return rows;
}

export function calculateLibraryColumns(width: number): number {
  if (!Number.isFinite(width) || width <= 0) {
    return 1;
  }
  return Math.max(
    1,
    Math.floor((width + LIBRARY_GRID_GAP) / (LIBRARY_MIN_CARD_WIDTH + LIBRARY_GRID_GAP))
  );
}
