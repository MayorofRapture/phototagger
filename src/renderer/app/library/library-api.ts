import type {
  LibraryPageOptionsDto,
  LibraryPageResultDto,
  LibraryQueryDto,
  ReadGeneralSettingsResultDto,
  SelectionClearResultDto,
  SelectionRefDto,
  SelectionSeedDto,
  TagSuggestionDto,
} from '../../../shared/contracts/catalog-api';
import type { IpcResult } from '../../../shared/errors/app-error';

export interface LibraryRendererApi {
  readGeneralSettings(): Promise<IpcResult<ReadGeneralSettingsResultDto>>;
  findTagSuggestions(query: string, limit?: number): Promise<IpcResult<TagSuggestionDto[]>>;
  queryLibrary(
    query: LibraryQueryDto,
    options?: LibraryPageOptionsDto
  ): Promise<IpcResult<LibraryPageResultDto>>;
  createSelection(
    queryFingerprint: string,
    seed: SelectionSeedDto
  ): Promise<IpcResult<SelectionRefDto>>;
  updateSelection(
    selectionId: string,
    photoIds: number[],
    selected: boolean
  ): Promise<IpcResult<SelectionRefDto>>;
  clearSelection(selectionId: string): Promise<IpcResult<SelectionClearResultDto>>;
}

export function createLibraryRendererApi(): LibraryRendererApi {
  return {
    readGeneralSettings: () => window.photoTagger.settings.get(),
    findTagSuggestions: (query, limit) => window.photoTagger.tags.suggest(query, limit),
    queryLibrary: (query, options) => window.photoTagger.library.query(query, options),
    createSelection: (queryFingerprint, seed) =>
      window.photoTagger.library.createSelection(queryFingerprint, seed),
    updateSelection: (selectionId, photoIds, selected) =>
      window.photoTagger.library.updateSelection(selectionId, photoIds, selected),
    clearSelection: (selectionId) => window.photoTagger.library.clearSelection(selectionId),
  };
}
