import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CatalogClient } from '../../src/main/catalog/catalog-client';

// Mock electron's utilityProcess
const mockPostMessage = vi.fn();
const mockKill = vi.fn();
const mockOn = vi.fn();

vi.mock('electron', () => {
  return {
    utilityProcess: {
      fork: vi.fn(() => ({
        postMessage: mockPostMessage,
        kill: mockKill,
        on: mockOn,
      })),
    },
  };
});

describe('CatalogClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('can be instantiated and started', () => {
    const client = new CatalogClient();
    expect(client.isRunning()).toBe(false);

    client.start();
    expect(client.isRunning()).toBe(true);
    expect(mockOn).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('exit', expect.any(Function));
  });

  it('prevents starting twice', () => {
    const client = new CatalogClient();
    client.start();
    expect(() => client.start()).toThrow('Catalog process is already started');
  });

  it('assigns request IDs and resolves them on success response', async () => {
    const client = new CatalogClient();
    client.start();

    // Find the message handler registered on mock child
    const messageHandler = mockOn.mock.calls.find(call => call[0] === 'message')?.[1];
    expect(messageHandler).toBeDefined();

    const pingPromise = client.ping();

    // Verify postMessage was called with a request containing requestId and type
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const sentRequest = mockPostMessage.mock.calls[0][0];
    expect(sentRequest).toHaveProperty('requestId');
    expect(sentRequest.type).toBe('ping');

    // Simulate child replying with success response
    const mockResponse = {
      requestId: sentRequest.requestId,
      success: true,
      result: { pong: true, timestamp: '2026-09-14T12:00:00.000Z' },
    };

    messageHandler(mockResponse);

    const result = await pingPromise;
    expect(result).toEqual({ pong: true, timestamp: '2026-09-14T12:00:00.000Z' });
  });

  it('rejects a correlated malformed child response', async () => {
    const client = new CatalogClient();
    client.start();
    const messageHandler = mockOn.mock.calls.find(call => call[0] === 'message')?.[1];
    const pingPromise = client.ping();
    const sentRequest = mockPostMessage.mock.calls[0][0];

    messageHandler({ requestId: sentRequest.requestId, success: true, result: { pong: false } });

    await expect(pingPromise).rejects.toThrow('Catalog process returned a malformed response');
  });

  it('rejects malformed photo-detail responses before they reach main', async () => {
    const client = new CatalogClient();
    client.start();
    const messageHandler = mockOn.mock.calls.find(call => call[0] === 'message')?.[1];
    const detailPromise = client.getPhotoDetail(1);
    const sentRequest = mockPostMessage.mock.calls[0][0];

    messageHandler({
      requestId: sentRequest.requestId,
      success: true,
      result: {
        photoId: 1n,
        canonicalFilename: '0000000001.jpg',
      },
    });

    await expect(detailPromise).rejects.toThrow('malformed response');
  });

  it('rejects pending promise on failure response', async () => {
    const client = new CatalogClient();
    client.start();

    const messageHandler = mockOn.mock.calls.find(call => call[0] === 'message')?.[1];
    const openPromise = client.openTestCatalog('invalid/path.db');

    const sentRequest = mockPostMessage.mock.calls[0][0];

    // Simulate child replying with error response
    const mockResponse = {
      requestId: sentRequest.requestId,
      success: false,
      error: { code: 'EXECUTION_ERROR', message: 'Failed to open database' },
    };

    messageHandler(mockResponse);

    await expect(openPromise).rejects.toThrow('[EXECUTION_ERROR] Failed to open database');
  });

  it('sends the distinct production catalog operation', async () => {
    const client = new CatalogClient();
    client.start();
    const messageHandler = mockOn.mock.calls.find(call => call[0] === 'message')?.[1];
    const openPromise = client.openCatalog(
      'D:\\isolated\\Collection\\Data\\catalog.sqlite',
      '1.0.0-test'
    );
    const sentRequest = mockPostMessage.mock.calls[0][0];
    expect(sentRequest.type).toBe('openCatalog');
    expect(sentRequest.payload).toEqual({
      databasePath: 'D:\\isolated\\Collection\\Data\\catalog.sqlite',
      appVersion: '1.0.0-test',
    });

    messageHandler({
      requestId: sentRequest.requestId,
      success: true,
      result: {
        opened: true,
        created: true,
        userVersion: 1,
        temporaryTableNames: ['selection_members', 'selection_sessions', 'view_members', 'view_sessions'],
      },
    });
    await expect(openPromise).resolves.toMatchObject({ opened: true, created: true });
  });

  it('sends every M1E1 request through an explicit operation with a unique request ID', async () => {
    const client = new CatalogClient();
    client.start();
    const messageHandler = mockOn.mock.calls.find((call) => call[0] === 'message')?.[1];
    const fingerprint = 'a'.repeat(64);
    const selectionId = '00000000-0000-4000-8000-000000000001';
    const viewSessionId = '00000000-0000-4000-8000-000000000002';
    const query = {
      tagIds: [],
      flaggedOnly: false,
      order: 'newest-imported' as const,
    };
    const selection = { selectionId, count: 0, catalogRevisionAtCapture: 2 };
    const detail = {
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
      lifecycleState: 'active',
      fullImageUrl: 'pt-photo://full/1?content=1',
      explicitTags: [],
      desiredMetadataRevision: 0,
      syncedMetadataRevision: 0,
      metadataState: 'synchronized',
      importedAt: '2026-09-18T12:00:00.000Z',
    };
    const viewSession = { viewSessionId, position: 0, count: 1, detail };
    const requestIds = new Set<string>();

    async function expectRequest(
      invoke: () => Promise<unknown>,
      type: string,
      payload: unknown,
      result: unknown
    ): Promise<void> {
      const pending = invoke();
      const sent = mockPostMessage.mock.calls.at(-1)?.[0];
      expect(sent).toMatchObject({ type, payload });
      expect(requestIds.has(sent.requestId)).toBe(false);
      requestIds.add(sent.requestId);
      messageHandler({ requestId: sent.requestId, success: true, result });
      await expect(pending).resolves.toEqual(result);
    }

    await expectRequest(
      () => client.readGeneralSettings(),
      'settings.readGeneral',
      {},
      {
        settings: {
          jpegQuality: 92,
          alphaBackground: '#ffffff',
          defaultOrder: 'newest-imported',
          warningThreshold: 500,
        },
        warnings: [],
      }
    );
    await expectRequest(
      () => client.findTagSuggestions('cat', 10),
      'tags.findSuggestions',
      { query: 'cat', limit: 10 },
      [
        {
          tagId: 1,
          parentTagId: null,
          displayName: 'Cats',
          fullPath: 'Cats',
          depth: 1,
          childCount: 0,
          pinned: false,
          legacyFlatOnly: false,
        },
      ]
    );
    await expectRequest(
      () => client.queryLibrary(query, { pageSize: 20 }),
      'library.query',
      { query, options: { pageSize: 20 } },
      {
        queryFingerprint: fingerprint,
        totalCount: 0,
        photos: [],
        nextCursor: null,
      }
    );
    await expectRequest(
      () => client.createLibrarySelection(fingerprint, { type: 'none' }),
      'selection.create',
      { queryFingerprint: fingerprint, seed: { type: 'none' } },
      selection
    );
    await expectRequest(
      () => client.updateLibrarySelection(selectionId, [1, 2], true),
      'selection.update',
      { selectionId, photoIds: [1, 2], selected: true },
      { ...selection, count: 2 }
    );
    await expectRequest(
      () => client.getLibrarySelection(selectionId),
      'selection.get',
      { selectionId },
      selection
    );
    await expectRequest(
      () => client.clearLibrarySelection(selectionId),
      'selection.clear',
      { selectionId },
      { cleared: true }
    );
    await expectRequest(
      () => client.getPhotoDetail(1),
      'photo.getDetail',
      { photoId: 1 },
      detail
    );
    await expectRequest(
      () => client.createLibraryViewSession(fingerprint, 1),
      'library.createViewSession',
      { queryFingerprint: fingerprint, selectedPhotoId: 1 },
      viewSession
    );
    await expectRequest(
      () => client.navigateLibraryViewSession(viewSessionId, 'next'),
      'library.navigateView',
      { viewSessionId, direction: 'next' },
      viewSession
    );
    expect(requestIds.size).toBe(10);
  });

  it('sends M2A import foundations only through explicit validated catalog operations', async () => {
    const client = new CatalogClient();
    client.start();
    const messageHandler = mockOn.mock.calls.find((call) => call[0] === 'message')?.[1];
    const batchId = '00000000-0000-4000-8000-000000000100';
    const jobId = '00000000-0000-4000-8000-000000000101';
    const batch = {
      batchId,
      snapshotAt: '2026-09-20T12:00:00.000Z',
      requestedStopAt: null,
      state: 'queued' as const,
      totalCount: 1,
      completedCount: 0,
      failedCount: 0,
      waitingCount: 0,
      createdAt: '2026-09-20T12:00:00.000Z',
      updatedAt: '2026-09-20T12:00:00.000Z',
    };
    const job = {
      jobId,
      batchId,
      ordinal: 0,
      originalFilename: 'cat.jpg',
      sourceRelativePath: 'Inbox/cat.jpg',
      currentRelativePath: 'Inbox/cat.jpg',
      detectedFormat: null,
      state: 'queued' as const,
      phase: 'discovered' as const,
      sourceSizeBytes: null,
      sourceMtimeNs: null,
      sourceSha256Hex: null,
      candidateWidth: null,
      candidateHeight: null,
      candidateOrientation: null,
      possibleDuplicateId: null,
      stagedMetadataJson: '{}',
      retryCount: 0,
      errorClass: null,
      errorCode: null,
      errorDetailJson: '{}',
      createdAt: '2026-09-20T12:00:00.000Z',
      updatedAt: '2026-09-20T12:00:00.000Z',
      completedAt: null,
    };
    const pending = client.createImportBatch({
      batchId,
      snapshotAt: batch.snapshotAt,
      entries: [{
        jobId,
        ordinal: 0,
        originalFilename: 'cat.jpg',
        sourceRelativePath: 'Inbox/cat.jpg',
      }],
    });
    const sent = mockPostMessage.mock.calls.at(-1)?.[0];
    expect(sent).toMatchObject({
      type: 'imports.createBatch',
      payload: { batchId, entries: [{ jobId, sourceRelativePath: 'Inbox/cat.jpg' }] },
    });
    messageHandler({
      requestId: sent.requestId,
      success: true,
      result: { batch, jobs: [job], catalogRevision: 1 },
    });
    await expect(pending).resolves.toEqual({ batch, jobs: [job], catalogRevision: 1 });
    await expect(client.createImportBatch({
      batchId,
      snapshotAt: batch.snapshotAt,
      entries: [{
        jobId,
        ordinal: 0,
        originalFilename: 'cat.jpg',
        sourceRelativePath: 'C:/outside/cat.jpg',
      }],
    })).rejects.toThrow();
  });

  it('rejects invalid M1E1 input before posting to the utility process', async () => {
    const client = new CatalogClient();
    client.start();

    await expect(client.findTagSuggestions('cat', 51)).rejects.toThrow();
    await expect(
      client.updateLibrarySelection('00000000-0000-4000-8000-000000000001', [0], true)
    ).rejects.toThrow();
    await expect(client.getPhotoDetail(0)).rejects.toThrow();
    await expect(client.navigateLibraryViewSession(
      '00000000-0000-4000-8000-000000000001',
      'sideways' as never
    )).rejects.toThrow();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('times out outstanding requests', async () => {
    const client = new CatalogClient({ requestTimeoutMs: 1000 });
    client.start();

    const pingPromise = client.ping();

    // Advance clock past timeout
    vi.advanceTimersByTime(1500);

    await expect(pingPromise).rejects.toThrow('Catalog request timed out after 1000ms');
  });

  it('rejects pending requests when process exits unexpectedly', async () => {
    const client = new CatalogClient();
    client.start();

    const exitHandler = mockOn.mock.calls.find(call => call[0] === 'exit')?.[1];
    expect(exitHandler).toBeDefined();

    const pingPromise = client.ping();

    // Simulate process exiting unexpectedly
    exitHandler(1);

    await expect(pingPromise).rejects.toThrow('Catalog process exited unexpectedly with code 1');
    expect(client.isRunning()).toBe(false);
  });

  it('can stop and cleans up child process', async () => {
    const client = new CatalogClient();
    client.start();

    const messageHandler = mockOn.mock.calls.find(call => call[0] === 'message')?.[1];

    const stopPromise = client.stop();

    // Since stop sends closeCatalog, mock response for closeCatalog
    const closeRequest = mockPostMessage.mock.calls[0][0];
    expect(closeRequest.type).toBe('closeCatalog');

    messageHandler({
      requestId: closeRequest.requestId,
      success: true,
      result: { closed: true },
    });

    await stopPromise;
    expect(mockKill).toHaveBeenCalledTimes(1);
    expect(client.isRunning()).toBe(false);
  });
});
