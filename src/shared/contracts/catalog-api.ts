import { z } from 'zod';

const MAX_EXACT_ID_LIST_LENGTH = 10_000;
const MAX_CURSOR_LENGTH = 16_384;

const PositiveSafeIntegerSchema = z.number().int().positive().refine(Number.isSafeInteger);
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);
const QueryFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
const SelectionIdSchema = z.string().uuid();
const ViewSessionIdSchema = z.string().uuid();

export const GeneralSettingsDtoSchema = z
  .object({
    jpegQuality: z.number().int().min(1).max(100),
    alphaBackground: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    defaultOrder: z.enum([
      'newest-imported',
      'oldest-imported',
      'original-filename-asc',
      'original-filename-desc',
    ]),
    warningThreshold: z.number().int().min(1).max(100_000),
  })
  .strict();

export type GeneralSettingsDto = z.infer<typeof GeneralSettingsDtoSchema>;

export const SettingsWarningDtoSchema = z
  .object({
    key: z.enum([
      'conversion.jpegQuality',
      'conversion.alphaBackground',
      'library.defaultOrder',
      'batch.warningThreshold',
    ]),
    reason: z.enum(['missing', 'invalid value']),
  })
  .strict();

export type SettingsWarningDto = z.infer<typeof SettingsWarningDtoSchema>;

export const ReadGeneralSettingsResultDtoSchema = z
  .object({
    settings: GeneralSettingsDtoSchema,
    warnings: z.array(SettingsWarningDtoSchema).max(4),
  })
  .strict();

export type ReadGeneralSettingsResultDto = z.infer<typeof ReadGeneralSettingsResultDtoSchema>;

export const TagPathDtoSchema = z
  .object({
    tagId: PositiveSafeIntegerSchema,
    parentTagId: PositiveSafeIntegerSchema.nullable(),
    displayName: z.string(),
    fullPath: z.string(),
    depth: z.number().int().min(1).max(12).refine(Number.isSafeInteger),
    childCount: NonNegativeSafeIntegerSchema,
    pinned: z.boolean(),
    legacyFlatOnly: z.boolean(),
  })
  .strict();

export type TagPathDto = z.infer<typeof TagPathDtoSchema>;

export const TagSuggestionDtoSchema = TagPathDtoSchema;
export type TagSuggestionDto = TagPathDto;

export const LibraryOrderSchema = z.enum([
  'newest-imported',
  'oldest-imported',
  'original-filename-asc',
  'original-filename-desc',
]);

export type LibraryOrderDto = z.infer<typeof LibraryOrderSchema>;

export const LibraryQueryDtoSchema = z
  .object({
    tagIds: z.array(PositiveSafeIntegerSchema).max(MAX_EXACT_ID_LIST_LENGTH),
    flaggedOnly: z.boolean(),
    order: LibraryOrderSchema,
  })
  .strict();

export type LibraryQueryDto = z.infer<typeof LibraryQueryDtoSchema>;

export const LibraryPageOptionsDtoSchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(MAX_CURSOR_LENGTH)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable()
      .optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export type LibraryPageOptionsDto = z.infer<typeof LibraryPageOptionsDtoSchema>;

export const PhotoSummaryDtoSchema = z
  .object({
    photoId: PositiveSafeIntegerSchema,
    canonicalFilename: z.string().min(1),
    originalFilename: z.string().min(1),
    flagged: z.boolean(),
    integrityState: z.enum([
      'clean',
      'missing',
      'unreadable',
      'metadata_conflict',
      'content_conflict',
      'recovery_required',
    ]),
    width: PositiveSafeIntegerSchema,
    height: PositiveSafeIntegerSchema,
    contentRevision: PositiveSafeIntegerSchema,
    thumbnailRevision: PositiveSafeIntegerSchema,
    thumbnailUrl: z.string().regex(/^pt-photo:\/\/thumb\/[1-9][0-9]*\?thumb=[1-9][0-9]*$/),
  })
  .strict();

export type PhotoSummaryDto = z.infer<typeof PhotoSummaryDtoSchema>;

