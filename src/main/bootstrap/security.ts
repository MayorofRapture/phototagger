import { app, session, BrowserWindow } from 'electron';

export function configureSecurityPolicies(): void {
  const isDevelopment = !app.isPackaged;
  const contentSecurityPolicy = isDevelopment
    ? [
        "default-src 'none'",
        "script-src 'self' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' pt-photo: data:",
        "font-src 'self'",
        "connect-src 'self' http://localhost:* ws://localhost:*",
        "media-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "worker-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ')
    : [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' pt-photo: data:",
        "font-src 'self'",
        "connect-src 'none'",
        "media-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "worker-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ');

  // Enforce Content Security Policy header
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy],
      },
    });
  });

  // Deny permission requests
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

export function attachWindowSecurityHandlers(window: BrowserWindow): void {
  // Prevent external window creation / popups
  window.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  // Block unapproved navigation
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
}
