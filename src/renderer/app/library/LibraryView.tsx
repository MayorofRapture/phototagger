import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LibraryOrderDto, PhotoSummaryDto } from '../../../shared/contracts/catalog-api';
import { LibraryController, type LibraryState } from './library-controller';
import {
  calculateLibraryColumns,
  createLibraryRows,
  LIBRARY_GRID_GAP,
} from './library-model';

const SORT_OPTIONS: Array<{ value: LibraryOrderDto; label: string }> = [
  { value: 'newest-imported', label: 'Newest imported' },
  { value: 'oldest-imported', label: 'Oldest imported' },
  { value: 'original-filename-asc', label: 'Original filename A-Z' },
  { value: 'original-filename-desc', label: 'Original filename Z-A' },
];

export function LibraryView({
  controller,
  state,
  hidden = false,
}: {
  controller: LibraryController;
  state: LibraryState;
  hidden?: boolean;
}): ReactElement {
  return (
    <section className="library-view" aria-label="Library View" hidden={hidden}>
      <LibraryFilters controller={controller} state={state} />
      <LibrarySelectionControls controller={controller} state={state} />
      {state.error?.scope === 'initial' ? (
        <LibraryError message={state.error.message} onRetry={() => void controller.retry()} />
      ) : (
        <>
          {state.error?.scope === 'selection' && (
            <div className="selection-error" role="alert">{state.error.message}</div>
          )}
          <ThumbnailGrid controller={controller} state={state} />
        </>
      )}
    </section>
  );
}

