import { app, BrowserWindow } from 'electron';
import {
  resolvePortableRoot,
  resolveCollectionPaths,
  configureElectronPaths,
  initializeCollectionDirectories,
} from './bootstrap/collection';
import { configureSecurityPolicies, attachWindowSecurityHandlers } from './bootstrap/security';
import { initLogger } from './services/logger';
import { registerIpcHandlers, setMainWindow } from './ipc/register';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Single instance enforcement
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// Bootstrap portable collection paths before app is ready
const portableRoot = resolvePortableRoot();
const collectionPaths = resolveCollectionPaths(portableRoot);

// Ensure directories exist
initializeCollectionDirectories(collectionPaths);

// Configure Electron user data & logs paths
configureElectronPaths(collectionPaths);

// Initialize Pino logger
const logger = initLogger(collectionPaths.logs);
logger.info('Starting PhotoTagger main process. Version: %s', app.getVersion());

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'PhotoTagger',
    webPreferences: {
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      devTools: !app.isPackaged,
      spellcheck: false,
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  setMainWindow(mainWindow);
  attachWindowSecurityHandlers(mainWindow);

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  mainWindow.on('closed', () => {
    setMainWindow(null as unknown as BrowserWindow);
  });
};

app.whenReady().then(() => {
  configureSecurityPolicies();
  registerIpcHandlers(collectionPaths, app.getVersion() || '1.0.0');
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
