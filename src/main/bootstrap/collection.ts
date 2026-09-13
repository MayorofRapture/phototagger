import { app } from 'electron';
import path from 'path';
import fs from 'fs';

export interface CollectionPaths {
  portableRoot: string;
  collectionRoot: string;
  inbox: string;
  storage: string;
  thumbnails: string;
  trashPhotos: string;
  trashThumbnails: string;
  failed: string;
  recovery: string;
  workingImport: string;
  workingMetadata: string;
  workingBackups: string;
  workingRestore: string;
  data: string;
  dataBackupsAutomatic: string;
  dataBackupsSafety: string;
  dataBackupsManual: string;
  logs: string;
  electronData: string;
}

export function resolvePortableRoot(): string {
  if (process.env.PHOTOTAGGER_TEST_ROOT) {
    return path.resolve(process.env.PHOTOTAGGER_TEST_ROOT);
  }
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }
  return app.getAppPath();
}

export function resolveCollectionPaths(portableRoot: string): CollectionPaths {
  const collectionRoot = path.join(portableRoot, 'Collection');

  return {
    portableRoot,
    collectionRoot,
    inbox: path.join(collectionRoot, 'Inbox'),
    storage: path.join(collectionRoot, 'Storage'),
    thumbnails: path.join(collectionRoot, 'Thumbnails'),
    trashPhotos: path.join(collectionRoot, 'Trash', 'Photos'),
    trashThumbnails: path.join(collectionRoot, 'Trash', 'Thumbnails'),
    failed: path.join(collectionRoot, 'Failed'),
    recovery: path.join(collectionRoot, 'Recovery'),
    workingImport: path.join(collectionRoot, 'Working', 'Import'),
    workingMetadata: path.join(collectionRoot, 'Working', 'Metadata'),
    workingBackups: path.join(collectionRoot, 'Working', 'Backups'),
    workingRestore: path.join(collectionRoot, 'Working', 'Restore'),
    data: path.join(collectionRoot, 'Data'),
    dataBackupsAutomatic: path.join(collectionRoot, 'Data', 'Backups', 'Automatic'),
    dataBackupsSafety: path.join(collectionRoot, 'Data', 'Backups', 'Safety'),
    dataBackupsManual: path.join(collectionRoot, 'Data', 'Backups', 'Manual'),
    logs: path.join(collectionRoot, 'Data', 'Logs'),
    electronData: path.join(collectionRoot, 'Data', 'Electron'),
  };
}

export function configureElectronPaths(paths: CollectionPaths): void {
  const userDataPath = path.join(paths.electronData, 'UserData');
  const sessionDataPath = path.join(paths.electronData, 'SessionData');
  const crashDumpsPath = path.join(paths.electronData, 'CrashDumps');

  app.setPath('userData', userDataPath);
  app.setPath('sessionData', sessionDataPath);
  app.setPath('logs', paths.logs);
  app.setPath('crashDumps', crashDumpsPath);
}

export function initializeCollectionDirectories(paths: CollectionPaths): void {
  const requiredDirs = [
    paths.collectionRoot,
    paths.inbox,
    paths.storage,
    paths.thumbnails,
    paths.trashPhotos,
    paths.trashThumbnails,
    paths.failed,
    paths.recovery,
    paths.workingImport,
    paths.workingMetadata,
    paths.workingBackups,
    paths.workingRestore,
    paths.data,
    paths.dataBackupsAutomatic,
    paths.dataBackupsSafety,
    paths.dataBackupsManual,
    paths.logs,
    paths.electronData,
  ];

  for (const dir of requiredDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
