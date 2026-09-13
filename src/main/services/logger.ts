import pino from 'pino';
import path from 'path';
import fs from 'fs';

let loggerInstance: pino.Logger | null = null;

export function initLogger(logsDir: string): pino.Logger {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const logFilePath = path.join(logsDir, 'app.log');

  loggerInstance = pino(
    {
      level: 'info',
      base: {
        pid: process.pid,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({
      dest: logFilePath,
      sync: false,
      mkdir: true,
    })
  );

  loggerInstance.info('Logger initialized at %s', logFilePath);
  return loggerInstance;
}

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    // Fallback console logger before logger is initialized
    return pino({ level: 'info' });
  }
  return loggerInstance;
}
