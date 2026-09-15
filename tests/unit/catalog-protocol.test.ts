import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, afterEach } from 'vitest';
import { CatalogProcessHandler, handler } from '../../src/catalog/catalog-process';
import { CatalogRequestType } from '../../src/shared/contracts/catalog-process';

describe('Catalog process handler and protocol validation', () => {
  const tempFiles: string[] = [];

  function getTempDbPath(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-test-catalog-proc-'));
    tempFiles.push(tempDir);
    return path.join(tempDir, 'catalog.sqlite');
  }

  afterEach(() => {
    // Ensure database is closed after each test
    handler.closeDatabase();
    for (const file of tempFiles.splice(0)) {
      try {
        fs.rmSync(file, { recursive: true, force: true });
      } catch {
        // Ignore removal errors
      }
    }
  });

  it('correctly processes and responds to a valid ping request', () => {
    const pingRequest = {
      requestId: 'req-1',
      type: CatalogRequestType.PING,
      payload: {},
    };

    const response = handler.handleRawMessage(pingRequest);

    expect(response.requestId).toBe('req-1');
    expect(response.success).toBe(true);
    if (response.success) {
      expect(response.result).toHaveProperty('pong', true);
      expect(response.result).toHaveProperty('timestamp');
    }
  });

  it('rejects malformed and unknown requests with helpful errors', () => {
    // Malformed request with invalid format
    const malformedRequest = {
      requestId: 'req-2',
      type: 'invalid-type',
      payload: {},
    };

    const response = handler.handleRawMessage(malformedRequest);
    expect(response.requestId).toBe('req-2');
    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error.code).toBe('INVALID_REQUEST');
      expect(response.error.message).toContain('Malformed request payload');
    }

    // Missing request ID
    const missingIdRequest = {
      type: CatalogRequestType.PING,
      payload: {},
    };

    const responseNoId = handler.handleRawMessage(missingIdRequest);
    expect(responseNoId.requestId).toBe('unknown');
    expect(responseNoId.success).toBe(false);
  });

  it('rejects database operations if catalog is not open', () => {
    const closeRequest = {
      requestId: 'req-close-fail',
      type: CatalogRequestType.CLOSE_CATALOG,
      payload: {},
    };

    const response = handler.handleRawMessage(closeRequest);
    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error.code).toBe('NO_CATALOG_OPEN');
    }
  });

  it('opens a test catalog, runs migrations, creates TEMP session tables, and rejects a second open', () => {
    const dbPath = getTempDbPath();

    // 1. Open first catalog
    const openRequest = {
      requestId: 'req-open-1',
      type: CatalogRequestType.OPEN_TEST_CATALOG,
      payload: { databasePath: dbPath },
    };

    const openResponse = handler.handleRawMessage(openRequest);
    expect(openResponse.success).toBe(true);
    if (openResponse.success) {
      expect(openResponse.result).toEqual({
        opened: true,
        databasePath: dbPath,
        userVersion: 1,
        temporaryTableNames: ['selection_members', 'selection_sessions', 'view_members', 'view_sessions'],
      });
    }

    // 2. Try to open second catalog while first is open
    const openRequest2 = {
      requestId: 'req-open-2',
      type: CatalogRequestType.OPEN_TEST_CATALOG,
      payload: { databasePath: getTempDbPath() },
    };

    const openResponse2 = handler.handleRawMessage(openRequest2);
    expect(openResponse2.success).toBe(false);
    if (!openResponse2.success) {
      expect(openResponse2.error.code).toBe('CATALOG_ALREADY_OPEN');
      expect(openResponse2.error.message).toContain('already open');
    }

    // 3. Close the catalog cleanly
    const closeRequest = {
      requestId: 'req-close',
      type: CatalogRequestType.CLOSE_CATALOG,
      payload: {},
    };

    const closeResponse = handler.handleRawMessage(closeRequest);
    expect(closeResponse.success).toBe(true);
  });

  it('does not leave an open database connection if OPEN_TEST_CATALOG initialization fails', () => {
    const dbPath = getTempDbPath();
    const failingHandler = new CatalogProcessHandler({
      createTemporaryTables: () => {
        throw new Error('simulated TEMP initialization failure');
      },
    }, false);

    const openRequest = {
      requestId: 'req-open-fail',
      type: CatalogRequestType.OPEN_TEST_CATALOG,
      payload: { databasePath: dbPath },
    };

    const openResponse = failingHandler.handleRawMessage(openRequest);
    expect(openResponse.success).toBe(false);
    if (!openResponse.success) {
      expect(openResponse.error.code).toBe('EXECUTION_ERROR');
    }

    expect(() => fs.rmSync(dbPath)).not.toThrow();
  });
});
