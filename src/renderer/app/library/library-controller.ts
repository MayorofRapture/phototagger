import type {
  LibraryOrderDto,
  LibraryQueryDto,
  PhotoSummaryDto,
  SelectionRefDto,
  TagSuggestionDto,
} from '../../../shared/contracts/catalog-api';
import type { IpcResult } from '../../../shared/errors/app-error';
import type { LibraryRendererApi } from './library-api';
import { createLibraryQuery, deduplicatePhotos, LIBRARY_PAGE_SIZE } from './library-model';

export type LibrarySelectionMode = 'none' | 'explicit' | 'all';
export type LibraryErrorScope = 'initial' | 'incremental' | 'selection';

export interface LibraryErrorState {
  scope: LibraryErrorScope;
  message: string;
}

export interface LibraryState {
  query: LibraryQueryDto | null;
  queryFingerprint: string | null;
  photos: PhotoSummaryDto[];
  totalCount: number | null;
  nextCursor: string | null;
  isInitialLoading: boolean;
  isIncrementalLoading: boolean;
  error: LibraryErrorState | null;
  suggestionText: string;
  suggestions: TagSuggestionDto[];
  activeTagFilters: TagSuggestionDto[];
  isSuggesting: boolean;
  selection: SelectionRefDto | null;
  selectionMode: LibrarySelectionMode;
  selectionOverrides: Readonly<Record<number, boolean>>;
}

const initialState: LibraryState = {
  query: null,
  queryFingerprint: null,
  photos: [],
  totalCount: null,
  nextCursor: null,
  isInitialLoading: true,
  isIncrementalLoading: false,
  error: null,
  suggestionText: '',
  suggestions: [],
  activeTagFilters: [],
  isSuggesting: false,
  selection: null,
  selectionMode: 'none',
  selectionOverrides: {},
};

function errorMessage<T>(result: IpcResult<T>): string {
  return result.ok ? '' : result.error.message;
}

function isCurrent(generation: number, currentGeneration: number): boolean {
  return generation === currentGeneration;
}

export class LibraryController {
  private state: LibraryState = initialState;
  private readonly listeners = new Set<() => void>();
  private queryGeneration = 0;
  private suggestionGeneration = 0;
  private selectionGeneration = 0;
  private queryTransitionGeneration: number | null = null;

  constructor(private readonly api: LibraryRendererApi) {}

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getSnapshot = (): LibraryState => this.state;

  public async initialize(): Promise<void> {
    const generation = ++this.queryGeneration;
    this.setState({
      ...this.state,
      isInitialLoading: true,
      isIncrementalLoading: false,
      error: null,
      query: null,
      queryFingerprint: null,
      photos: [],
      totalCount: null,
      nextCursor: null,
      selection: null,
      selectionMode: 'none',
      selectionOverrides: {},
    });

    try {
      const settings = await this.api.readGeneralSettings();
      if (!isCurrent(generation, this.queryGeneration)) {
        return;
      }
      if (!settings.ok) {
        this.setInitialError(errorMessage(settings));
        return;
      }
      const query = createLibraryQuery(settings.data.settings.defaultOrder);
      this.setFreshQueryState(query, []);
      await this.loadFirstPage(generation, query);
    } catch {
      if (isCurrent(generation, this.queryGeneration)) {
        this.setInitialError('Library settings could not be loaded.');
      }
    }
  }

  public async addTagFilter(tag: TagSuggestionDto): Promise<void> {
    const query = this.requireQuery();
    if (!query || query.tagIds.includes(tag.tagId)) {
      return;
    }
    await this.changeQuery(
      { ...query, tagIds: [...query.tagIds, tag.tagId] },
      [...this.state.activeTagFilters, tag],
    );
    this.setState({ ...this.state, suggestionText: '', suggestions: [], isSuggesting: false });
  }

  public async removeTagFilter(tagId: number): Promise<void> {
    const query = this.requireQuery();
    if (!query || !query.tagIds.includes(tagId)) {
      return;
    }
    await this.changeQuery(
      { ...query, tagIds: query.tagIds.filter((id) => id !== tagId) },
      this.state.activeTagFilters.filter((tag) => tag.tagId !== tagId),
    );
  }

  public async setFlaggedOnly(flaggedOnly: boolean): Promise<void> {
    const query = this.requireQuery();
    if (!query || query.flaggedOnly === flaggedOnly) {
      return;
    }
    await this.changeQuery({ ...query, flaggedOnly });
  }

  public async setOrder(order: LibraryOrderDto): Promise<void> {
    const query = this.requireQuery();
    if (!query || query.order === order) {
      return;
    }
    await this.changeQuery({ ...query, order });
  }

