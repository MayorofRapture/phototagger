import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it, afterEach } from 'vitest';
import { CatalogProcessHandler, handler } from '../../src/catalog/catalog-process';
import {
  CatalogRequestSchema,
  CatalogRequestType,
  CatalogResponseSchema,
} from '../../src/shared/contracts/catalog-process';

const fingerprint = 'a'.repeat(64);
const selectionId = '00000000-0000-4000-8000-000000000001';
const libraryQuery = {
  tagIds: [2, 1, 2],
  flaggedOnly: false,
  order: 'newest-imported',
};

function request(type: string, payload: unknown): unknown {
  return { requestId: `request-${type}`, type, payload };
}

describe('M1E1 catalog transport contracts', () => {
  it('accepts settings read and rejects unknown payload fields', () => {
    expect(
      CatalogRequestSchema.safeParse(request(CatalogRequestType.READ_GENERAL_SETTINGS, {})).success
    ).toBe(true);
    expect(
      CatalogRequestSchema.safeParse(
        request(CatalogRequestType.READ_GENERAL_SETTINGS, {
          key: 'conversion.jpegQuality',
        })
      ).success
    ).toBe(false);
  });

  it('accepts tag suggestions and rejects invalid limits', () => {
    expect(
      CatalogRequestSchema.safeParse(
        request(CatalogRequestType.FIND_TAG_SUGGESTIONS, {
          query: 'cat',
          limit: 50,
        })
      ).success
    ).toBe(true);
    for (const limit of [0, 51, 1.5]) {
      expect(
        CatalogRequestSchema.safeParse(
          request(CatalogRequestType.FIND_TAG_SUGGESTIONS, {
            query: 'cat',
            limit,
          })
        ).success
      ).toBe(false);
    }
  });

  it('strictly validates Library queries, page sizes, and cursor shape', () => {
    expect(
      CatalogRequestSchema.safeParse(
        request(CatalogRequestType.QUERY_LIBRARY, {
          query: libraryQuery,
          options: { pageSize: 200, cursor: null },
        })
      ).success
    ).toBe(true);
    expect(
      CatalogRequestSchema.safeParse(
        request(CatalogRequestType.QUERY_LIBRARY, {
          query: { ...libraryQuery, extra: true },
        })
      ).success
    ).toBe(false);
    expect(
      CatalogRequestSchema.safeParse(
        request(CatalogRequestType.QUERY_LIBRARY, {
          query: libraryQuery,
          options: { pageSize: 201 },
        })
      ).success
    ).toBe(false);
    expect(
      CatalogRequestSchema.safeParse(
        request(CatalogRequestType.QUERY_LIBRARY, {
          query: libraryQuery,
          options: { cursor: 'not base64url!' },
        })
      ).success
    ).toBe(false);
  });

  it('accepts every selection seed and rejects malformed selection payloads', () => {
    for (const seed of [{ type: 'none' }, { type: 'all' }, { type: 'one', photoId: 42 }]) {
      expect(
        CatalogRequestSchema.safeParse(
          request(CatalogRequestType.CREATE_SELECTION, {
            queryFingerprint: fingerprint,
            seed,
          })
        ).success
      ).toBe(true);
    }
    expect(
      CatalogRequestSchema.safeParse(
        request(CatalogRequestType.CREATE_SELECTION, {
          queryFingerprint: fingerprint,
          seed: { type: 'one', photoId: 0 },
        })
      ).success
    ).toBe(false);
    expect(
      CatalogRequestSchema.safeParse(
        request(CatalogRequestType.UPDATE_SELECTION, {
          selectionId,
          photoIds: [1, -1],
          selected: true,
        })
      ).success
    ).toBe(false);
  });

  it('rejects unknown operations', () => {
    expect(CatalogRequestSchema.safeParse(request('catalog.call', {})).success).toBe(false);
  });

  it('validates response envelopes and rejects BigInt anywhere in result data', () => {
    expect(
      CatalogResponseSchema.safeParse({
        requestId: 'response-1',
        success: true,
        result: { nested: [{ count: 42, value: null }] },
      }).success
    ).toBe(true);
    expect(
      CatalogResponseSchema.safeParse({
        requestId: 'response-2',
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Invalid request' },
      }).success
    ).toBe(true);
    expect(
      CatalogResponseSchema.safeParse({
        requestId: 'response-3',
        success: true,
        result: { catalogRevision: 1n },
      }).success
    ).toBe(false);
  });

  it('keeps representative renderer responses plain and structured-clone safe', () => {
    const representativeResults = [
      {
        settings: {
          jpegQuality: 92,
          alphaBackground: '#ffffff',
          defaultOrder: 'newest-imported',
          warningThreshold: 500,
        },
        warnings: [],
      },
      [
        {
          tagId: 1,
          parentTagId: null,
          displayName: 'Cats',
          fullPath: 'Pets/Cats',
          depth: 2,
          childCount: 0,
          pinned: false,
          legacyFlatOnly: false,
        },
      ],
      {
        queryFingerprint: fingerprint,
        totalCount: 1,
        photos: [
          {
            photoId: 1,
            canonicalFilename: '0000000001.jpg',
            originalFilename: 'cat.jpg',
            flagged: false,
            integrityState: 'clean',
            width: 1200,
            height: 800,
            contentRevision: 1,
            thumbnailRevision: 1,
            thumbnailUrl: 'pt-photo://thumb/1?thumb=1',
          },
        ],
        nextCursor: null,
      },
      { selectionId, count: 1, catalogRevisionAtCapture: 2 },
    ];

    for (const [index, result] of representativeResults.entries()) {
      const envelope = { requestId: `safe-${index}`, success: true, result };
      expect(CatalogResponseSchema.safeParse(envelope).success).toBe(true);
      expect(structuredClone(result)).toEqual(result);
      expect(() => JSON.stringify(result)).not.toThrow();
    }
    expect(
      CatalogResponseSchema.safeParse({
        requestId: 'unsafe-function',
        success: true,
        result: { callback: () => undefined },
      }).success
    ).toBe(false);
    expect(
      CatalogResponseSchema.safeParse({
        requestId: 'unsafe-class',
        success: true,
        result: new (class Result {
          public count = 1;
        })(),
      }).success
    ).toBe(false);
  });
});

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

  it('creates and reopens a compatible production catalog with TEMP tables', () => {
    const dbPath = getTempDbPath();
    const productionHandler = new CatalogProcessHandler({}, false);
    const openRequest = {
      requestId: 'production-open-1',
      type: CatalogRequestType.OPEN_CATALOG,
      payload: { databasePath: dbPath, appVersion: '1.0.0-test' },
    };

    const freshResponse = productionHandler.handleRawMessage(openRequest);
    expect(freshResponse).toEqual({
      requestId: 'production-open-1',
      success: true,
      result: {
        opened: true,
        created: true,
        userVersion: 1,
        temporaryTableNames: ['selection_members', 'selection_sessions', 'view_members', 'view_sessions'],
      },
    });

    const secondResponse = productionHandler.handleRawMessage({
      ...openRequest,
      requestId: 'production-open-2',
    });
    expect(secondResponse).toMatchObject({
      requestId: 'production-open-2',
      success: false,
      error: { code: 'CATALOG_ALREADY_OPEN' },
    });

    productionHandler.closeDatabase();
    const reopenedHandler = new CatalogProcessHandler({}, false);
    const reopenedResponse = reopenedHandler.handleRawMessage({
      ...openRequest,
      requestId: 'production-reopen',
    });
    expect(reopenedResponse).toMatchObject({
      requestId: 'production-reopen',
      success: true,
      result: { opened: true, created: false, userVersion: 1 },
    });
    reopenedHandler.closeDatabase();
  });

  it('rejects a production catalog with a newer unsupported schema', () => {
    const dbPath = getTempDbPath();
    const database = new Database(dbPath);
    database.pragma('application_id = 0x50544147');
    database.pragma('user_version = 2');
    database.close();

    const productionHandler = new CatalogProcessHandler({}, false);
    const response = productionHandler.handleRawMessage({
      requestId: 'production-newer',
      type: CatalogRequestType.OPEN_CATALOG,
      payload: { databasePath: dbPath, appVersion: '1.0.0-test' },
    });
    expect(response).toMatchObject({
      requestId: 'production-newer',
      success: false,
      error: { code: 'EXECUTION_ERROR' },
    });
    if (!response.success) {
      expect(response.error.message).toContain('newer than supported');
    }
    expect(() => fs.rmSync(dbPath)).not.toThrow();
  });

  it('closes a production connection when post-open initialization fails', () => {
    const dbPath = getTempDbPath();
    const failingHandler = new CatalogProcessHandler({
      createTemporaryTables: () => {
        throw new Error('simulated production TEMP initialization failure');
      },
    }, false);
    const response = failingHandler.handleRawMessage({
      requestId: 'production-init-failure',
      type: CatalogRequestType.OPEN_CATALOG,
      payload: { databasePath: dbPath, appVersion: '1.0.0-test' },
    });

    expect(response).toMatchObject({ success: false, error: { code: 'EXECUTION_ERROR' } });
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
