import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoDetailDto } from '../../src/shared/contracts/catalog-api';
import type { CollectionPaths } from '../../src/main/bootstrap/collection';

const { handle, registerSchemesAsPrivileged } = vi.hoisted(() => ({
  handle: vi.fn(),
  registerSchemesAsPrivileged: vi.fn(),
}));

vi.mock('electron', () => ({
  protocol: { handle, registerSchemesAsPrivileged },
}));

import {
  createPhotoProtocolHandler,
  derivePhotoResourcePath,
  parsePhotoResourceUrl,
  registerPhotoProtocol,
  registerPhotoScheme,
} from '../../src/main/protocols/photo-protocol';

const paths: CollectionPaths = {
  storage: 'D:\\Portable\\Collection\\Storage',
  thumbnails: 'D:\\Portable\\Collection\\Thumbnails',
  trashPhotos: 'D:\\Portable\\Collection\\Trash\\Photos',
  trashThumbnails: 'D:\\Portable\\Collection\\Trash\\Thumbnails',
} as unknown as CollectionPaths;

function detail(overrides: Partial<PhotoDetailDto> = {}): PhotoDetailDto {
  return {
    photoId: 427,
    canonicalFilename: '0000000427.jpg',
    originalFilename: 'photo.jpg',
    flagged: false,
    integrityState: 'clean',
    width: 1200,
    height: 800,
    contentRevision: 3,
    thumbnailRevision: 4,
    thumbnailUrl: 'pt-photo://thumb/427?thumb=4',
    lifecycleState: 'active',
    fullImageUrl: 'pt-photo://full/427?content=3',
    explicitTags: [],
    desiredMetadataRevision: 0,
    syncedMetadataRevision: 0,
    metadataState: 'synchronized',
    importedAt: '2026-09-18T12:00:00.000Z',
    ...overrides,
  };
}

describe('pt-photo protocol', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers the secure standard scheme and explicit handler', () => {
    const client = { getPhotoDetail: vi.fn() };
    registerPhotoScheme();
    registerPhotoProtocol(paths, client);
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({
        scheme: 'pt-photo',
        privileges: expect.objectContaining({ standard: true, secure: true }),
      }),
    ]);
    expect(handle).toHaveBeenCalledWith('pt-photo', expect.any(Function));
  });

  it('accepts only exact ID/revision URL forms and rejects paths or encoded separators', () => {
    expect(parsePhotoResourceUrl('pt-photo://full/427?content=3')).toEqual({
      kind: 'full', photoId: 427, revision: 3,
    });
    expect(parsePhotoResourceUrl('pt-photo://thumb/427?thumb=4')).toEqual({
      kind: 'thumb', photoId: 427, revision: 4,
    });
    for (const url of [
      'pt-photo://full/0?content=3',
      'pt-photo://full/not-a-number?content=3',
      'pt-photo://full/427',
      'pt-photo://full/427?thumb=3',
      'pt-photo://full/427?content=3&path=D%3A%5Cprivate.jpg',
      'pt-photo://full/427%2F..%2Fsecret?content=3',
    ]) {
      expect(() => parsePhotoResourceUrl(url)).toThrow();
    }
  });

  it('derives active, trashed, and sharded paths internally with containment checks', () => {
    const full = derivePhotoResourcePath(
      paths,
      { kind: 'full', photoId: 427, revision: 3 },
      detail()
    );
    expect(full).toBe(path.resolve(paths.storage, '0000000427.jpg'));
    const thumbnail = derivePhotoResourcePath(
      paths,
      { kind: 'thumb', photoId: 427, revision: 4 },
      detail({ lifecycleState: 'trashed' })
    );
    expect(thumbnail).toBe(path.resolve(paths.trashThumbnails, 'ab', '0000000427.jpg'));
    expect(() => derivePhotoResourcePath(
      paths,
      { kind: 'full', photoId: 427, revision: 3 },
      detail({ canonicalFilename: '..\\private.jpg' })
    )).toThrow(/canonical|approved directory/i);
    expect(() => derivePhotoResourcePath(
      paths,
      { kind: 'full', photoId: 427, revision: 2 },
      detail()
    )).toThrow(/stale/i);
  });

  it('serves validated JPEG bytes with approved headers', async () => {
    const client = { getPhotoDetail: vi.fn(async () => detail()) };
    const readFile = vi.fn(async () => Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]));
    const response = await createPhotoProtocolHandler(paths, client, readFile)(
      new Request('pt-photo://full/427?content=3')
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(client.getPhotoDetail).toHaveBeenCalledWith(427);
    expect(readFile).toHaveBeenCalledWith(path.resolve(paths.storage, '0000000427.jpg'));
  });

  it('rejects malformed requests and returns a generic JPEG for ineligible resources', async () => {
    const client = { getPhotoDetail: vi.fn(async () => detail({
      integrityState: 'missing',
      fullImageUrl: undefined,
    })) };
    const readFile = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const handler = createPhotoProtocolHandler(paths, client, readFile);

    const malformed = await handler(new Request('pt-photo://full/427?path=private.jpg'));
    expect(malformed.status).toBe(400);
    expect(client.getPhotoDetail).not.toHaveBeenCalled();
    expect((await handler(new Request('pt-photo://full/427?content=3', {
      headers: { Range: 'bytes=0-10' },
    }))).status).toBe(400);

    const unavailable = await handler(new Request('pt-photo://full/427?content=3'));
    expect(unavailable.status).toBe(404);
    expect(unavailable.headers.get('content-type')).toBe('image/jpeg');
    expect(readFile).not.toHaveBeenCalled();
    expect(new Uint8Array(await unavailable.arrayBuffer()).slice(0, 2)).toEqual(
      new Uint8Array([0xff, 0xd8])
    );
  });
});
