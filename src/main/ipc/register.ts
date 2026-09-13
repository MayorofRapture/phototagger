import { ipcMain, BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, AppBootstrapDto } from '../../shared/contracts/ipc';
import { createSuccessResult, createErrorResult, IpcResult } from '../../shared/errors/app-error';
import { getBootstrapSchema, getVersionSchema } from '../../shared/validation/ipc-schemas';
import { CollectionPaths } from '../bootstrap/collection';
import { getLogger } from '../services/logger';

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

export function registerIpcHandlers(paths: CollectionPaths, appVersion: string): void {
  const logger = getLogger();

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
}