export const PhotoDetailDtoSchema = PhotoSummaryDtoSchema.extend({
  lifecycleState: z.enum(['active', 'trashed']),
  fullImageUrl: z
    .string()
    .regex(/^pt-photo:\/\/full\/[1-9][0-9]*\?content=[1-9][0-9]*$/)
    .optional(),
  explicitTags: z.array(TagPathDtoSchema).max(MAX_EXACT_ID_LIST_LENGTH),
  desiredMetadataRevision: NonNegativeSafeIntegerSchema,
  syncedMetadataRevision: NonNegativeSafeIntegerSchema,
  metadataState: z.enum([
    'synchronized',
    'pending',
    'writing',
    'failed',
    'suspended_conflict',
    'synchronized_with_warning',
  ]),
  importedAt: z.string().datetime({ offset: true }),
  lastVerifiedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type PhotoDetailDto = z.infer<typeof PhotoDetailDtoSchema>;

export const LibraryPageResultDtoSchema = z
  .object({
    queryFingerprint: QueryFingerprintSchema,
    totalCount: NonNegativeSafeIntegerSchema,
    photos: z.array(PhotoSummaryDtoSchema).max(200),
    nextCursor: z
      .string()
      .min(1)
      .max(MAX_CURSOR_LENGTH)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable(),
  })
  .strict();

export type LibraryPageResultDto = z.infer<typeof LibraryPageResultDtoSchema>;

export const SelectionSeedDtoSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('all') }).strict(),
  z
    .object({
      type: z.literal('one'),
      photoId: PositiveSafeIntegerSchema,
    })
    .strict(),
]);

export type SelectionSeedDto = z.infer<typeof SelectionSeedDtoSchema>;

export const SelectionRefDtoSchema = z
  .object({
    selectionId: SelectionIdSchema,
    count: NonNegativeSafeIntegerSchema,
    catalogRevisionAtCapture: NonNegativeSafeIntegerSchema,
  })
  .strict();

export type SelectionRefDto = z.infer<typeof SelectionRefDtoSchema>;

export const SettingsReadPayloadSchema = z.object({}).strict();

export const TagSuggestionsPayloadSchema = z
  .object({
    query: z
      .string()
      .refine(
        (value) => new TextEncoder().encode(value).length <= 768,
        'Tag suggestion query exceeds 768 UTF-8 bytes'
      ),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const LibraryQueryPayloadSchema = z
  .object({
    query: LibraryQueryDtoSchema,
    options: LibraryPageOptionsDtoSchema.optional(),
  })
  .strict();

export const SelectionCreatePayloadSchema = z
  .object({
    queryFingerprint: QueryFingerprintSchema,
    seed: SelectionSeedDtoSchema,
  })
  .strict();

export const SelectionUpdatePayloadSchema = z
  .object({
    selectionId: SelectionIdSchema,
    photoIds: z.array(PositiveSafeIntegerSchema).max(MAX_EXACT_ID_LIST_LENGTH),
    selected: z.boolean(),
  })
  .strict();

export const SelectionGetPayloadSchema = z
  .object({
    selectionId: SelectionIdSchema,
  })
  .strict();

export const SelectionClearPayloadSchema = SelectionGetPayloadSchema;

export const SelectionClearResultDtoSchema = z
  .object({
    cleared: z.literal(true),
  })
  .strict();

export type SelectionClearResultDto = z.infer<typeof SelectionClearResultDtoSchema>;

export const PhotoGetDetailPayloadSchema = z
  .object({
    photoId: PositiveSafeIntegerSchema,
  })
  .strict();

export const ViewSessionCreatePayloadSchema = z
  .object({
    queryFingerprint: QueryFingerprintSchema,
    selectedPhotoId: PositiveSafeIntegerSchema,
  })
  .strict();

export const ViewNavigationDirectionSchema = z.enum(['previous', 'next']);
export type ViewNavigationDirectionDto = z.infer<typeof ViewNavigationDirectionSchema>;

export const ViewSessionNavigatePayloadSchema = z
  .object({
    viewSessionId: ViewSessionIdSchema,
    direction: ViewNavigationDirectionSchema,
  })
  .strict();

export const LibraryViewSessionResultDtoSchema = z
  .object({
    viewSessionId: ViewSessionIdSchema,
    position: NonNegativeSafeIntegerSchema,
    count: PositiveSafeIntegerSchema,
    detail: PhotoDetailDtoSchema,
  })
  .strict()
  .refine((value) => value.position < value.count, {
    message: 'View session position must be within the sequence',
  });

export type LibraryViewSessionResultDto = z.infer<typeof LibraryViewSessionResultDtoSchema>;

export type TagSuggestionsPayload = z.infer<typeof TagSuggestionsPayloadSchema>;
export type LibraryQueryPayload = z.infer<typeof LibraryQueryPayloadSchema>;
export type SelectionCreatePayload = z.infer<typeof SelectionCreatePayloadSchema>;
export type SelectionUpdatePayload = z.infer<typeof SelectionUpdatePayloadSchema>;
export type SelectionGetPayload = z.infer<typeof SelectionGetPayloadSchema>;
export type PhotoGetDetailPayload = z.infer<typeof PhotoGetDetailPayloadSchema>;
export type ViewSessionCreatePayload = z.infer<typeof ViewSessionCreatePayloadSchema>;
export type ViewSessionNavigatePayload = z.infer<typeof ViewSessionNavigatePayloadSchema>;
