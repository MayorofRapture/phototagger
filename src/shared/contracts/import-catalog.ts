import { z } from "zod";

const UUID_SCHEMA = z.string().uuid();
const ISO_TIMESTAMP_SCHEMA = z.string().datetime({ offset: true });
const POSITIVE_SAFE_INTEGER_SCHEMA = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger);
const NON_NEGATIVE_SAFE_INTEGER_SCHEMA = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger);
const SIGNED_INT64_TEXT_SCHEMA = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const SHA256_HEX_SCHEMA = z.string().regex(/^[0-9a-f]{64}$/i);

/** A portable Collection-relative path, persisted with forward slash separators. */
export const CollectionRelativePathSchema = z
  .string()
  .min(1)
  .max(32767)
  .refine((value) => {
    if (
      value.includes("\\") ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      /[\u0000-\u001f]/.test(value)
    ) {
      return false;
    }
    return value
      .split("/")
      .every(
        (segment) => segment.length > 0 && segment !== "." && segment !== "..",
      );
  }, "Path must be a safe Collection-relative path using forward slash separators");

export const ImportBatchStateSchema = z.enum([
  "queued",
  "running",
  "stopping",
  "completed",
  "paused_error",
]);
export type ImportBatchStateDto = z.infer<typeof ImportBatchStateSchema>;

export const ImportJobStateSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "failed",
  "completed",
  "duplicate_completed",
  "stopped",
]);
export type ImportJobStateDto = z.infer<typeof ImportJobStateSchema>;

export const ImportJobPhaseSchema = z.enum([
  "discovered",
  "waiting_stable",
  "validating",
  "hashing",
  "duplicate_check",
  "id_reserved",
  "moving",
  "converting",
  "stored_verification",
  "thumbnail_generation",
  "catalog_commit",
  "source_cleanup",
  "terminal",
]);
export type ImportJobPhaseDto = z.infer<typeof ImportJobPhaseSchema>;

export const ImportDetectedFormatSchema = z.enum([
  "jpeg",
  "png",
  "webp",
  "gif",
  "unsupported",
]);

const JsonTextSchema = z
  .string()
  .max(1_000_000)
  .refine((value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, "Value must be valid JSON text");

export const ImportSnapshotEntrySchema = z
  .object({
    jobId: UUID_SCHEMA,
    ordinal: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
    originalFilename: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) => !/[\\/\u0000-\u001f]/.test(value),
        "Original filename must be a filename, not a path",
      ),
    sourceRelativePath: CollectionRelativePathSchema,
  })
  .strict();
export type ImportSnapshotEntryDto = z.infer<typeof ImportSnapshotEntrySchema>;

export const CreateImportBatchPayloadSchema = z
  .object({
    batchId: UUID_SCHEMA,
    snapshotAt: ISO_TIMESTAMP_SCHEMA,
    entries: z.array(ImportSnapshotEntrySchema).min(1).max(100_000),
  })
  .strict();
export type CreateImportBatchPayload = z.infer<
  typeof CreateImportBatchPayloadSchema
>;

export const ImportBatchIdPayloadSchema = z
  .object({ batchId: UUID_SCHEMA })
  .strict();
export const ImportJobIdPayloadSchema = z
  .object({ jobId: UUID_SCHEMA })
  .strict();

export const ImportJobMeasurementsSchema = z
  .object({
    detectedFormat: ImportDetectedFormatSchema.optional(),
    sourceSizeBytes: NON_NEGATIVE_SAFE_INTEGER_SCHEMA.optional(),
    sourceMtimeNs: SIGNED_INT64_TEXT_SCHEMA.optional(),
    sourceSha256Hex: SHA256_HEX_SCHEMA.optional(),
    candidateWidth: POSITIVE_SAFE_INTEGER_SCHEMA.optional(),
    candidateHeight: POSITIVE_SAFE_INTEGER_SCHEMA.optional(),
    candidateOrientation: z.number().int().min(1).max(8).optional(),
    possibleDuplicateId: POSITIVE_SAFE_INTEGER_SCHEMA.nullable().optional(),
    stagedMetadataJson: JsonTextSchema.optional(),
  })
  .strict();

export const ImportJobErrorSchema = z
  .object({
    errorClass: z.string().min(1).max(128),
    errorCode: z.string().min(1).max(128),
    errorDetailJson: JsonTextSchema.optional(),
  })
  .strict();

