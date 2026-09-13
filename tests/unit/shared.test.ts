import { describe, it, expect } from 'vitest';
import { makePhotoId, makeTagId } from '../../src/shared/ids/brand';
import { createSuccessResult, createErrorResult } from '../../src/shared/errors/app-error';

describe('Shared ID branding', () => {
  it('creates valid PhotoId and TagId', () => {
    const pid = makePhotoId(427);
    const tid = makeTagId(10);
    expect(pid).toBe(427);
    expect(tid).toBe(10);
  });

  it('rejects invalid IDs', () => {
    expect(() => makePhotoId(-1)).toThrow();
    expect(() => makeTagId(0)).toThrow();
    expect(() => makePhotoId(NaN)).toThrow();
  });
});

describe('IPC Result helpers', () => {
  it('creates success and error results correctly', () => {
    const success = createSuccessResult({ status: 'ok' }, 1);
    expect(success.ok).toBe(true);
    if (success.ok) {
      expect(success.data.status).toBe('ok');
      expect(success.catalogRevision).toBe(1);
    }

    const error = createErrorResult({
      code: 'TEST_ERROR',
      category: 'validation',
      message: 'Test message',
      dataSafe: true,
      retryable: false,
      correlationId: 'corr-1',
    });
    expect(error.ok).toBe(false);
    if (!error.ok) {
      expect(error.error.code).toBe('TEST_ERROR');
    }
  });
});
