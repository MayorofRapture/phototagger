export const IPC_CHANNELS = {
  APP_GET_BOOTSTRAP: 'pt:v1:app:get-bootstrap',
  APP_GET_VERSION: 'pt:v1:app:get-version',
  APP_OPEN_FOLDER: 'pt:v1:app:open-folder',
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
    getBootstrap: () => Promise<import('../errors/app-error').IpcResult<AppBootstrapDto>>;
    getVersion: () => Promise<import('../errors/app-error').IpcResult<{ version: string }>>;
  };
}

declare global {
  interface Window {
    photoTagger: PhotoTaggerApi;
  }
}
