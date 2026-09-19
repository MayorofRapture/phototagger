import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ImageView } from '../../src/renderer/app/image/ImageView';
import type { ImageRendererApi } from '../../src/renderer/app/image/image-api';
import { ImageViewController } from '../../src/renderer/app/image/image-view-controller';
import type {
  LibraryViewSessionResultDto,
  PhotoDetailDto,
} from '../../src/shared/contracts/catalog-api';
import { createSuccessResult, type IpcResult } from '../../src/shared/errors/app-error';

const fingerprint = 'a'.repeat(64);
const sessionId = '00000000-0000-4000-8000-000000000080';

function photoDetail(overrides: Partial<PhotoDetailDto> = {}): PhotoDetailDto {
  return {
    photoId: 1,
    canonicalFilename: '0000000001.jpg',
    originalFilename: 'cat.jpg',
    flagged: false,
    integrityState: 'clean',
    width: 1200,
    height: 800,
    contentRevision: 2,
    thumbnailRevision: 3,
    thumbnailUrl: 'pt-photo://thumb/1?thumb=3',
    lifecycleState: 'active',
    fullImageUrl: 'pt-photo://full/1?content=2',
    explicitTags: [{
      tagId: 4,
      parentTagId: 3,
      displayName: 'Siamese',
      fullPath: 'Pets/Cats/Siamese',
      depth: 3,
      childCount: 0,
      pinned: false,
      legacyFlatOnly: false,
    }],
    desiredMetadataRevision: 1,
    syncedMetadataRevision: 1,
    metadataState: 'synchronized',
    importedAt: '2026-09-18T12:00:00.000Z',
    ...overrides,
  };
}

function session(
  overrides: Partial<LibraryViewSessionResultDto> = {}
): LibraryViewSessionResultDto {
  return {
    viewSessionId: sessionId,
    position: 0,
    count: 3,
    detail: photoDetail(),
    ...overrides,
  };
}

function failure<T>(message: string): IpcResult<T> {
  return {
    ok: false,
    error: {
      code: 'CATALOG_REQUEST_FAILED',
      category: 'unavailable',
      message,
      dataSafe: true,
      retryable: false,
      correlationId: 'test',
    },
  };
}

function api(overrides: Partial<ImageRendererApi> = {}): ImageRendererApi {
  return {
    getPhotoDetail: vi.fn(async () => createSuccessResult(photoDetail())),
    createViewSession: vi.fn(async () => createSuccessResult(session())),
    navigateView: vi.fn(async () => createSuccessResult(session({
      position: 1,
      detail: photoDetail({ photoId: 2, canonicalFilename: '0000000002.jpg' }),
    }))),
    ...overrides,
  };
}

