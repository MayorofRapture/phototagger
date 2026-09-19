import { ipcMain, BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { ZodType } from 'zod';
import { IPC_CHANNELS, AppBootstrapDto } from '../../shared/contracts/ipc';
import {
  LibraryQueryPayloadSchema,
  PhotoGetDetailPayloadSchema,
  SelectionClearPayloadSchema,
  SelectionCreatePayloadSchema,
  SelectionGetPayloadSchema,
  SelectionUpdatePayloadSchema,
  SettingsReadPayloadSchema,
  TagSuggestionsPayloadSchema,
  ViewSessionCreatePayloadSchema,
  ViewSessionNavigatePayloadSchema,
  type LibraryPageOptionsDto,
  type LibraryPageResultDto,
  type LibraryQueryDto,
  type LibraryViewSessionResultDto,
  type PhotoDetailDto,
  type ReadGeneralSettingsResultDto,
  type SelectionClearResultDto,
  type SelectionRefDto,
  type SelectionSeedDto,
  type TagSuggestionDto,
  type ViewNavigationDirectionDto,
} from '../../shared/contracts/catalog-api';
import { createSuccessResult, createErrorResult, IpcResult } from '../../shared/errors/app-error';
import { getBootstrapSchema, getVersionSchema } from '../../shared/validation/ipc-schemas';
import { CollectionPaths } from '../bootstrap/collection';
import { getLogger } from '../services/logger';

export interface CatalogIpcClient {
  readGeneralSettings(): Promise<ReadGeneralSettingsResultDto>;
  findTagSuggestions(query: string, limit?: number): Promise<TagSuggestionDto[]>;
  queryLibrary(
    query: LibraryQueryDto,
    options?: LibraryPageOptionsDto
  ): Promise<LibraryPageResultDto>;
  createLibrarySelection(
    queryFingerprint: string,
    seed: SelectionSeedDto
  ): Promise<SelectionRefDto>;
  updateLibrarySelection(
    selectionId: string,
    photoIds: number[],
    selected: boolean
  ): Promise<SelectionRefDto>;
  getLibrarySelection(selectionId: string): Promise<SelectionRefDto>;
  clearLibrarySelection(selectionId: string): Promise<SelectionClearResultDto>;
  getPhotoDetail(photoId: number): Promise<PhotoDetailDto>;
  createLibraryViewSession(
    queryFingerprint: string,
    selectedPhotoId: number
  ): Promise<LibraryViewSessionResultDto>;
  navigateLibraryViewSession(
    viewSessionId: string,
    direction: ViewNavigationDirectionDto
  ): Promise<LibraryViewSessionResultDto>;
}

let mainWindowInstance: BrowserWindow | null = null;

export function setMainWindow(window: BrowserWindow): void {
  mainWindowInstance = window;
}

function validateSender(event: IpcMainInvokeEvent): boolean {
  if (!mainWindowInstance) return false;
  if (event.sender !== mainWindowInstance.webContents) return false;
  if (event.senderFrame && event.senderFrame !== mainWindowInstance.webContents.mainFrame) {
    return false;
  }
  return true;
}

export function registerIpcHandlers(
  paths: CollectionPaths,
  appVersion: string,
  catalogClient: CatalogIpcClient
): void {
  const logger = getLogger();

  function registerCatalogHandler<TPayload, TResult>(
    channel: string,
    payloadSchema: ZodType<TPayload>,
    operationName: string,
    operation: (payload: TPayload) => Promise<TResult>
  ): void {
    ipcMain.handle(channel, async (event, payload): Promise<IpcResult<TResult>> => {
      if (!validateSender(event)) {
        return createErrorResult({
          code: 'UNAUTHORIZED_SENDER',
          category: 'permission',
          message: 'IPC sender verification failed',
          dataSafe: true,
          retryable: false,
          correlationId: 'ipc-' + Date.now(),
        });
      }

      const parseResult = payloadSchema.safeParse(payload);
      if (!parseResult.success) {
        return createErrorResult({
          code: 'INVALID_PAYLOAD',
          category: 'validation',
          message: `Invalid request payload for ${operationName}`,
          dataSafe: true,
          retryable: false,
          correlationId: 'ipc-' + Date.now(),
        });
      }

      try {
        return createSuccessResult(await operation(parseResult.data));
      } catch (error) {
        logger.error({ err: error, operation: operationName }, 'Catalog IPC request failed');
        return createErrorResult({
          code: 'CATALOG_REQUEST_FAILED',
          category: 'unavailable',
          message: 'The catalog could not complete the request',
          dataSafe: true,
          retryable: false,
          correlationId: 'ipc-' + Date.now(),
        });
      }
    });
  }

  ipcMain.handle(
    IPC_CHANNELS.APP_GET_BOOTSTRAP,
    async (event, payload): Promise<IpcResult<AppBootstrapDto>> => {
      if (!validateSender(event)) {
        return createErrorResult({
          code: 'UNAUTHORIZED_SENDER',
          category: 'permission',
          message: 'IPC sender verification failed',
          dataSafe: true,
          retryable: false,
          correlationId: 'ipc-' + Date.now(),
        });
      }

      const parseResult = getBootstrapSchema.safeParse(payload);
      if (!parseResult.success) {
        return createErrorResult({
          code: 'INVALID_PAYLOAD',
          category: 'validation',
          message: 'Invalid request payload for getBootstrap',
          dataSafe: true,
          retryable: false,
          correlationId: 'ipc-' + Date.now(),
        });
      }

      logger.info('Handling pt:v1:app:get-bootstrap IPC call');

      const bootstrapData: AppBootstrapDto = {
        appVersion,
        electronVersion: process.versions.electron || '44.3.0',
        nodeVersion: process.versions.node || '24.20.0',
        platform: process.platform,
        collectionDisplayPath: paths.collectionRoot,
        writeState: 'safe',
        mode: 'normal',
        counts: {
          activePhotos: 0,
          trashedPhotos: 0,
          inboxPhotos: 0,
        },
      };

      return createSuccessResult(bootstrapData);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.APP_GET_VERSION,
    async (event, payload): Promise<IpcResult<{ version: string }>> => {
      if (!validateSender(event)) {
        return createErrorResult({
          code: 'UNAUTHORIZED_SENDER',
          category: 'permission',
          message: 'IPC sender verification failed',
          dataSafe: true,
          retryable: false,
          correlationId: 'ipc-' + Date.now(),
        });
      }

      const parseResult = getVersionSchema.safeParse(payload);
      if (!parseResult.success) {
        return createErrorResult({
          code: 'INVALID_PAYLOAD',
          category: 'validation',
          message: 'Invalid request payload for getVersion',
          dataSafe: true,
          retryable: false,
          correlationId: 'ipc-' + Date.now(),
        });
      }

      logger.info('Handling pt:v1:app:get-version IPC call');
      return createSuccessResult({ version: appVersion });
    }
  );

  registerCatalogHandler(IPC_CHANNELS.SETTINGS_GET, SettingsReadPayloadSchema, 'settings.get', () =>
    catalogClient.readGeneralSettings()
  );
  registerCatalogHandler(
    IPC_CHANNELS.TAGS_SUGGEST,
    TagSuggestionsPayloadSchema,
    'tags.suggest',
    ({ query, limit }) => catalogClient.findTagSuggestions(query, limit)
  );
  registerCatalogHandler(
    IPC_CHANNELS.LIBRARY_QUERY,
    LibraryQueryPayloadSchema,
    'library.query',
    ({ query, options }) => catalogClient.queryLibrary(query, options)
  );
  registerCatalogHandler(
    IPC_CHANNELS.LIBRARY_CREATE_SELECTION,
    SelectionCreatePayloadSchema,
    'library.createSelection',
    ({ queryFingerprint, seed }) => catalogClient.createLibrarySelection(queryFingerprint, seed)
  );
  registerCatalogHandler(
    IPC_CHANNELS.LIBRARY_UPDATE_SELECTION,
    SelectionUpdatePayloadSchema,
    'library.updateSelection',
    ({ selectionId, photoIds, selected }) =>
      catalogClient.updateLibrarySelection(selectionId, photoIds, selected)
  );
  registerCatalogHandler(
    IPC_CHANNELS.LIBRARY_GET_SELECTION,
    SelectionGetPayloadSchema,
    'library.getSelection',
    ({ selectionId }) => catalogClient.getLibrarySelection(selectionId)
  );
  registerCatalogHandler(
    IPC_CHANNELS.LIBRARY_CLEAR_SELECTION,
    SelectionClearPayloadSchema,
    'library.clearSelection',
    ({ selectionId }) => catalogClient.clearLibrarySelection(selectionId)
  );
  registerCatalogHandler(
    IPC_CHANNELS.LIBRARY_CREATE_VIEW_SESSION,
    ViewSessionCreatePayloadSchema,
    'library.createViewSession',
    ({ queryFingerprint, selectedPhotoId }) =>
      catalogClient.createLibraryViewSession(queryFingerprint, selectedPhotoId)
  );
  registerCatalogHandler(
    IPC_CHANNELS.LIBRARY_NAVIGATE_VIEW,
    ViewSessionNavigatePayloadSchema,
    'library.navigateView',
    ({ viewSessionId, direction }) =>
      catalogClient.navigateLibraryViewSession(viewSessionId, direction)
  );
  registerCatalogHandler(
    IPC_CHANNELS.PHOTO_GET_DETAIL,
    PhotoGetDetailPayloadSchema,
    'photo.getDetail',
    ({ photoId }) => catalogClient.getPhotoDetail(photoId)
  );
}
