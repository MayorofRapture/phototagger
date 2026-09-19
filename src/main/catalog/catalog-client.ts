import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'path';
import type { ZodType } from 'zod';
import {
  LibraryPageResultDtoSchema,
  LibraryQueryPayloadSchema,
  LibraryViewSessionResultDtoSchema,
  PhotoDetailDtoSchema,
  PhotoGetDetailPayloadSchema,
  ReadGeneralSettingsResultDtoSchema,
  SelectionClearPayloadSchema,
  SelectionClearResultDtoSchema,
  SelectionCreatePayloadSchema,
  SelectionGetPayloadSchema,
  SelectionRefDtoSchema,
  SelectionUpdatePayloadSchema,
  SettingsReadPayloadSchema,
  TagSuggestionDtoSchema,
  TagSuggestionsPayloadSchema,
  ViewSessionCreatePayloadSchema,
  ViewSessionNavigatePayloadSchema,
  type LibraryPageOptionsDto,
  type LibraryPageResultDto,
  type LibraryQueryDto,
  type LibraryViewSessionResultDto,
  type PhotoDetailDto,
  type ReadGeneralSettingsResultDto,
  type SelectionClearResultDto,
  type SelectionRefDto,
  type SelectionSeedDto,
  type TagSuggestionDto,
  type ViewNavigationDirectionDto,
} from '../../shared/contracts/catalog-api';
import {
  CatalogResponseSchema,
  CatalogRequestType,
  CloseCatalogResultSchema,
  OpenCatalogResultSchema,
  OpenTestCatalogResultSchema,
  PingResultSchema,
  type CatalogResponse,
  type CloseCatalogResult,
  type OpenTestCatalogResult,
  type OpenCatalogResult,
  type PingResult,
} from '../../shared/contracts/catalog-process';
import {
  CreateImportBatchPayloadSchema,
  CreateImportBatchResultSchema,
  CreateJournalIntentPayloadSchema,
  IdReservationResultSchema,
  ImportBatchDtoSchema,
  ImportBatchIdPayloadSchema,
  ImportBatchResultSchema,
  ImportJobDtoSchema,
  ImportJobIdPayloadSchema,
  ImportJobTransitionResultSchema,
  JournalResultSchema,
  TransitionImportJobPayloadSchema,
  TransitionJournalPayloadSchema,
  type CreateImportBatchPayload,
  type CreateImportBatchResult,
  type CreateJournalIntentPayload,
  type IdReservationResult,
  type ImportBatchDto,
  type ImportBatchResult,
  type ImportJobDto,
  type ImportJobTransitionResult,
  type JournalResult,
  type TransitionImportJobPayload,
  type TransitionJournalPayload,
} from '../../shared/contracts/import-catalog';

export interface CatalogClientOptions {
  entryPath?: string;
  requestTimeoutMs?: number;
  onUnexpectedExit?: (error: Error) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  resultSchema: ZodType<unknown>;
}

export class CatalogClient {
  private child: UtilityProcess | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private readonly entryPath: string;
  private readonly requestTimeoutMs: number;
  private readonly onUnexpectedExit: ((error: Error) => void) | undefined;
  private isShuttingDown = false;

  constructor(options: CatalogClientOptions = {}) {
    this.entryPath =
      options.entryPath || path.join(__dirname, 'catalog_process.js');
    this.requestTimeoutMs = options.requestTimeoutMs || 10000;
    this.onUnexpectedExit = options.onUnexpectedExit;
  }

  public start(): void {
    if (this.child !== null) {
      throw new Error('Catalog process is already started');
    }

    this.isShuttingDown = false;
    this.child = utilityProcess.fork(this.entryPath);

    this.child.on('message', (message: unknown) => {
      this.handleMessage(message);
    });

    this.child.on('exit', (code: number) => {
      this.handleExit(code);
    });
  }

  public isRunning(): boolean {
    return this.child !== null;
  }

  public async ping(): Promise<PingResult> {
    return this.sendRequest(CatalogRequestType.PING, {}, PingResultSchema);
  }

  public async openTestCatalog(databasePath: string): Promise<OpenTestCatalogResult> {
    return this.sendRequest(
      CatalogRequestType.OPEN_TEST_CATALOG,
      { databasePath },
      OpenTestCatalogResultSchema
    );
  }

  public async openCatalog(databasePath: string, appVersion: string): Promise<OpenCatalogResult> {
    return this.sendRequest(
      CatalogRequestType.OPEN_CATALOG,
      { databasePath, appVersion },
      OpenCatalogResultSchema
    );
  }

  public async closeCatalog(): Promise<CloseCatalogResult> {
    return this.sendRequest(CatalogRequestType.CLOSE_CATALOG, {}, CloseCatalogResultSchema);
  }