export const TransitionImportJobPayloadSchema = z
  .object({
    jobId: UUID_SCHEMA,
    expectedState: ImportJobStateSchema.optional(),
    expectedPhase: ImportJobPhaseSchema.optional(),
    state: ImportJobStateSchema,
    phase: ImportJobPhaseSchema,
    currentRelativePath: CollectionRelativePathSchema.optional(),
    measurements: ImportJobMeasurementsSchema.optional(),
    error: ImportJobErrorSchema.optional(),
  })
  .strict();
export type TransitionImportJobPayload = z.infer<
  typeof TransitionImportJobPayloadSchema
>;

export const IdReservationStateSchema = z.enum([
  "reserved",
  "committed",
  "abandoned",
]);
export type IdReservationStateDto = z.infer<typeof IdReservationStateSchema>;

/**
 * M2D boundary only. M2A deliberately does not execute this final catalog commit,
 * because the coordinator must first verify the stored JPEG and external thumbnail.
 */
export const FinalJpegCatalogCommitInputSchema = z
  .object({
    jobId: UUID_SCHEMA,
    photoId: POSITIVE_SAFE_INTEGER_SCHEMA,
    sourceSha256Hex: SHA256_HEX_SCHEMA,
    currentFileSha256Hex: SHA256_HEX_SCHEMA,
    imageDataSha256Hex: SHA256_HEX_SCHEMA,
    observedSizeBytes: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
    observedMtimeNs: SIGNED_INT64_TEXT_SCHEMA,
    width: POSITIVE_SAFE_INTEGER_SCHEMA,
    height: POSITIVE_SAFE_INTEGER_SCHEMA,
    displayOrientation: z.number().int().min(1).max(8),
    importedAt: ISO_TIMESTAMP_SCHEMA,
  })
  .strict();
export type FinalJpegCatalogCommitInput = z.infer<
  typeof FinalJpegCatalogCommitInputSchema
>;

export const JournalOperationTypeSchema = z.enum([
  "import_move",
  "thumbnail_replace",
]);
export type JournalOperationTypeDto = z.infer<
  typeof JournalOperationTypeSchema
>;

export const JournalStatusSchema = z.enum([
  "planned",
  "mutating",
  "verifying",
  "cleanup",
  "completed",
  "failed",
  "recovery_required",
]);
export type JournalStatusDto = z.infer<typeof JournalStatusSchema>;

export const CreateJournalIntentPayloadSchema = z
  .object({
    operationId: UUID_SCHEMA,
    operationType: JournalOperationTypeSchema,
    phase: z.string().min(1).max(128),
    photoId: POSITIVE_SAFE_INTEGER_SCHEMA.optional(),
    importJobId: UUID_SCHEMA.optional(),
    batchId: UUID_SCHEMA.optional(),
    sourceRelativePath: CollectionRelativePathSchema.optional(),
    targetRelativePath: CollectionRelativePathSchema.optional(),
    temporaryRelativePath: CollectionRelativePathSchema.optional(),
    backupRelativePath: CollectionRelativePathSchema.optional(),
    expectedSourceSha256Hex: SHA256_HEX_SCHEMA.optional(),
    expectedTargetSha256Hex: SHA256_HEX_SCHEMA.optional(),
    payloadJson: JsonTextSchema.optional(),
  })
  .strict();
export type CreateJournalIntentPayload = z.infer<
  typeof CreateJournalIntentPayloadSchema
>;

export const TransitionJournalPayloadSchema = z
  .object({
    operationId: UUID_SCHEMA,
    expectedStatus: JournalStatusSchema.optional(),
    status: JournalStatusSchema,
    errorClass: z.string().min(1).max(128).optional(),
    errorCode: z.string().min(1).max(128).optional(),
  })
  .strict();
export type TransitionJournalPayload = z.infer<
  typeof TransitionJournalPayloadSchema
>;

export const ImportBatchDtoSchema = z
  .object({
    batchId: UUID_SCHEMA,
    snapshotAt: ISO_TIMESTAMP_SCHEMA,
    requestedStopAt: ISO_TIMESTAMP_SCHEMA.nullable(),
    state: ImportBatchStateSchema,
    totalCount: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
    completedCount: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
    failedCount: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
    waitingCount: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
    createdAt: ISO_TIMESTAMP_SCHEMA,
    updatedAt: ISO_TIMESTAMP_SCHEMA,
  })
  .strict();
export type ImportBatchDto = z.infer<typeof ImportBatchDtoSchema>;

