import { ipcRenderer } from 'electron';
import type { ZodType } from 'zod';
import { IPC_CHANNELS, AppBootstrapDto, PhotoTaggerApi } from '../shared/contracts/ipc';
import {
  LibraryQueryPayloadSchema,
  SelectionClearPayloadSchema,
  SelectionCreatePayloadSchema,
  SelectionGetPayloadSchema,
  SelectionUpdatePayloadSchema,
  SettingsReadPayloadSchema,
  TagSuggestionsPayloadSchema,
  type LibraryPageOptionsDto,
  type LibraryPageResultDto,
  type LibraryQueryDto,
  type LibraryQueryPayload,
  type ReadGeneralSettingsResultDto,
  type SelectionClearResultDto,
  type SelectionCreatePayload,
  type SelectionGetPayload,
  type SelectionRefDto,
  type SelectionSeedDto,
  type SelectionUpdatePayload,
  type TagSuggestionDto,
  type TagSuggestionsPayload,
} from '../shared/contracts/catalog-api';
import { createErrorResult, IpcResult } from '../shared/errors/app-error';

async function invokeCatalog<TPayload, TResult>(
  channel: string,
  schema: ZodType<TPayload>,
  payload: TPayload
): Promise<IpcResult<TResult>> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return createErrorResult({
      code: 'INVALID_PAYLOAD',
      category: 'validation',
      message: 'Invalid catalog request payload',
      dataSafe: true,
      retryable: false,
      correlationId: 'preload-' + Date.now(),
    });
  }
  return ipcRenderer.invoke(channel, parsed.data) as Promise<IpcResult<TResult>>;
}

export const photoTaggerApi: PhotoTaggerApi = Object.freeze({
  app: Object.freeze({
    getBootstrap: async (): Promise<IpcResult<AppBootstrapDto>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.APP_GET_BOOTSTRAP);
    },
    getVersion: async (): Promise<IpcResult<{ version: string }>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION);
    },
  }),
  settings: Object.freeze({
    get: async () =>
      invokeCatalog<Record<string, never>, ReadGeneralSettingsResultDto>(
        IPC_CHANNELS.SETTINGS_GET,
        SettingsReadPayloadSchema,
        {}
      ),
  }),
  tags: Object.freeze({
    suggest: async (query: string, limit?: number) =>
      invokeCatalog<TagSuggestionsPayload, TagSuggestionDto[]>(
        IPC_CHANNELS.TAGS_SUGGEST,
        TagSuggestionsPayloadSchema,
        limit === undefined ? { query } : { query, limit }
      ),
  }),
  library: Object.freeze({
    query: async (query: LibraryQueryDto, options?: LibraryPageOptionsDto) =>
      invokeCatalog<LibraryQueryPayload, LibraryPageResultDto>(
        IPC_CHANNELS.LIBRARY_QUERY,
        LibraryQueryPayloadSchema,
        options === undefined ? { query } : { query, options }
      ),
    createSelection: async (queryFingerprint: string, seed: SelectionSeedDto) =>
      invokeCatalog<SelectionCreatePayload, SelectionRefDto>(
        IPC_CHANNELS.LIBRARY_CREATE_SELECTION,
        SelectionCreatePayloadSchema,
        { queryFingerprint, seed }
      ),
    updateSelection: async (selectionId: string, photoIds: number[], selected: boolean) =>
      invokeCatalog<SelectionUpdatePayload, SelectionRefDto>(
        IPC_CHANNELS.LIBRARY_UPDATE_SELECTION,
        SelectionUpdatePayloadSchema,
        { selectionId, photoIds, selected }
      ),
    getSelection: async (selectionId: string) =>
      invokeCatalog<SelectionGetPayload, SelectionRefDto>(
        IPC_CHANNELS.LIBRARY_GET_SELECTION,
        SelectionGetPayloadSchema,
        { selectionId }
      ),
    clearSelection: async (selectionId: string) =>
      invokeCatalog<SelectionGetPayload, SelectionClearResultDto>(
        IPC_CHANNELS.LIBRARY_CLEAR_SELECTION,
        SelectionClearPayloadSchema,
        { selectionId }
      ),
  }),
});