  public async readGeneralSettings(): Promise<ReadGeneralSettingsResultDto> {
    return this.sendValidatedRequest(
      CatalogRequestType.READ_GENERAL_SETTINGS,
      {},
      SettingsReadPayloadSchema,
      ReadGeneralSettingsResultDtoSchema
    );
  }

  public async findTagSuggestions(query: string, limit?: number): Promise<TagSuggestionDto[]> {
    const payload = limit === undefined ? { query } : { query, limit };
    return this.sendValidatedRequest(
      CatalogRequestType.FIND_TAG_SUGGESTIONS,
      payload,
      TagSuggestionsPayloadSchema,
      TagSuggestionDtoSchema.array().max(50)
    );
  }

  public async queryLibrary(
    query: LibraryQueryDto,
    options?: LibraryPageOptionsDto
  ): Promise<LibraryPageResultDto> {
    const payload = options === undefined ? { query } : { query, options };
    return this.sendValidatedRequest(
      CatalogRequestType.QUERY_LIBRARY,
      payload,
      LibraryQueryPayloadSchema,
      LibraryPageResultDtoSchema
    );
  }

  public async createLibrarySelection(
    queryFingerprint: string,
    seed: SelectionSeedDto
  ): Promise<SelectionRefDto> {
    return this.sendValidatedRequest(
      CatalogRequestType.CREATE_SELECTION,
      { queryFingerprint, seed },
      SelectionCreatePayloadSchema,
      SelectionRefDtoSchema
    );
  }

  public async updateLibrarySelection(
    selectionId: string,
    photoIds: number[],
    selected: boolean
  ): Promise<SelectionRefDto> {
    return this.sendValidatedRequest(
      CatalogRequestType.UPDATE_SELECTION,
      { selectionId, photoIds, selected },
      SelectionUpdatePayloadSchema,
      SelectionRefDtoSchema
    );
  }

  public async getLibrarySelection(selectionId: string): Promise<SelectionRefDto> {
    return this.sendValidatedRequest(
      CatalogRequestType.GET_SELECTION,
      { selectionId },
      SelectionGetPayloadSchema,
      SelectionRefDtoSchema
    );
  }

  public async clearLibrarySelection(selectionId: string): Promise<SelectionClearResultDto> {
    return this.sendValidatedRequest(
      CatalogRequestType.CLEAR_SELECTION,
      { selectionId },
      SelectionClearPayloadSchema,
      SelectionClearResultDtoSchema
    );
  }

  public async getPhotoDetail(photoId: number): Promise<PhotoDetailDto> {
    return this.sendValidatedRequest(
      CatalogRequestType.GET_PHOTO_DETAIL,
      { photoId },
      PhotoGetDetailPayloadSchema,
      PhotoDetailDtoSchema
    );
  }

  public async createLibraryViewSession(
    queryFingerprint: string,
    selectedPhotoId: number
  ): Promise<LibraryViewSessionResultDto> {
    return this.sendValidatedRequest(
      CatalogRequestType.CREATE_VIEW_SESSION,
      { queryFingerprint, selectedPhotoId },
      ViewSessionCreatePayloadSchema,
      LibraryViewSessionResultDtoSchema
    );
  }

  public async navigateLibraryViewSession(
    viewSessionId: string,
    direction: ViewNavigationDirectionDto
  ): Promise<LibraryViewSessionResultDto> {
    return this.sendValidatedRequest(
      CatalogRequestType.NAVIGATE_VIEW_SESSION,
      { viewSessionId, direction },
      ViewSessionNavigatePayloadSchema,
      LibraryViewSessionResultDtoSchema
    );
  }

  /** Internal main-to-catalog import foundation; never exposed through preload. */
  public async createImportBatch(input: CreateImportBatchPayload): Promise<CreateImportBatchResult> {
    return this.sendValidatedRequest(
      CatalogRequestType.CREATE_IMPORT_BATCH,
      input,
      CreateImportBatchPayloadSchema,
      CreateImportBatchResultSchema
    );
  }

  public async getImportBatch(batchId: string): Promise<ImportBatchDto> {
    return this.sendValidatedRequest(
      CatalogRequestType.GET_IMPORT_BATCH,
      { batchId },
      ImportBatchIdPayloadSchema,
      ImportBatchDtoSchema
    );
  }

  public async getImportJob(jobId: string): Promise<ImportJobDto> {
    return this.sendValidatedRequest(
      CatalogRequestType.GET_IMPORT_JOB,
      { jobId },
      ImportJobIdPayloadSchema,
      ImportJobDtoSchema
    );
  }

  public async listImportJobs(batchId: string): Promise<ImportJobDto[]> {
    return this.sendValidatedRequest(
      CatalogRequestType.LIST_IMPORT_JOBS,
      { batchId },
      ImportBatchIdPayloadSchema,
      ImportJobDtoSchema.array()
    );
  }