export const ImportJobDtoSchema = z
  .object({
    jobId: UUID_SCHEMA,
    batchId: UUID_SCHEMA,
    ordinal: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
    originalFilename: z.string().min(1),
    sourceRelativePath: CollectionRelativePathSchema,
    currentRelativePath: CollectionRelativePathSchema,
    detectedFormat: ImportDetectedFormatSchema.nullable(),
    state: ImportJobStateSchema,
    phase: ImportJobPhaseSchema,
    sourceSizeBytes: NON_NEGATIVE_SAFE_INTEGER_SCHEMA.nullable(),
    sourceMtimeNs: SIGNED_INT64_TEXT_SCHEMA.nullable(),
    sourceSha256Hex: SHA256_HEX_SCHEMA.nullable(),
    candidateWidth: POSITIVE_SAFE_INTEGER_SCHEMA.nullable(),
    candidateHeight: POSITIVE_SAFE_INTEGER_SCHEMA.nullable(),
    candidateOrientation: z.number().int().min(1).max(8).nullable(),
    possibleDuplicateId: POSITIVE_SAFE_INTEGER_SCHEMA.nullable(),
    stagedMetadataJson: JsonTextSchema,
    retryCount: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
    errorClass: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorDetailJson: JsonTextSchema,
    createdAt: ISO_TIMESTAMP_SCHEMA,
    updatedAt: ISO_TIMESTAMP_SCHEMA,
    completedAt: ISO_TIMESTAMP_SCHEMA.nullable(),
  })
  .strict();
export type ImportJobDto = z.infer<typeof ImportJobDtoSchema>;

export const IdReservationDtoSchema = z
  .object({
    photoId: POSITIVE_SAFE_INTEGER_SCHEMA,
    importJobId: UUID_SCHEMA,
    origin: z.literal("import"),
    state: IdReservationStateSchema,
    reservedAt: ISO_TIMESTAMP_SCHEMA,
    committedAt: ISO_TIMESTAMP_SCHEMA.nullable(),
    abandonedAt: ISO_TIMESTAMP_SCHEMA.nullable(),
  })
  .strict();
export type IdReservationDto = z.infer<typeof IdReservationDtoSchema>;

export const OperationJournalDtoSchema = z
  .object({
    operationId: UUID_SCHEMA,
    operationType: JournalOperationTypeSchema,
    status: JournalStatusSchema,
    phase: z.string().min(1),
    photoId: POSITIVE_SAFE_INTEGER_SCHEMA.nullable(),
    importJobId: UUID_SCHEMA.nullable(),
    batchId: UUID_SCHEMA.nullable(),
    sourceRelativePath: CollectionRelativePathSchema.nullable(),
    targetRelativePath: CollectionRelativePathSchema.nullable(),
    temporaryRelativePath: CollectionRelativePathSchema.nullable(),
    backupRelativePath: CollectionRelativePathSchema.nullable(),
    expectedSourceSha256Hex: SHA256_HEX_SCHEMA.nullable(),
    expectedTargetSha256Hex: SHA256_HEX_SCHEMA.nullable(),
    payloadJson: JsonTextSchema,
    createdAt: ISO_TIMESTAMP_SCHEMA,
    updatedAt: ISO_TIMESTAMP_SCHEMA,
    completedAt: ISO_TIMESTAMP_SCHEMA.nullable(),
    errorClass: z.string().nullable(),
    errorCode: z.string().nullable(),
  })
  .strict();
export type OperationJournalDto = z.infer<typeof OperationJournalDtoSchema>;

export const CreateImportBatchResultSchema = z
  .object({
    batch: ImportBatchDtoSchema,
    jobs: z.array(ImportJobDtoSchema),
    catalogRevision: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
  })
  .strict();
export type CreateImportBatchResult = z.infer<
  typeof CreateImportBatchResultSchema
>;

export const ImportBatchResultSchema = z
  .object({
    batch: ImportBatchDtoSchema,
    catalogRevision: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
  })
  .strict();
export type ImportBatchResult = z.infer<typeof ImportBatchResultSchema>;

export const ImportJobTransitionResultSchema = z
  .object({
    job: ImportJobDtoSchema,
    batch: ImportBatchDtoSchema,
    catalogRevision: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
  })
  .strict();
export type ImportJobTransitionResult = z.infer<
  typeof ImportJobTransitionResultSchema
>;

export const IdReservationResultSchema = z
  .object({
    reservation: IdReservationDtoSchema,
    catalogRevision: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
  })
  .strict();
export type IdReservationResult = z.infer<typeof IdReservationResultSchema>;

export const JournalResultSchema = z
  .object({
    journal: OperationJournalDtoSchema,
    catalogRevision: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
  })
  .strict();
export type JournalResult = z.infer<typeof JournalResultSchema>;
