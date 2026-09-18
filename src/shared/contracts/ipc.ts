import type {
  LibraryPageOptionsDto,
  LibraryPageResultDto,
  LibraryQueryDto,
  ReadGeneralSettingsResultDto,
  SelectionClearResultDto,
  SelectionRefDto,
  SelectionSeedDto,
  TagSuggestionDto,
} from './catalog-api';
import type { IpcResult } from '../errors/app-error';

export const IPC_CHANNELS = {
  APP_GET_BOOTSTRAP: 'pt:v1:app:get-bootstrap',
  APP_GET_VERSION: 'pt:v1:app:get-version',
  APP_OPEN_FOLDER: 'pt:v1:app:open-folder',
  SETTINGS_GET: 'pt:v1:settings:get',
  TAGS_SUGGEST: 'pt:v1:tags:suggest',
  LIBRARY_QUERY: 'pt:v1:library:query',
  LIBRARY_CREATE_SELECTION: 'pt:v1:library:create-selection',
  LIBRARY_UPDATE_SELECTION: 'pt:v1:library:update-selection',
  LIBRARY_GET_SELECTION: 'pt:v1:library:get-selection',
  LIBRARY_CLEAR_SELECTION: 'pt:v1:library:clear-selection',
} as const;

export interface AppBootstrapDto {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: string;
  collectionDisplayPath: string;
  writeState: 'safe' | 'writing';
  mode: 'normal' | 'recovery' | 'read-only';
  counts: {
    activePhotos: number;
    trashedPhotos: number;
    inboxPhotos: number;
  };
}

export interface PhotoTaggerApi {
  app: {
    getBootstrap: () => Promise<IpcResult<AppBootstrapDto>>;
    getVersion: () => Promise<IpcResult<{ version: string }>>;
  };
  settings: {
    get: () => Promise<IpcResult<ReadGeneralSettingsResultDto>>;
  };
  tags: {
    suggest: (query: string, limit?: number) => Promise<IpcResult<TagSuggestionDto[]>>;
  };
  library: {
    query: (
      query: LibraryQueryDto,
      options?: LibraryPageOptionsDto
    ) => Promise<IpcResult<LibraryPageResultDto>>;
    createSelection: (
      queryFingerprint: string,
      seed: SelectionSeedDto
    ) => Promise<IpcResult<SelectionRefDto>>;
    updateSelection: (
      selectionId: string,
      photoIds: number[],
      selected: boolean
    ) => Promise<IpcResult<SelectionRefDto>>;
    getSelection: (selectionId: string) => Promise<IpcResult<SelectionRefDto>>;
    clearSelection: (selectionId: string) => Promise<IpcResult<SelectionClearResultDto>>;
  };
}

declare global {
  interface Window {
    photoTagger: PhotoTaggerApi;
  }
}
