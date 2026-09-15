import { z } from 'zod';

export const CatalogRequestType = {
  PING: 'ping',
  OPEN_TEST_CATALOG: 'openTestCatalog',
  CLOSE_CATALOG: 'closeCatalog',
} as const;

export type CatalogRequestType = (typeof CatalogRequestType)[keyof typeof CatalogRequestType];

const RequestIdSchema = z.string().min(1).max(128);

export const PingPayloadSchema = z.object({}).strict();

export const OpenTestCatalogPayloadSchema = z.object({
  databasePath: z.string().min(1),
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
    type: z.literal(CatalogRequestType.OPEN_TEST_CATALOG),
    payload: OpenTestCatalogPayloadSchema,
  }).strict(),
  z.object({
    requestId: RequestIdSchema,
    type: z.literal(CatalogRequestType.CLOSE_CATALOG),
    payload: CloseCatalogPayloadSchema,
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

export const CatalogResponseSchema = z.discriminatedUnion('success', [
  z.object({
    requestId: RequestIdSchema,
    success: z.literal(true),
    result: z.unknown(),
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

export interface CloseCatalogResult {
  closed: true;
}

export const CloseCatalogResultSchema = z.object({
  closed: z.literal(true),
}).strict();