describe('ImageViewController', () => {
  it('enables Image View only for one known selection or an active session', async () => {
    const controller = new ImageViewController(api());
    expect(controller.canOpenImage(0, null)).toBe(false);
    expect(controller.canOpenImage(1, null)).toBe(false);
    expect(controller.canOpenImage(1, 1)).toBe(true);
    expect(controller.canOpenImage(2, 1)).toBe(false);
    await controller.openImage(fingerprint, 1, 1);
    expect(controller.canOpenImage(0, null)).toBe(true);
  });

  it('creates a session with the current fingerprint and selected ID before switching views', async () => {
    const rendererApi = api();
    const controller = new ImageViewController(rendererApi);
    const opening = controller.openImage(fingerprint, 1, 1);
    expect(controller.getSnapshot().destination).toBe('library');
    await opening;

    expect(rendererApi.createViewSession).toHaveBeenCalledWith(fingerprint, 1);
    expect(controller.getSnapshot()).toMatchObject({
      destination: 'image',
      session: { viewSessionId: sessionId, position: 0, count: 3 },
    });
  });

  it('keeps Library active when session creation fails', async () => {
    const controller = new ImageViewController(api({
      createViewSession: vi.fn(async () =>
        failure<LibraryViewSessionResultDto>('Could not freeze the sequence.')
      ),
    }));
    await controller.openImage(fingerprint, 1, 1);
    expect(controller.getSnapshot()).toMatchObject({
      destination: 'library',
      session: null,
      error: 'Could not freeze the sequence.',
    });
  });

  it('navigates by opaque session ID, serializes requests, and ignores a stale response', async () => {
    let resolveNavigation: ((result: IpcResult<LibraryViewSessionResultDto>) => void) | undefined;
    const rendererApi = api({
      navigateView: vi.fn(() => new Promise<IpcResult<LibraryViewSessionResultDto>>((resolve) => {
        resolveNavigation = resolve;
      })),
    });
    const controller = new ImageViewController(rendererApi);
    await controller.openImage(fingerprint, 1, 1);

    const first = controller.navigate('next');
    void controller.navigate('next');
    expect(rendererApi.navigateView).toHaveBeenCalledOnce();
    expect(rendererApi.navigateView).toHaveBeenCalledWith(sessionId, 'next');
    const refresh = vi.fn(async () => undefined);
    await controller.showLibrary(refresh);
    resolveNavigation?.(createSuccessResult(session({ position: 1 })));
    await first;

    expect(controller.getSnapshot().destination).toBe('library');
    expect(controller.getSnapshot().session).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('returns to an active session without creating arbitrary membership', async () => {
    const rendererApi = api();
    const controller = new ImageViewController(rendererApi);
    await controller.openImage(fingerprint, 1, 1);
    await controller.showLibrary(async () => undefined);
    await controller.openImage(fingerprint, 0, null);

    expect(controller.getSnapshot().destination).toBe('image');
    expect(rendererApi.createViewSession).toHaveBeenCalledOnce();
    expect(rendererApi.getPhotoDetail).toHaveBeenCalledWith(1);
  });

  it('clears a stale active session when its controlled detail refresh fails', async () => {
    const rendererApi = api({
      getPhotoDetail: vi.fn(async () =>
        failure<PhotoDetailDto>('The catalog session was reset.')
      ),
    });
    const controller = new ImageViewController(rendererApi);
    await controller.openImage(fingerprint, 1, 1);
    await controller.showLibrary(async () => undefined);
    await controller.openImage(fingerprint, 0, null);

    expect(controller.getSnapshot()).toMatchObject({
      destination: 'library',
      session: null,
      error: 'The catalog session was reset.',
    });
  });
});

describe('ImageView rendering', () => {
  it('renders the approved URL, canonical identity, position, tags, and boundary controls', async () => {
    const controller = new ImageViewController(api());
    await controller.openImage(fingerprint, 1, 1);
    const markup = renderToStaticMarkup(React.createElement(ImageView, {
      controller,
      state: controller.getSnapshot(),
    }));

    expect(markup).toContain('src="pt-photo://full/1?content=2"');
    expect(markup).toContain('alt="0000000001.jpg"');
    expect(markup).toContain('0000000001.jpg');
    expect(markup).toContain('1 of 3');
    expect(markup).toContain('Pets/Cats/Siamese');
    expect(markup).toMatch(/aria-label="Previous photo"[^>]*disabled/);
    expect(markup).not.toMatch(/aria-label="Next photo"[^>]*disabled/);
    expect(markup).not.toContain('D:\\');
  });

  it('renders explanatory placeholders and disables both controls for one member', async () => {
    const rendererApi = api({
      createViewSession: vi.fn(async () => createSuccessResult(session({
        count: 1,
        detail: photoDetail({ integrityState: 'missing', fullImageUrl: undefined }),
      }))),
    });
    const controller = new ImageViewController(rendererApi);
    await controller.openImage(fingerprint, 1, 1);
    const markup = renderToStaticMarkup(React.createElement(ImageView, {
      controller,
      state: controller.getSnapshot(),
    }));

    expect(markup).toContain('missing from its expected location');
    expect((markup.match(/disabled=""/g) ?? [])).toHaveLength(2);
    expect(markup).not.toContain('<img');
  });
});