  public async updateSuggestionText(text: string): Promise<void> {
    const generation = ++this.suggestionGeneration;
    this.setState({ ...this.state, suggestionText: text });
    if (text.trim().length === 0) {
      this.setState({ ...this.state, suggestions: [], isSuggesting: false });
      return;
    }

    this.setState({ ...this.state, isSuggesting: true });
    try {
      const result = await this.api.findTagSuggestions(text, 20);
      if (!isCurrent(generation, this.suggestionGeneration)) {
        return;
      }
      this.setState({
        ...this.state,
        suggestions: result.ok ? result.data : [],
        isSuggesting: false,
      });
    } catch {
      if (isCurrent(generation, this.suggestionGeneration)) {
        this.setState({ ...this.state, suggestions: [], isSuggesting: false });
      }
    }
  }

  public async loadNextPage(): Promise<void> {
    const { query, nextCursor, isInitialLoading, isIncrementalLoading } = this.state;
    if (!query || nextCursor === null || isInitialLoading || isIncrementalLoading) {
      return;
    }
    const generation = this.queryGeneration;
    const cursor = nextCursor;
    this.setState({ ...this.state, isIncrementalLoading: true, error: null });
    try {
      const result = await this.api.queryLibrary(query, {
        cursor,
        pageSize: LIBRARY_PAGE_SIZE,
      });
      if (!isCurrent(generation, this.queryGeneration) || this.state.nextCursor !== cursor) {
        return;
      }
      if (!result.ok) {
        this.setState({
          ...this.state,
          isIncrementalLoading: false,
          error: { scope: 'incremental', message: errorMessage(result) },
        });
        return;
      }
      this.setState({
        ...this.state,
        photos: deduplicatePhotos([...this.state.photos, ...result.data.photos]),
        totalCount: result.data.totalCount,
        nextCursor: result.data.nextCursor,
        isIncrementalLoading: false,
      });
    } catch {
      if (isCurrent(generation, this.queryGeneration) && this.state.nextCursor === cursor) {
        this.setState({
          ...this.state,
          isIncrementalLoading: false,
          error: { scope: 'incremental', message: 'More Library results could not be loaded.' },
        });
      }
    }
  }

  public async retry(): Promise<void> {
    if (this.state.error?.scope === 'incremental') {
      await this.loadNextPage();
      return;
    }
    if (this.state.query === null) {
      await this.initialize();
      return;
    }
    const generation = ++this.queryGeneration;
    const query = this.state.query;
    this.setFreshQueryState(query);
    await this.loadFirstPage(generation, query);
  }

  public async refreshCurrentQuery(): Promise<void> {
    const query = this.state.query;
    if (query === null) {
      await this.initialize();
      return;
    }
    const generation = ++this.queryGeneration;
    this.setState({
      ...this.state,
      queryFingerprint: null,
      photos: [],
      totalCount: null,
      nextCursor: null,
      isInitialLoading: true,
      isIncrementalLoading: false,
      error: null,
    });
    await this.loadFirstPage(generation, query);
  }

  public async togglePhoto(photoId: number): Promise<void> {
    const { queryFingerprint, selection } = this.state;
    if (!queryFingerprint || this.queryTransitionGeneration !== null) {
      return;
    }
    const selectionGeneration = ++this.selectionGeneration;
    const selected = !this.isPhotoSelected(photoId);
    try {
      const result = selection
        ? await this.api.updateSelection(selection.selectionId, [photoId], selected)
        : await this.api.createSelection(queryFingerprint, { type: 'one', photoId });
      if (!isCurrent(selectionGeneration, this.selectionGeneration)) {
        if (!selection && result.ok) {
          await this.discardCreatedSelection(result.data.selectionId);
        }
        return;
      }
      if (!result.ok) {
        this.setSelectionError(errorMessage(result));
        return;
      }
      const nextOverrides = { ...this.state.selectionOverrides, [photoId]: selected };
      this.setState({
        ...this.state,
        selection: result.data,
        selectionMode: selection ? this.state.selectionMode : 'explicit',
        selectionOverrides: nextOverrides,
        error: null,
      });
    } catch {
      if (isCurrent(selectionGeneration, this.selectionGeneration)) {
        this.setSelectionError('Library selection could not be updated.');
      }
    }
  }

  public async selectAll(): Promise<void> {
    const { queryFingerprint, selection } = this.state;
    if (!queryFingerprint || this.queryTransitionGeneration !== null) {
      return;
    }
    const selectionGeneration = ++this.selectionGeneration;
    try {
      if (selection) {
        const cleared = await this.api.clearSelection(selection.selectionId);
        if (!isCurrent(selectionGeneration, this.selectionGeneration)) {
          return;
        }
        if (!cleared.ok) {
          this.setSelectionError(errorMessage(cleared));
          return;
        }
        this.setState({
          ...this.state,
          selection: null,
          selectionMode: 'none',
          selectionOverrides: {},
        });
      }
      const result = await this.api.createSelection(queryFingerprint, { type: 'all' });
      if (!isCurrent(selectionGeneration, this.selectionGeneration)) {
        if (result.ok) {
          await this.discardCreatedSelection(result.data.selectionId);
        }
        return;
      }
      if (!result.ok) {
        this.setSelectionError(errorMessage(result));
        return;
      }
      this.setState({
        ...this.state,
        selection: result.data,
        selectionMode: 'all',
        selectionOverrides: {},
        error: null,
      });
    } catch {
      if (isCurrent(selectionGeneration, this.selectionGeneration)) {
        this.setSelectionError('Library selection could not be created.');
      }
    }
  }