  public async transitionImportJob(
    input: TransitionImportJobPayload
  ): Promise<ImportJobTransitionResult> {
    return this.sendValidatedRequest(
      CatalogRequestType.TRANSITION_IMPORT_JOB,
      input,
      TransitionImportJobPayloadSchema,
      ImportJobTransitionResultSchema
    );
  }

  public async requestImportStop(batchId: string): Promise<ImportBatchResult> {
    return this.sendValidatedRequest(
      CatalogRequestType.REQUEST_IMPORT_STOP,
      { batchId },
      ImportBatchIdPayloadSchema,
      ImportBatchResultSchema
    );
  }

  public async reserveImportPhotoId(jobId: string): Promise<IdReservationResult> {
    return this.sendValidatedRequest(
      CatalogRequestType.RESERVE_IMPORT_PHOTO_ID,
      { jobId },
      ImportJobIdPayloadSchema,
      IdReservationResultSchema
    );
  }

  public async commitImportPhotoId(jobId: string): Promise<IdReservationResult> {
    return this.sendValidatedRequest(
      CatalogRequestType.COMMIT_IMPORT_PHOTO_ID,
      { jobId },
      ImportJobIdPayloadSchema,
      IdReservationResultSchema
    );
  }

  public async abandonImportPhotoId(jobId: string): Promise<IdReservationResult> {
    return this.sendValidatedRequest(
      CatalogRequestType.ABANDON_IMPORT_PHOTO_ID,
      { jobId },
      ImportJobIdPayloadSchema,
      IdReservationResultSchema
    );
  }

  public async createOperationJournalIntent(
    input: CreateJournalIntentPayload
  ): Promise<JournalResult> {
    return this.sendValidatedRequest(
      CatalogRequestType.CREATE_OPERATION_JOURNAL_INTENT,
      input,
      CreateJournalIntentPayloadSchema,
      JournalResultSchema
    );
  }

  public async transitionOperationJournal(
    input: TransitionJournalPayload
  ): Promise<JournalResult> {
    return this.sendValidatedRequest(
      CatalogRequestType.TRANSITION_OPERATION_JOURNAL,
      input,
      TransitionJournalPayloadSchema,
      JournalResultSchema
    );
  }

  public async stop(): Promise<void> {
    if (this.child === null) {
      return;
    }

    this.isShuttingDown = true;

    // Try closing catalog cleanly if running
    try {
      await this.closeCatalog();
    } catch {
      // Ignore if no catalog open or request failed during shutdown
    }

    if (this.child !== null) {
      this.child.kill();
      this.child = null;
    }

    this.rejectAllPending('Catalog process stopped');
  }

  private sendRequest<T>(
    type: CatalogRequestType,
    payload: unknown,
    resultSchema: ZodType<T>
  ): Promise<T> {
    if (this.child === null) {
      return Promise.reject(new Error('Catalog process is not running'));
    }

    const requestId = `req_${++this.requestCounter}_${Date.now()}`;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Catalog request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timer,
        resultSchema,
      });

      this.child!.postMessage({
        requestId,
        type,
        payload,
      });
    });
  }

  private handleMessage(message: unknown): void {
    const parseResult = CatalogResponseSchema.safeParse(message);
    const requestId =
      typeof message === 'object' &&
      message !== null &&
      'requestId' in message &&
      typeof (message as { requestId: unknown }).requestId === 'string'
        ? (message as { requestId: string }).requestId
        : null;

    if (!parseResult.success) {
      if (requestId !== null) {
        this.rejectMalformedResponse(requestId);
      }
      return;
    }

    const response: CatalogResponse = parseResult.data;
    const pending = this.pendingRequests.get(response.requestId);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.requestId);

    if (response.success) {
      const result = pending.resultSchema.safeParse(response.result);
      if (!result.success) {
        pending.reject(new Error('Catalog process returned a malformed response'));
        return;
      }
      pending.resolve(result.data);
    } else {
      pending.reject(
        new Error(`[${response.error.code}] ${response.error.message}`)
      );
    }
  }

  private sendValidatedRequest<TPayload, TResult>(
    type: CatalogRequestType,
    payload: TPayload,
    payloadSchema: ZodType<TPayload>,
    resultSchema: ZodType<TResult>
  ): Promise<TResult> {
    const validatedPayload = payloadSchema.parse(payload);
    return this.sendRequest(type, validatedPayload, resultSchema);
  }

  private rejectMalformedResponse(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.reject(new Error('Catalog process returned a malformed response'));
  }

  private handleExit(code: number): void {
    const unexpectedExit = !this.isShuttingDown;
    const reason = unexpectedExit
      ? `Catalog process exited unexpectedly with code ${code}`
      : 'Catalog process shut down cleanly';

    this.child = null;
    this.rejectAllPending(reason);
    if (unexpectedExit) {
      try {
        this.onUnexpectedExit?.(new Error(reason));
      } catch {
        // A reporting callback must not destabilize the main process.
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(requestId);
    }
  }
}
