import { ipcRenderer } from 'electron';
import { IPC_CHANNELS, AppBootstrapDto, PhotoTaggerApi } from '../shared/contracts/ipc';
import { IpcResult } from '../shared/errors/app-error';

export const photoTaggerApi: PhotoTaggerApi = Object.freeze({
  app: Object.freeze({
    getBootstrap: async (): Promise<IpcResult<AppBootstrapDto>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.APP_GET_BOOTSTRAP);
    },
    getVersion: async (): Promise<IpcResult<{ version: string }>> => {
      return ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION);
    },
  }),
});
