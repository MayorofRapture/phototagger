export type ErrorCategory =
  | 'validation'
  | 'conflict'
  | 'unavailable'
  | 'permission'
  | 'capacity'
  | 'integrity'
  | 'internal';

export interface AppErrorDto {
  code: string;
  category: ErrorCategory;
  message: string;
  affectedPhotoId?: number;
  affectedDisplayName?: string;
  dataSafe: boolean;
  retryable: boolean;
  suggestedAction?: string;
  correlationId: string;
}

export type IpcResult<T> =
  | { ok: true; data: T; catalogRevision?: number }
  | { ok: false; error: AppErrorDto };

export function createSuccessResult<T>(data: T, catalogRevision?: number): IpcResult<T> {
  return { ok: true, data, catalogRevision };
}

export function createErrorResult<T>(error: AppErrorDto): IpcResult<T> {
  return { ok: false, error };
}