  public async clearSelection(): Promise<void> {
    const selection = this.state.selection;
    if (!selection) {
      return;
    }
    const selectionGeneration = ++this.selectionGeneration;
    try {
      const result = await this.api.clearSelection(selection.selectionId);
      if (!isCurrent(selectionGeneration, this.selectionGeneration)) {
        return;
      }
      if (!result.ok) {
        this.setSelectionError(errorMessage(result));
        return;
      }
      this.setState({
        ...this.state,
        selection: null,
        selectionMode: 'none',
        selectionOverrides: {},
        error: null,
      });
    } catch {
      if (isCurrent(selectionGeneration, this.selectionGeneration)) {
        this.setSelectionError('Library selection could not be cleared.');
      }
    }
  }

  public isPhotoSelected(photoId: number): boolean {
    if (!this.state.selection) {
      return false;
    }
    const override = this.state.selectionOverrides[photoId];
    if (override !== undefined) {
      return override;
    }
    return this.state.selectionMode === 'all';
  }

  public dispose(): void {
    ++this.queryGeneration;
    ++this.suggestionGeneration;
    ++this.selectionGeneration;
    const selection = this.state.selection;
    if (selection) {
      void this.api.clearSelection(selection.selectionId).catch(() => undefined);
    }
    this.listeners.clear();
  }

  private async changeQuery(
    query: LibraryQueryDto,
    activeTagFilters: TagSuggestionDto[] = this.state.activeTagFilters,
  ): Promise<void> {
    const generation = ++this.queryGeneration;
    ++this.selectionGeneration;
    this.queryTransitionGeneration = generation;
    const selection = this.state.selection;
    try {
      if (selection) {
        const cleared = await this.api.clearSelection(selection.selectionId);
        if (!isCurrent(generation, this.queryGeneration)) {
          return;
        }
        if (!cleared.ok) {
          this.setSelectionError(errorMessage(cleared));
          return;
        }
      }
      if (!isCurrent(generation, this.queryGeneration)) {
        return;
      }
      this.setFreshQueryState(query, activeTagFilters);
      await this.loadFirstPage(generation, query);
    } catch {
      if (isCurrent(generation, this.queryGeneration)) {
        this.setSelectionError('Library selection could not be cleared.');
      }
    } finally {
      if (this.queryTransitionGeneration === generation) {
        this.queryTransitionGeneration = null;
      }
    }
  }

  private async discardCreatedSelection(selectionId: string): Promise<void> {
    try {
      await this.api.clearSelection(selectionId);
    } catch {
      // The obsolete selection is best-effort cleanup; it must not alter current UI state.
    }
  }

  private async loadFirstPage(generation: number, query: LibraryQueryDto): Promise<void> {
    try {
      const result = await this.api.queryLibrary(query, { pageSize: LIBRARY_PAGE_SIZE });
      if (!isCurrent(generation, this.queryGeneration)) {
        return;
      }
      if (!result.ok) {
        this.setInitialError(errorMessage(result));
        return;
      }
      this.setState({
        ...this.state,
        queryFingerprint: result.data.queryFingerprint,
        photos: deduplicatePhotos(result.data.photos),
        totalCount: result.data.totalCount,
        nextCursor: result.data.nextCursor,
        isInitialLoading: false,
        isIncrementalLoading: false,
        error: null,
      });
    } catch {
      if (isCurrent(generation, this.queryGeneration)) {
        this.setInitialError('Library results could not be loaded.');
      }
    }
  }

  private setFreshQueryState(query: LibraryQueryDto, activeTagFilters = this.state.activeTagFilters): void {
    this.setState({
      ...this.state,
      query,
      queryFingerprint: null,
      photos: [],
      totalCount: null,
      nextCursor: null,
      isInitialLoading: true,
      isIncrementalLoading: false,
      error: null,
      activeTagFilters,
      selection: null,
      selectionMode: 'none',
      selectionOverrides: {},
    });
  }

  private setInitialError(message: string): void {
    this.setState({
      ...this.state,
      isInitialLoading: false,
      isIncrementalLoading: false,
      error: { scope: 'initial', message },
    });
  }

  private setSelectionError(message: string): void {
    this.setState({ ...this.state, error: { scope: 'selection', message } });
  }

  private requireQuery(): LibraryQueryDto | null {
    return this.state.query;
  }

  private setState(nextState: LibraryState): void {
    this.state = nextState;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function knownSoleSelectedPhotoId(state: LibraryState): number | null {
  if (state.selection?.count !== 1) {
    return null;
  }
  const selectedPhotos = state.photos.filter((photo) => {
    const override = state.selectionOverrides[photo.photoId];
    return override ?? state.selectionMode === 'all';
  });
  return selectedPhotos.length === 1 ? selectedPhotos[0].photoId : null;
}