function LibraryFilters({ controller, state }: { controller: LibraryController; state: LibraryState }): ReactElement {
  const query = state.query;

  return (
    <div className="library-filters">
      <div className="tag-filter-control">
        <label htmlFor="library-tag-filter">Filter tags</label>
        <input
          id="library-tag-filter"
          value={state.suggestionText}
          disabled={query === null}
          placeholder="Search tags"
          autoComplete="off"
          onChange={(event) => void controller.updateSuggestionText(event.target.value)}
          aria-controls="library-tag-suggestions"
          aria-expanded={state.suggestions.length > 0}
        />
        {state.isSuggesting && <span className="field-progress">Searching…</span>}
        {state.suggestions.length > 0 && (
          <ul id="library-tag-suggestions" className="tag-suggestions" role="listbox">
            {state.suggestions.map((suggestion) => (
              <li key={suggestion.tagId} role="option" aria-selected="false">
                <button type="button" onClick={() => void controller.addTagFilter(suggestion)}>
                  {suggestion.fullPath}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="active-tag-filters" aria-label="Active tag filters">
        {state.activeTagFilters.map((tag) => {
          return (
            <button
              key={tag.tagId}
              type="button"
              className="tag-filter-pill"
              onClick={() => void controller.removeTagFilter(tag.tagId)}
              title="Remove tag filter"
            >
              {tag.fullPath} <span aria-hidden="true">×</span>
            </button>
          );
        })}
      </div>

      <label className="flag-filter">
        <input
          type="checkbox"
          checked={query?.flaggedOnly ?? false}
          disabled={query === null}
          onChange={(event) => void controller.setFlaggedOnly(event.target.checked)}
        />
        Flagged only
      </label>

      <label className="sort-control" htmlFor="library-order">
        Order
        <select
          id="library-order"
          value={query?.order ?? ''}
          disabled={query === null}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            void controller.setOrder(event.target.value as LibraryOrderDto)
          }
        >
          {query === null && <option value="">Loading order…</option>}
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function LibrarySelectionControls({
  controller,
  state,
}: {
  controller: LibraryController;
  state: LibraryState;
}): ReactElement {
  const canSelect = state.queryFingerprint !== null;
  const totalCount = state.totalCount ?? 0;
  const selectedCount = state.selection?.count ?? 0;

  return (
    <div className="library-selection-controls">
      <div className="selection-actions">
        <button type="button" disabled={!canSelect} onClick={() => void controller.selectAll()}>
          Select All
        </button>
        <button type="button" disabled={state.selection === null} onClick={() => void controller.clearSelection()}>
          Unselect All
        </button>
      </div>
      <div className="library-counts" aria-live="polite">
        <span>{totalCount} {totalCount === 1 ? 'result' : 'results'}</span>
        <span>{selectedCount} selected</span>
      </div>
    </div>
  );
}

function ThumbnailGrid({ controller, state }: { controller: LibraryController; state: LibraryState }): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const [gridHeight, setGridHeight] = useState(0);
  const columns = calculateLibraryColumns(gridWidth);
  const rows = useMemo(() => createLibraryRows(state.photos, columns), [state.photos, columns]);
  const cardWidth = Math.max(1, (gridWidth - LIBRARY_GRID_GAP * (columns - 1)) / columns);
  const rowHeight = Math.max(218, Math.round(cardWidth * 1.17));
  const rowCount = rows.length + (state.isIncrementalLoading ? 1 : 0);
  const overscanRows = Math.max(1, Math.ceil(gridHeight / rowHeight) * 2);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight + LIBRARY_GRID_GAP,
    overscan: overscanRows,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return undefined;
    }
    const updateGridSize = (): void => {
      setGridWidth(element.clientWidth);
      setGridHeight(element.clientHeight);
    };
    updateGridSize();
    const observer = new ResizeObserver(updateGridSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [state.isInitialLoading]);

  useEffect(() => {
    const finalVirtualRow = virtualRows[virtualRows.length - 1];
    if (
      finalVirtualRow &&
      rows.length > 0 &&
      finalVirtualRow.index >= rows.length - 3 &&
      state.nextCursor !== null
    ) {
      void controller.loadNextPage();
    }
  }, [controller, rows.length, state.nextCursor, virtualRows]);

  if (state.isInitialLoading && state.photos.length === 0) {
    return <InitialGridSkeleton />;
  }

  if (state.totalCount === 0) {
    const filtered = state.query !== null &&
      (state.query.flaggedOnly || state.query.tagIds.length > 0);
    return (
      <div className="library-message empty-state">
        {filtered ? 'No photos match the current filters.' : 'No photos are in the Library yet.'}
      </div>
    );
  }

  return (
    <div className="library-grid-scroll" ref={scrollRef} aria-label="Library thumbnails">
      <div className="library-grid-virtual-space" style={{ height: rowVirtualizer.getTotalSize() }}>
        {virtualRows.map((virtualRow) => {
          const isLoadingRow = virtualRow.index === rows.length;
          return (
            <div
              key={virtualRow.key}
              className="library-grid-row"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
                minHeight: rowHeight,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {isLoadingRow ? (
                <div className="incremental-loading">Loading more photos…</div>
              ) : (
                rows[virtualRow.index].map((photo) => (
                  <ThumbnailCard
                    key={photo.photoId}
                    photo={photo}
                    selected={controller.isPhotoSelected(photo.photoId)}
                    onToggle={() => void controller.togglePhoto(photo.photoId)}
                  />
                ))
              )}
            </div>
          );
        })}
      </div>
      {state.error?.scope === 'incremental' && (
        <div className="incremental-error" role="alert">
          <span>{state.error.message}</span>
          <button type="button" onClick={() => void controller.retry()}>Retry</button>
        </div>
      )}
    </div>
  );
}

function ThumbnailCard({
  photo,
  selected,
  onToggle,
}: {
  photo: PhotoSummaryDto;
  selected: boolean;
  onToggle: () => void;
}): ReactElement {
  const [imageState, setImageState] = useState<'loading' | 'loaded' | 'broken'>('loading');
  const hasIntegrityWarning = photo.integrityState !== 'clean';

  return (
    <button
      type="button"
      className={`thumbnail-card${selected ? ' is-selected' : ''}${hasIntegrityWarning ? ' has-warning' : ''}`}
      aria-pressed={selected}
      aria-label={`${photo.originalFilename}${selected ? ', selected' : ''}`}
      onClick={onToggle}
    >
      <div className="thumbnail-media">
        {imageState !== 'broken' && (
          <img
            src={photo.thumbnailUrl}
            alt=""
            onLoad={() => setImageState('loaded')}
            onError={() => setImageState('broken')}
            className={imageState === 'loaded' ? 'thumbnail-image loaded' : 'thumbnail-image'}
          />
        )}
        {imageState !== 'loaded' && (
          <span className="thumbnail-placeholder" aria-label="Thumbnail unavailable" role="img">▧</span>
        )}
        {photo.flagged && <span className="flag-marker" aria-label="Flagged">⚑</span>}
        {hasIntegrityWarning && (
          <span className="integrity-marker" aria-label={`Integrity warning: ${photo.integrityState}`}>!</span>
        )}
      </div>
      <span className="thumbnail-filename" title={photo.originalFilename}>{photo.originalFilename}</span>
    </button>
  );
}

function InitialGridSkeleton(): ReactElement {
  return (
    <div className="library-grid-skeleton" aria-label="Loading Library results">
      {Array.from({ length: 12 }, (_, index) => <div key={index} className="thumbnail-skeleton" />)}
    </div>
  );
}

function LibraryError({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
  return (
    <div className="library-message library-error" role="alert">
      <p>{message}</p>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}
