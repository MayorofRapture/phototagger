import type { CatalogDatabase } from "../migrations/schema";
import {
  CreateImportBatchPayloadSchema,
  CreateJournalIntentPayloadSchema,
  IdReservationDtoSchema,
  ImportBatchDtoSchema,
  ImportBatchIdPayloadSchema,
  ImportJobDtoSchema,
  ImportJobIdPayloadSchema,
  JournalResultSchema,
  TransitionImportJobPayloadSchema,
  TransitionJournalPayloadSchema,
  type CreateImportBatchPayload,
  type CreateImportBatchResult,
  type CreateJournalIntentPayload,
  type IdReservationDto,
  type IdReservationResult,
  type ImportBatchDto,
  type ImportBatchResult,
  type ImportJobDto,
  type ImportJobTransitionResult,
  type JournalResult,
  type TransitionImportJobPayload,
  type TransitionJournalPayload,
} from "../../shared/contracts/import-catalog";

const TERMINAL_JOB_STATES = new Set([
  "failed",
  "completed",
  "duplicate_completed",
  "stopped",
]);

const VALID_JOB_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  "queued/discovered": [
    "running/validating",
    "waiting/waiting_stable",
    "stopped/terminal",
    "failed/terminal",
  ],
  "waiting/waiting_stable": [
    "queued/discovered",
    "running/validating",
    "stopped/terminal",
    "failed/terminal",
  ],
  "running/validating": [
    "running/hashing",
    "failed/terminal",
    "stopped/terminal",
  ],
  "running/hashing": [
    "running/duplicate_check",
    "failed/terminal",
    "stopped/terminal",
  ],
  "running/duplicate_check": [
    "running/id_reserved",
    "duplicate_completed/terminal",
    "failed/terminal",
    "stopped/terminal",
  ],
  "running/id_reserved": [
    "running/moving",
    "running/converting",
    "failed/terminal",
    "stopped/terminal",
  ],
  "running/moving": [
    "running/stored_verification",
    "failed/terminal",
    "stopped/terminal",
  ],
  "running/converting": [
    "running/stored_verification",
    "failed/terminal",
    "stopped/terminal",
  ],
  "running/stored_verification": [
    "running/thumbnail_generation",
    "failed/terminal",
    "stopped/terminal",
  ],
  "running/thumbnail_generation": [
    "running/catalog_commit",
    "failed/terminal",
    "stopped/terminal",
  ],
  "running/catalog_commit": [
    "running/source_cleanup",
    "failed/terminal",
    "stopped/terminal",
  ],
  "running/source_cleanup": [
    "completed/terminal",
    "failed/terminal",
    "stopped/terminal",
  ],
};

const VALID_JOURNAL_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  planned: ["mutating", "failed", "recovery_required"],
  mutating: ["verifying", "failed", "recovery_required"],
  verifying: ["cleanup", "completed", "failed", "recovery_required"],
  cleanup: ["completed", "failed", "recovery_required"],
  completed: [],
  failed: [],
  recovery_required: [],
};

export class CatalogOperationError extends Error {
  constructor(
    public readonly code:
      | "IMPORT_NOT_FOUND"
      | "IMPORT_INVALID_TRANSITION"
      | "IMPORT_STALE_TRANSITION"
      | "IMPORT_INVALID_STATE"
      | "IMPORT_CONFLICT"
      | "CATALOG_STATE",
    message: string,
  ) {
    super(message);
    this.name = "CatalogOperationError";
  }
}

export interface ImportRepositoryOptions {
  now?: () => string;
}

