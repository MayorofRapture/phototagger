const { app, utilityProcess } = require('electron');
const fs = require('fs');
const path = require('path');

const entryPath = path.resolve(
  process.argv[2] || path.join('.webpack', 'x64', 'main', 'catalog_process.js')
);

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function run() {
  await app.whenReady();
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Catalog utility bundle does not exist: ${entryPath}`);
  }

  const child = utilityProcess.fork(entryPath);
  try {
    await withTimeout(new Promise((resolve) => child.once('spawn', resolve)), 10000, 'utilityProcess spawn');
    const requestId = `smoke-${Date.now()}`;
    const responsePromise = new Promise((resolve, reject) => {
      child.on('message', (message) => {
        if (message?.requestId !== requestId) {
          return;
        }
        if (message.success === true && message.result?.pong === true) {
          resolve(message);
        } else {
          reject(new Error(`Unexpected ping response: ${JSON.stringify(message)}`));
        }
      });
    });
    child.postMessage({ requestId, type: 'ping', payload: {} });
    await withTimeout(responsePromise, 10000, 'catalog ping');

    const exitPromise = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await withTimeout(exitPromise, 10000, 'utilityProcess shutdown');
    console.log(`Catalog utility-process ping passed: ${entryPath}`);
  } finally {
    child.kill();
  }
}

run().then(
  () => app.quit(),
  (error) => {
    console.error(error instanceof Error ? error.stack : error);
    app.exit(1);
  }
);
