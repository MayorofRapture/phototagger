import { z } from 'zod';
import {
  LibraryQueryPayloadSchema,
  PhotoGetDetailPayloadSchema,
  SelectionClearPayloadSchema,
  SelectionCreatePayloadSchema,
  SelectionGetPayloadSchema,
  SelectionUpdatePayloadSchema,
  SettingsReadPayloadSchema,
  TagSuggestionsPayloadSchema,
  ViewSessionCreatePayloadSchema,
  ViewSessionNavigatePayloadSchema,
} from './catalog-api';
import {
  CreateImportBatchPayloadSchema,
  CreateJournalIntentPayloadSchema,
  ImportBatchIdPayloadSchema,
  ImportJobIdPayloadSchema,
  TransitionImportJobPayloadSchema,
  TransitionJournalPayloadSchema,
} from './import-catalog';

export const CatalogRequestType = {
  PING: 'ping',
  OPEN_CATALOG: 'openCatalog',
  OPEN_TEST_CATALOG: 'openTestCatalog',
  CLOSE_CATALOG: 'closeCatalog',
  READ_GENERAL_SETTINGS: 'settings.readGeneral',
  FIND_TAG_SUGGESTIONS: 'tags.findSuggestions',
  QUERY_LIBRARY: 'library.query',
  CREATE_SELECTION: 'selection.create',
  UPDATE_SELECTION: 'selection.update',
  GET_SELECTION: 'selection.get',
  CLEAR_SELECTION: 'selection.clear',
  GET_PHOTO_DETAIL: 'photo.getDetail',
  CREATE_VIEW_SESSION: 'library.createViewSession',
  NAVIGATE_VIEW_SESSION: 'library.navigateView',
  CREATE_IMPORT_BATCH: 'imports.createBatch',
  GET_IMPORT_BATCH: 'imports.getBatch',
  GET_IMPORT_JOB: 'imports.getJob',
  LIST_IMPORT_JOBS: 'imports.listJobs',
  TRANSITION_IMPORT_JOB: 'imports.transitionJob',
  REQUEST_IMPORT_STOP: 'imports.requestStop',
  RESERVE_IMPORT_PHOTO_ID: 'imports.reservePhotoId',
  COMMIT_IMPORT_PHOTO_ID: 'imports.commitPhotoId',
  ABANDON_IMPORT_PHOTO_ID: 'imports.abandonPhotoId',
  CREATE_OPERATION_JOURNAL_INTENT: 'journal.createIntent',
  TRANSITION_OPERATION_JOURNAL: 'journal.transition',
} as const;

export type CatalogRequestType = (typeof CatalogRequestType)[keyof typeof CatalogRequestType];

const RequestIdSchema = z.string().min(1).max(128);

export const PingPayloadSchema = z.object({}).strict();

export const OpenTestCatalogPayloadSchema = z.object({
  databasePath: z.string().min(1).max(32767),
}).strict();

export const OpenCatalogPayloadSchema = z.object({
  databasePath: z.string().min(1).max(32767),
  appVersion: z.string().min(1).max(128),
}).strict();

export const CloseCatalogPayloadSchema = z.object({}).strict();

export const CatalogRequestSchema = z.discriminatedUnion('type', [
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.PING),
    payload: PingPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.OPEN_CATALOG),
    payload: OpenCatalogPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.OPEN_TEST_CATALOG),
    payload: OpenTestCatalogPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.CLOSE_CATALOG),
    payload: CloseCatalogPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.READ_GENERAL_SETTINGS),
    payload: SettingsReadPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.FIND_TAG_SUGGESTIONS),
    payload: TagSuggestionsPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.QUERY_LIBRARY),
    payload: LibraryQueryPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.CREATE_SELECTION),
    payload: SelectionCreatePayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.UPDATE_SELECTION),
    payload: SelectionUpdatePayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.GET_SELECTION),
    payload: SelectionGetPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.CLEAR_SELECTION),
    payload: SelectionClearPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.GET_PHOTO_DETAIL),
    payload: PhotoGetDetailPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.CREATE_VIEW_SESSION),
    payload: ViewSessionCreatePayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.NAVIGATE_VIEW_SESSION),
    payload: ViewSessionNavigatePayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.CREATE_IMPORT_BATCH),
    payload: CreateImportBatchPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.GET_IMPORT_BATCH),
    payload: ImportBatchIdPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.GET_IMPORT_JOB),
    payload: ImportJobIdPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.LIST_IMPORT_JOBS),
    payload: ImportBatchIdPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.TRANSITION_IMPORT_JOB),
    payload: TransitionImportJobPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.REQUEST_IMPORT_STOP),
    payload: ImportBatchIdPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.RESERVE_IMPORT_PHOTO_ID),
    payload: ImportJobIdPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.COMMIT_IMPORT_PHOTO_ID),
    payload: ImportJobIdPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.ABANDON_IMPORT_PHOTO_ID),
    payload: ImportJobIdPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.CREATE_OPERATION_JOURNAL_INTENT),
    payload: CreateJournalIntentPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.TRANSITION_OPERATION_JOURNAL),
    payload: TransitionJournalPayloadSchema,
  }).strict(),
]);

export type CatalogRequest = z.infer<typeof CatalogRequestSchema>;

export interface CatalogErrorDto {
  code: string;
  message: string;
}

export const CatalogErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
}).strict();

export type RendererSafeValue =
  | string
  | number
  | boolean
  | null
  | RendererSafeValue[]
  | { [key: string]: RendererSafeValue };

function isRendererSafeValue(value: unknown, seen = new Set<object>()): value is RendererSafeValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== 'object' || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every((item) => isRendererSafeValue(item, seen));
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
    return false;
  }
  return Object.values(value).every((item) => isRendererSafeValue(item, seen));
}

export const RendererSafeValueSchema = z.custom<RendererSafeValue>(
  (value) => isRendererSafeValue(value),
  'Catalog response contains a non-serializable value'
);

export const CatalogResponseSchema = z.discriminatedUnion('success', [
  z.object({
    requestId: RequestIdSchema,
    success: z.literal(true),
    result: RendererSafeValueSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    success: z.literal(false),
    error: CatalogErrorSchema,
  }).strict(),
]);

export type CatalogResponse<T = unknown> = {
  requestId: string;
} & (
  | { success: true; result: T }
  | { success: false; error: CatalogErrorDto }
);

export interface PingResult {
  pong: true;
  timestamp: string;
}

export const PingResultSchema = z.object({
  pong: z.literal(true),
  timestamp: z.string(),
}).strict();

export interface OpenTestCatalogResult {
  opened: true;
  databasePath: string;
  userVersion: number;
  temporaryTableNames: string[];
}

export const OpenTestCatalogResultSchema = z.object({
  opened: z.literal(true),
  databasePath: z.string(),
  userVersion: z.number().int(),
  temporaryTableNames: z.array(z.string()),
}).strict();

export interface OpenCatalogResult {
  opened: true;
  created: boolean;
  userVersion: number;
  temporaryTableNames: string[];
}

export const OpenCatalogResultSchema = z.object({
  opened: z.literal(true),
  created: z.boolean(),
  userVersion: z.number().int(),
  temporaryTableNames: z.array(z.string()),
}).strict();

export interface CloseCatalogResult {
  closed: true;
}

export const CloseCatalogResultSchema = z.object({
  closed: z.literal(true),
}).strict();