type UnknownRow = Record<string, unknown>;

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be text`);
  }
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  return value === null ? null : requireText(value, name);
}

function safeInteger(value: unknown, name: string): number {
  const asNumber = typeof value === "bigint" ? Number(value) : value;
  if (typeof asNumber !== "number" || !Number.isSafeInteger(asNumber)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return asNumber;
}

function nullableSafeInteger(value: unknown, name: string): number | null {
  return value === null ? null : safeInteger(value, name);
}

function nullableInt64Text(value: unknown, name: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  throw new Error(`${name} must be an SQLite integer`);
}

function nullableHashHex(value: unknown, name: string): string | null {
  if (value === null) {
    return null;
  }
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new Error(`${name} must be a 32-byte BLOB`);
  }
  return value.toString("hex");
}

function hexToHash(value: string | undefined): Buffer | null {
  return value === undefined ? null : Buffer.from(value, "hex");
}

function jobKey(state: string, phase: string): string {
  return `${state}/${phase}`;
}

function isTerminalJobState(state: string): boolean {
  return TERMINAL_JOB_STATES.has(state);
}

function batchDto(row: UnknownRow): ImportBatchDto {
  return ImportBatchDtoSchema.parse({
    batchId: requireText(row.batch_id, "import_batches.batch_id"),
    snapshotAt: requireText(row.snapshot_at, "import_batches.snapshot_at"),
    requestedStopAt: nullableText(
      row.requested_stop_at,
      "import_batches.requested_stop_at",
    ),
    state: requireText(row.state, "import_batches.state"),
    totalCount: safeInteger(row.total_count, "import_batches.total_count"),
    completedCount: safeInteger(
      row.completed_count,
      "import_batches.completed_count",
    ),
    failedCount: safeInteger(row.failed_count, "import_batches.failed_count"),
    waitingCount: safeInteger(
      row.waiting_count,
      "import_batches.waiting_count",
    ),
    createdAt: requireText(row.created_at, "import_batches.created_at"),
    updatedAt: requireText(row.updated_at, "import_batches.updated_at"),
  });
}

function jobDto(row: UnknownRow): ImportJobDto {
  return ImportJobDtoSchema.parse({
    jobId: requireText(row.job_id, "import_jobs.job_id"),
    batchId: requireText(row.batch_id, "import_jobs.batch_id"),
    ordinal: safeInteger(row.ordinal, "import_jobs.ordinal"),
    originalFilename: requireText(
      row.original_filename,
      "import_jobs.original_filename",
    ),
    sourceRelativePath: requireText(
      row.source_relative_path,
      "import_jobs.source_relative_path",
    ),
    currentRelativePath: requireText(
      row.current_relative_path,
      "import_jobs.current_relative_path",
    ),
    detectedFormat: nullableText(
      row.detected_format,
      "import_jobs.detected_format",
    ),
    state: requireText(row.state, "import_jobs.state"),
    phase: requireText(row.phase, "import_jobs.phase"),
    sourceSizeBytes: nullableSafeInteger(
      row.source_size_bytes,
      "import_jobs.source_size_bytes",
    ),
    sourceMtimeNs: nullableInt64Text(
      row.source_mtime_ns,
      "import_jobs.source_mtime_ns",
    ),
    sourceSha256Hex: nullableHashHex(
      row.source_sha256,
      "import_jobs.source_sha256",
    ),
    candidateWidth: nullableSafeInteger(
      row.candidate_width,
      "import_jobs.candidate_width",
    ),
    candidateHeight: nullableSafeInteger(
      row.candidate_height,
      "import_jobs.candidate_height",
    ),
    candidateOrientation: nullableSafeInteger(
      row.candidate_orientation,
      "import_jobs.candidate_orientation",
    ),
    possibleDuplicateId: nullableSafeInteger(
      row.possible_duplicate_id,
      "import_jobs.possible_duplicate_id",
    ),
    stagedMetadataJson: requireText(
      row.staged_metadata_json,
      "import_jobs.staged_metadata_json",
    ),
    retryCount: safeInteger(row.retry_count, "import_jobs.retry_count"),
    errorClass: nullableText(row.error_class, "import_jobs.error_class"),
    errorCode: nullableText(row.error_code, "import_jobs.error_code"),
    errorDetailJson: requireText(
      row.error_detail_json,
      "import_jobs.error_detail_json",
    ),
    createdAt: requireText(row.created_at, "import_jobs.created_at"),
    updatedAt: requireText(row.updated_at, "import_jobs.updated_at"),
    completedAt: nullableText(row.completed_at, "import_jobs.completed_at"),
  });
}

function reservationDto(row: UnknownRow): IdReservationDto {
  return IdReservationDtoSchema.parse({
    photoId: safeInteger(row.photo_id, "id_reservations.photo_id"),
    importJobId: requireText(
      row.import_job_id,
      "id_reservations.import_job_id",
    ),
    origin: requireText(row.origin, "id_reservations.origin"),
    state: requireText(row.state, "id_reservations.state"),
    reservedAt: requireText(row.reserved_at, "id_reservations.reserved_at"),
    committedAt: nullableText(row.committed_at, "id_reservations.committed_at"),
    abandonedAt: nullableText(row.abandoned_at, "id_reservations.abandoned_at"),
  });
}

function journalDto(row: UnknownRow) {
  return {
    operationId: requireText(
      row.operation_id,
      "operation_journal.operation_id",
    ),
    operationType: requireText(
      row.operation_type,
      "operation_journal.operation_type",
    ),
    status: requireText(row.status, "operation_journal.status"),
    phase: requireText(row.phase, "operation_journal.phase"),
    photoId: nullableSafeInteger(row.photo_id, "operation_journal.photo_id"),
    importJobId: nullableText(
      row.import_job_id,
      "operation_journal.import_job_id",
    ),
    batchId: nullableText(row.batch_id, "operation_journal.batch_id"),
    sourceRelativePath: nullableText(
      row.source_relative_path,
      "operation_journal.source_relative_path",
    ),
    targetRelativePath: nullableText(
      row.target_relative_path,
      "operation_journal.target_relative_path",
    ),
    temporaryRelativePath: nullableText(
      row.temporary_relative_path,
      "operation_journal.temporary_relative_path",
    ),
    backupRelativePath: nullableText(
      row.backup_relative_path,
      "operation_journal.backup_relative_path",
    ),
    expectedSourceSha256Hex: nullableHashHex(
      row.expected_source_sha256,
      "operation_journal.expected_source_sha256",
    ),
    expectedTargetSha256Hex: nullableHashHex(
      row.expected_target_sha256,
      "operation_journal.expected_target_sha256",
    ),
    payloadJson: requireText(
      row.payload_json,
      "operation_journal.payload_json",
    ),
    createdAt: requireText(row.created_at, "operation_journal.created_at"),
    updatedAt: requireText(row.updated_at, "operation_journal.updated_at"),
    completedAt: nullableText(
      row.completed_at,
      "operation_journal.completed_at",
    ),
    errorClass: nullableText(row.error_class, "operation_journal.error_class"),
    errorCode: nullableText(row.error_code, "operation_journal.error_code"),
  };
}

export class ImportRepository {
  private readonly now: () => string;

  constructor(
    private readonly database: CatalogDatabase,
    options: ImportRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public createBatch(input: CreateImportBatchPayload): CreateImportBatchResult {
    const command = CreateImportBatchPayloadSchema.parse(input);
    this.assertUniqueSnapshotEntries(command);
    const create = this.database.transaction(() => {
      if (this.findBatchRow(command.batchId)) {
        throw new CatalogOperationError(
          "IMPORT_CONFLICT",
          "Import batch ID already exists",
        );
      }
      const timestamp = this.now();
      this.requireAppState();
      this.database
        .prepare(
          `INSERT INTO import_batches (
        batch_id, snapshot_at, requested_stop_at, state, total_count,
        completed_count, failed_count, waiting_count, created_at, updated_at
      ) VALUES (?, ?, NULL, 'queued', ?, 0, 0, 0, ?, ?)`,
        )
        .run(
          command.batchId,
          command.snapshotAt,
          command.entries.length,
          timestamp,
          timestamp,
        );
      const insertJob = this.database.prepare(`INSERT INTO import_jobs (
        job_id, batch_id, ordinal, original_filename, source_relative_path,
        current_relative_path, state, phase, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'discovered', ?, ?)`);
      for (const entry of command.entries) {
        insertJob.run(
          entry.jobId,
          command.batchId,
          entry.ordinal,
          entry.originalFilename,
          entry.sourceRelativePath,
          entry.sourceRelativePath,
          timestamp,
          timestamp,
        );
      }
      const catalogRevision = this.incrementRevision();
      return {
        batch: this.requireBatch(command.batchId),
        jobs: this.listJobsForBatch(command.batchId),
        catalogRevision,
      };
    });
    return create.immediate();
  }

  public getBatch(input: { batchId: string }): ImportBatchDto {
    const command = ImportBatchIdPayloadSchema.parse(input);
    return this.requireBatch(command.batchId);
  }

  public getJob(input: { jobId: string }): ImportJobDto {
    const command = ImportJobIdPayloadSchema.parse(input);
    return this.requireJob(command.jobId);
  }

  public listJobs(input: { batchId: string }): ImportJobDto[] {
    const command = ImportBatchIdPayloadSchema.parse(input);
    this.requireBatch(command.batchId);
    return this.listJobsForBatch(command.batchId);
  }

  public transitionJob(
    input: TransitionImportJobPayload,
  ): ImportJobTransitionResult {
    const command = TransitionImportJobPayloadSchema.parse(input);
    const transition = this.database.transaction(() => {
      const existing = this.requireJob(command.jobId);
      this.assertExpectedJob(existing, command);
      this.assertValidJobTransition(existing, command);
      this.assertJobError(existing, command);
      const next = this.applyJobCommand(existing, command);
      if (this.isJobNoop(existing, next)) {
        return {
          job: existing,
          batch: this.requireBatch(existing.batchId),
          catalogRevision: this.readCatalogRevision(),
        };
      }
      const timestamp = this.now();
      this.database
        .prepare(
          `UPDATE import_jobs SET
        current_relative_path = ?, detected_format = ?, source_size_bytes = ?, source_mtime_ns = ?, source_sha256 = ?,
        candidate_width = ?, candidate_height = ?, candidate_orientation = ?,
        possible_duplicate_id = ?, staged_metadata_json = ?, state = ?, phase = ?,
        error_class = ?, error_code = ?, error_detail_json = ?, updated_at = ?, completed_at = ?
        WHERE job_id = ?`,
        )
        .run(
          next.currentRelativePath,
          next.detectedFormat,
          next.sourceSizeBytes,
          next.sourceMtimeNs === null ? null : BigInt(next.sourceMtimeNs),
          next.sourceSha256Hex === null
            ? null
            : Buffer.from(next.sourceSha256Hex, "hex"),
          next.candidateWidth,
          next.candidateHeight,
          next.candidateOrientation,
          next.possibleDuplicateId,
          next.stagedMetadataJson,
          next.state,
          next.phase,
          next.errorClass,
          next.errorCode,
          next.errorDetailJson,
          timestamp,
          next.completedAt === null ? null : timestamp,
          command.jobId,
        );
      const batch = this.refreshBatch(existing.batchId, timestamp, next.state);
      const catalogRevision = this.incrementRevision();
      return { job: this.requireJob(command.jobId), batch, catalogRevision };
    });
    return transition.immediate();
  }

  public requestStop(input: { batchId: string }): ImportBatchResult {
    const command = ImportBatchIdPayloadSchema.parse(input);
    const requestStop = this.database.transaction(() => {
      const batch = this.requireBatch(command.batchId);
      if (batch.state === "completed" || batch.state === "paused_error") {
        throw new CatalogOperationError(
          "IMPORT_INVALID_STATE",
          "Import batch cannot accept a stop request",
        );
      }
      if (batch.state === "stopping" && batch.requestedStopAt !== null) {
        return { batch, catalogRevision: this.readCatalogRevision() };
      }
      const timestamp = this.now();
      this.database
        .prepare(
          `UPDATE import_batches
        SET state = 'stopping', requested_stop_at = COALESCE(requested_stop_at, ?), updated_at = ?
        WHERE batch_id = ?`,
        )
        .run(timestamp, timestamp, command.batchId);
      const catalogRevision = this.incrementRevision();
      return { batch: this.requireBatch(command.batchId), catalogRevision };
    });
    return requestStop.immediate();
  }

  public reservePhotoId(input: { jobId: string }): IdReservationResult {
    const command = ImportJobIdPayloadSchema.parse(input);
    const reserve = this.database.transaction(() => {
      this.requireJob(command.jobId);
      const existing = this.findReservationByJob(command.jobId);
      if (existing) {
        return {
          reservation: existing,
          catalogRevision: this.readCatalogRevision(),
        };
      }
      const timestamp = this.now();
      const result = this.database
        .prepare(
          `INSERT INTO id_reservations
        (import_job_id, origin, state, reserved_at, committed_at, abandoned_at)
        VALUES (?, 'import', 'reserved', ?, NULL, NULL)`,
        )
        .run(command.jobId, timestamp);
      const photoId = safeInteger(
        result.lastInsertRowid,
        "id_reservations.photo_id",
      );
      const catalogRevision = this.incrementRevision();
      return { reservation: this.requireReservation(photoId), catalogRevision };
    });
    return reserve.immediate();
  }

  public commitReservation(input: { jobId: string }): IdReservationResult {
    return this.updateReservationState(input, "committed");
  }

  public abandonReservation(input: { jobId: string }): IdReservationResult {
    return this.updateReservationState(input, "abandoned");
  }

  public createJournalIntent(input: CreateJournalIntentPayload): JournalResult {
    const command = CreateJournalIntentPayloadSchema.parse(input);
    const create = this.database.transaction(() => {
      const existing = this.findJournal(command.operationId);
      if (existing) {
        if (existing.operationType !== command.operationType) {
          throw new CatalogOperationError(
            "IMPORT_CONFLICT",
            "Journal operation ID already exists",
          );
        }
        return {
          journal: existing,
          catalogRevision: this.readCatalogRevision(),
        };
      }
      this.assertJournalIntentReferences(command);
      const timestamp = this.now();
      this.database
        .prepare(
          `INSERT INTO operation_journal (
        operation_id, operation_type, status, phase, photo_id, import_job_id, batch_id,
        source_relative_path, target_relative_path, temporary_relative_path, backup_relative_path,
        expected_source_sha256, expected_target_sha256, payload_json,
        user_authorized_at, created_at, updated_at, completed_at, error_class, error_code
      ) VALUES (?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          command.operationId,
          command.operationType,
          command.phase,
          command.photoId ?? null,
          command.importJobId ?? null,
          command.batchId ?? null,
          command.sourceRelativePath ?? null,
          command.targetRelativePath ?? null,
          command.temporaryRelativePath ?? null,
          command.backupRelativePath ?? null,
          hexToHash(command.expectedSourceSha256Hex),
          hexToHash(command.expectedTargetSha256Hex),
          command.payloadJson ?? "{}",
          timestamp,
          timestamp,
        );
      const catalogRevision = this.incrementRevision();
      return {
        journal: this.requireJournal(command.operationId),
        catalogRevision,
      };
    });
    return JournalResultSchema.parse(create.immediate());
  }

  public transitionJournal(input: TransitionJournalPayload): JournalResult {
    const command = TransitionJournalPayloadSchema.parse(input);
    const transition = this.database.transaction(() => {
      const existing = this.requireJournal(command.operationId);
      if (
        command.expectedStatus !== undefined &&
        command.expectedStatus !== existing.status
      ) {
        throw new CatalogOperationError(
          "IMPORT_STALE_TRANSITION",
          "Journal status no longer matches the expected status",
        );
      }
      if (command.status === existing.status) {
        return {
          journal: existing,
          catalogRevision: this.readCatalogRevision(),
        };
      }
      if (
        !VALID_JOURNAL_TRANSITIONS[existing.status].includes(command.status)
      ) {
        throw new CatalogOperationError(
          "IMPORT_INVALID_TRANSITION",
          "Journal status transition is not allowed",
        );
      }
      const needsError =
        command.status === "failed" || command.status === "recovery_required";
      if (
        needsError !==
        (command.errorClass !== undefined || command.errorCode !== undefined)
      ) {
        throw new CatalogOperationError(
          "IMPORT_INVALID_STATE",
          "Journal failure states require an error class and code",
        );
      }
      if (
        needsError &&
        (command.errorClass === undefined || command.errorCode === undefined)
      ) {
        throw new CatalogOperationError(
          "IMPORT_INVALID_STATE",
          "Journal failure states require an error class and code",
        );
      }
      if (
        !needsError &&
        (command.errorClass !== undefined || command.errorCode !== undefined)
      ) {
        throw new CatalogOperationError(
          "IMPORT_INVALID_STATE",
          "Only journal failure states may include an error",
        );
      }
      const timestamp = this.now();
      this.database
        .prepare(
          `UPDATE operation_journal SET
        status = ?, updated_at = ?, completed_at = ?, error_class = ?, error_code = ?
        WHERE operation_id = ?`,
        )
        .run(
          command.status,
          timestamp,
          command.status === "completed" ? timestamp : null,
          command.errorClass ?? null,
          command.errorCode ?? null,
          command.operationId,
        );
      const catalogRevision = this.incrementRevision();
      return {
        journal: this.requireJournal(command.operationId),
        catalogRevision,
      };
    });
    return JournalResultSchema.parse(transition.immediate());
  }

  private updateReservationState(
    input: { jobId: string },
    nextState: "committed" | "abandoned",
  ): IdReservationResult {
    const command = ImportJobIdPayloadSchema.parse(input);
    const update = this.database.transaction(() => {
      const reservation = this.findReservationByJob(command.jobId);
      if (!reservation) {
        throw new CatalogOperationError(
          "IMPORT_NOT_FOUND",
          "Import job has no ID reservation",
        );
      }
      if (reservation.state === nextState) {
        return { reservation, catalogRevision: this.readCatalogRevision() };
      }
      if (reservation.state !== "reserved") {
        throw new CatalogOperationError(
          "IMPORT_INVALID_STATE",
          "ID reservation is terminal and cannot change state",
        );
      }
      if (nextState === "abandoned") {
        const job = this.requireJob(command.jobId);
        if (job.state !== "failed" && job.state !== "stopped") {
          throw new CatalogOperationError(
            "IMPORT_INVALID_STATE",
            "Only failed or stopped import jobs may abandon an ID reservation",
          );
        }
      }
      if (nextState === "committed") {
        const photo = this.database
          .prepare("SELECT photo_id FROM photos WHERE photo_id = ?")
          .get(reservation.photoId);
        if (!photo) {
          throw new CatalogOperationError(
            "IMPORT_INVALID_STATE",
            "An ID reservation may be committed only with its corresponding photo row",
          );
        }
      }
      const timestamp = this.now();
      this.database
        .prepare(
          `UPDATE id_reservations
        SET state = ?, committed_at = ?, abandoned_at = ? WHERE import_job_id = ?`,
        )
        .run(
          nextState,
          nextState === "committed" ? timestamp : null,
          nextState === "abandoned" ? timestamp : null,
          command.jobId,
        );
      const catalogRevision = this.incrementRevision();
      return {
        reservation: this.requireReservation(reservation.photoId),
        catalogRevision,
      };
    });
    return update.immediate();
  }

  private assertUniqueSnapshotEntries(command: CreateImportBatchPayload): void {
    const ordinals = new Set<number>();
    const sourcePaths = new Set<string>();
    for (const entry of command.entries) {
      if (ordinals.has(entry.ordinal)) {
        throw new CatalogOperationError(
          "IMPORT_CONFLICT",
          "Import batch contains duplicate ordinals",
        );
      }
      if (sourcePaths.has(entry.sourceRelativePath)) {
        throw new CatalogOperationError(
          "IMPORT_CONFLICT",
          "Import batch contains duplicate source paths",
        );
      }
      ordinals.add(entry.ordinal);
      sourcePaths.add(entry.sourceRelativePath);
    }
  }

  private assertExpectedJob(
    existing: ImportJobDto,
    command: TransitionImportJobPayload,
  ): void {
    if (
      (command.expectedState !== undefined &&
        command.expectedState !== existing.state) ||
      (command.expectedPhase !== undefined &&
        command.expectedPhase !== existing.phase)
    ) {
      throw new CatalogOperationError(
        "IMPORT_STALE_TRANSITION",
        "Import job no longer matches the expected state or phase",
      );
    }
  }

  private assertValidJobTransition(
    existing: ImportJobDto,
    command: TransitionImportJobPayload,
  ): void {
    const existingKey = jobKey(existing.state, existing.phase);
    const nextKey = jobKey(command.state, command.phase);
    if (existingKey === nextKey) {
      return;
    }
    if (
      isTerminalJobState(existing.state) ||
      !VALID_JOB_TRANSITIONS[existingKey]?.includes(nextKey)
    ) {
      throw new CatalogOperationError(
        "IMPORT_INVALID_TRANSITION",
        "Import job state transition is not allowed",
      );
    }
  }

  private assertJobError(
    existing: ImportJobDto,
    command: TransitionImportJobPayload,
  ): void {
    if (command.state === "failed") {
      if (
        jobKey(existing.state, existing.phase) !==
          jobKey(command.state, command.phase) &&
        !command.error
      ) {
        throw new CatalogOperationError(
          "IMPORT_INVALID_STATE",
          "Failed import jobs require error details",
        );
      }
      return;
    }
    if (command.error) {
      throw new CatalogOperationError(
        "IMPORT_INVALID_STATE",
        "Only failed import jobs may include error details",
      );
    }
  }

  private applyJobCommand(
    existing: ImportJobDto,
    command: TransitionImportJobPayload,
  ): ImportJobDto {
    const measurements = command.measurements;
    const terminal = isTerminalJobState(command.state);
    return {
      ...existing,
      state: command.state,
      phase: command.phase,
      currentRelativePath:
        command.currentRelativePath ?? existing.currentRelativePath,
      detectedFormat: measurements?.detectedFormat ?? existing.detectedFormat,
      sourceSizeBytes:
        measurements?.sourceSizeBytes ?? existing.sourceSizeBytes,
      sourceMtimeNs: measurements?.sourceMtimeNs ?? existing.sourceMtimeNs,
      sourceSha256Hex:
        measurements?.sourceSha256Hex ?? existing.sourceSha256Hex,
      candidateWidth: measurements?.candidateWidth ?? existing.candidateWidth,
      candidateHeight:
        measurements?.candidateHeight ?? existing.candidateHeight,
      candidateOrientation:
        measurements?.candidateOrientation ?? existing.candidateOrientation,
      possibleDuplicateId:
        measurements &&
        Object.prototype.hasOwnProperty.call(
          measurements,
          "possibleDuplicateId",
        )
          ? (measurements.possibleDuplicateId ?? null)
          : existing.possibleDuplicateId,
      stagedMetadataJson:
        measurements?.stagedMetadataJson ?? existing.stagedMetadataJson,
      errorClass:
        command.state === "failed"
          ? (command.error?.errorClass ?? existing.errorClass)
          : null,
      errorCode:
        command.state === "failed"
          ? (command.error?.errorCode ?? existing.errorCode)
          : null,
      errorDetailJson:
        command.state === "failed"
          ? (command.error?.errorDetailJson ?? existing.errorDetailJson)
          : existing.errorDetailJson,
      completedAt: terminal
        ? (existing.completedAt ?? "__set_on_update__")
        : null,
      updatedAt: "__set_on_update__",
    };
  }

  private isJobNoop(existing: ImportJobDto, next: ImportJobDto): boolean {
    return (
      JSON.stringify({ ...existing, updatedAt: "__set_on_update__" }) ===
      JSON.stringify(next)
    );
  }

  private refreshBatch(
    batchId: string,
    timestamp: string,
    latestJobState: string,
  ): ImportBatchDto {
    const batch = this.requireBatch(batchId);
    const counts = this.database
      .prepare(
        `SELECT
      SUM(CASE WHEN state IN ('completed', 'duplicate_completed') THEN 1 ELSE 0 END) AS completed_count,
      SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN state = 'waiting' THEN 1 ELSE 0 END) AS waiting_count,
      SUM(CASE WHEN state IN ('failed', 'completed', 'duplicate_completed', 'stopped') THEN 1 ELSE 0 END) AS terminal_count
      FROM import_jobs WHERE batch_id = ?`,
      )
      .get(batchId) as UnknownRow;
    const completedCount = safeInteger(
      counts.completed_count,
      "import_batches.completed_count",
    );
    const failedCount = safeInteger(
      counts.failed_count,
      "import_batches.failed_count",
    );
    const waitingCount = safeInteger(
      counts.waiting_count,
      "import_batches.waiting_count",
    );
    const terminalCount = safeInteger(
      counts.terminal_count,
      "import_batches.terminal_count",
    );
    let state = batch.state;
    if (latestJobState === "failed") {
      state = "paused_error";
    } else if (
      terminalCount === batch.totalCount &&
      batch.state !== "paused_error"
    ) {
      state = "completed";
    } else if (batch.state === "queued" && latestJobState !== "queued") {
      state = "running";
    }
    this.database
      .prepare(
        `UPDATE import_batches SET
      state = ?, completed_count = ?, failed_count = ?, waiting_count = ?, updated_at = ?
      WHERE batch_id = ?`,
      )
      .run(
        state,
        completedCount,
        failedCount,
        waitingCount,
        timestamp,
        batchId,
      );
    return this.requireBatch(batchId);
  }

  private assertJournalIntentReferences(
    command: CreateJournalIntentPayload,
  ): void {
    if (command.operationType === "import_move") {
      if (
        !command.importJobId ||
        !command.batchId ||
        !command.sourceRelativePath ||
        !command.targetRelativePath ||
        !command.expectedSourceSha256Hex
      ) {
        throw new CatalogOperationError(
          "IMPORT_INVALID_STATE",
          "Import move intent requires job, batch, source, target, and expected source hash",
        );
      }
      const job = this.requireJob(command.importJobId);
      if (job.batchId !== command.batchId) {
        throw new CatalogOperationError(
          "IMPORT_CONFLICT",
          "Journal import batch does not match its import job",
        );
      }
      return;
    }
    if (
      !command.photoId ||
      !command.targetRelativePath ||
      !command.expectedTargetSha256Hex
    ) {
      throw new CatalogOperationError(
        "IMPORT_INVALID_STATE",
        "Thumbnail replacement intent requires photo, target, and expected target hash",
      );
    }
    this.requireReservation(command.photoId);
  }

  private requireAppState(): void {
    if (
      !this.database
        .prepare("SELECT 1 FROM app_state WHERE singleton = 1")
        .get()
    ) {
      throw new CatalogOperationError(
        "CATALOG_STATE",
        "Catalog is missing the required app_state singleton",
      );
    }
  }

  private incrementRevision(): number {
    this.requireAppState();
    const result = this.database
      .prepare(
        `UPDATE app_state
      SET catalog_revision = catalog_revision + 1 WHERE singleton = 1`,
      )
      .run();
    if (result.changes !== 1) {
      throw new CatalogOperationError(
        "CATALOG_STATE",
        "Catalog revision could not be updated",
      );
    }
    return this.readCatalogRevision();
  }

  private readCatalogRevision(): number {
    const row = this.database
      .prepare("SELECT catalog_revision FROM app_state WHERE singleton = 1")
      .get() as UnknownRow | undefined;
    if (!row) {
      throw new CatalogOperationError(
        "CATALOG_STATE",
        "Catalog is missing the required app_state singleton",
      );
    }
    const revision = safeInteger(
      row.catalog_revision,
      "app_state.catalog_revision",
    );
    if (revision < 0) {
      throw new CatalogOperationError(
        "CATALOG_STATE",
        "Catalog revision must not be negative",
      );
    }
    return revision;
  }

  private findBatchRow(batchId: string): UnknownRow | undefined {
    return this.database
      .prepare("SELECT * FROM import_batches WHERE batch_id = ?")
      .get(batchId) as UnknownRow | undefined;
  }

  private requireBatch(batchId: string): ImportBatchDto {
    const row = this.findBatchRow(batchId);
    if (!row) {
      throw new CatalogOperationError(
        "IMPORT_NOT_FOUND",
        "Import batch was not found",
      );
    }
    return batchDto(row);
  }

  private findJobRow(jobId: string): UnknownRow | undefined {
    return this.database
      .prepare("SELECT * FROM import_jobs WHERE job_id = ?")
      .get(jobId) as UnknownRow | undefined;
  }

  private requireJob(jobId: string): ImportJobDto {
    const row = this.findJobRow(jobId);
    if (!row) {
      throw new CatalogOperationError(
        "IMPORT_NOT_FOUND",
        "Import job was not found",
      );
    }
    return jobDto(row);
  }

  private listJobsForBatch(batchId: string): ImportJobDto[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM import_jobs WHERE batch_id = ? ORDER BY ordinal",
        )
        .all(batchId) as UnknownRow[]
    ).map(jobDto);
  }

  private findReservationByJob(jobId: string): IdReservationDto | undefined {
    const row = this.database
      .prepare("SELECT * FROM id_reservations WHERE import_job_id = ?")
      .get(jobId) as UnknownRow | undefined;
    return row ? reservationDto(row) : undefined;
  }

  private requireReservation(photoId: number): IdReservationDto {
    const row = this.database
      .prepare("SELECT * FROM id_reservations WHERE photo_id = ?")
      .get(photoId) as UnknownRow | undefined;
    if (!row) {
      throw new CatalogOperationError(
        "IMPORT_NOT_FOUND",
        "Photo ID reservation was not found",
      );
    }
    return reservationDto(row);
  }

  private findJournal(operationId: string) {
    const row = this.database
      .prepare("SELECT * FROM operation_journal WHERE operation_id = ?")
      .get(operationId) as UnknownRow | undefined;
    return row ? journalDto(row) : undefined;
  }

  private requireJournal(operationId: string) {
    const journal = this.findJournal(operationId);
    if (!journal) {
      throw new CatalogOperationError(
        "IMPORT_NOT_FOUND",
        "Journal operation was not found",
      );
    }
    return journal;
  }
}
