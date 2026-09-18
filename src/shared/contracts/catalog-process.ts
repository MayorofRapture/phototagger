import { z } from 'zod';
import {
  LibraryQueryPayloadSchema,
  SelectionClearPayloadSchema,
  SelectionCreatePayloadSchema,
  SelectionGetPayloadSchema,
  SelectionUpdatePayloadSchema,
  SettingsReadPayloadSchema,
  TagSuggestionsPayloadSchema,
} from './catalog-api';

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
