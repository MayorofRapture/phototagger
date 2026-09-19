import { protocol } from 'electron';
import fs from 'fs';
import path from 'path';
import type { CollectionPaths } from '../bootstrap/collection';
import type { PhotoDetailDto } from '../../shared/contracts/catalog-api';

const JPEG_HEADERS = {
  'Content-Type': 'image/jpeg',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

// A generic one-pixel JPEG is used only for an unavailable protocol resource.
const UNAVAILABLE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64'
);

export type PhotoResourceKind = 'full' | 'thumb';

export interface ParsedPhotoResource {
  kind: PhotoResourceKind;
  photoId: number;
  revision: number;
}

export interface PhotoProtocolCatalogClient {
  getPhotoDetail(photoId: number): Promise<PhotoDetailDto>;
}

class ReadLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

export function registerPhotoScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'pt-photo',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

export function parsePhotoResourceUrl(rawUrl: string): ParsedPhotoResource {
  const url = new URL(rawUrl);
  if (
    url.protocol !== 'pt-photo:' ||
    (url.hostname !== 'full' && url.hostname !== 'thumb') ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Invalid photo resource URL');
  }
  const pathMatch = /^\/([1-9][0-9]*)$/.exec(url.pathname);
  if (!pathMatch) {
    throw new Error('Invalid photo resource ID');
  }
  const kind = url.hostname as PhotoResourceKind;
  const expectedKey = kind === 'full' ? 'content' : 'thumb';
  const parameters = [...url.searchParams.entries()];
  if (parameters.length !== 1 || parameters[0][0] !== expectedKey) {
    throw new Error('Invalid photo resource revision');
  }
  const revisionText = parameters[0][1];
  if (!/^[1-9][0-9]*$/.test(revisionText)) {
    throw new Error('Invalid photo resource revision');
  }
  const photoId = Number(pathMatch[1]);
  const revision = Number(revisionText);
  if (!Number.isSafeInteger(photoId) || !Number.isSafeInteger(revision)) {
    throw new Error('Photo resource values exceed the supported range');
  }
  return { kind, photoId, revision };
}

export function derivePhotoResourcePath(
  paths: CollectionPaths,
  resource: ParsedPhotoResource,
  detail: PhotoDetailDto
): string {
  if (detail.photoId !== resource.photoId || detail.integrityState !== 'clean') {
    throw new Error('Photo resource is not eligible');
  }
  const expectedCanonicalFilename = `${String(resource.photoId).padStart(10, '0')}.jpg`;
  if (detail.canonicalFilename !== expectedCanonicalFilename) {
    throw new Error('Photo resource canonical filename is invalid');
  }
  const expectedRevision = resource.kind === 'full'
    ? detail.contentRevision
    : detail.thumbnailRevision;
  if (resource.revision !== expectedRevision) {
    throw new Error('Photo resource revision is stale');
  }

  const root = resource.kind === 'full'
    ? (detail.lifecycleState === 'active' ? paths.storage : paths.trashPhotos)
    : (detail.lifecycleState === 'active' ? paths.thumbnails : paths.trashThumbnails);
  const directory = resource.kind === 'thumb'
    ? path.join(root, (detail.photoId & 255).toString(16).padStart(2, '0'))
    : root;
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(directory, detail.canonicalFilename);
  const relative = path.relative(resolvedRoot, candidate);
  if (
    path.basename(candidate) !== detail.canonicalFilename ||
    relative === '' ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Photo resource path is outside its approved directory');
  }
  return candidate;
}

function invalidResponse(): Response {
  return new Response('Invalid photo resource request', {
    status: 400,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function unavailableResponse(): Response {
  return new Response(UNAVAILABLE_JPEG, {
    status: 404,
    headers: JPEG_HEADERS,
  });
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9;
}

export function createPhotoProtocolHandler(
  paths: CollectionPaths,
  catalogClient: PhotoProtocolCatalogClient,
  readFile: (filePath: string) => Promise<Buffer> = fs.promises.readFile
): (request: Request) => Promise<Response> {
  const fullReads = new ReadLimiter(2);
  const thumbnailReads = new ReadLimiter(8);
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' || request.headers.has('range')) {
      return invalidResponse();
    }
    let resource: ParsedPhotoResource;
    try {
      resource = parsePhotoResourceUrl(request.url);
    } catch {
      return invalidResponse();
    }
    const limiter = resource.kind === 'full' ? fullReads : thumbnailReads;
    return limiter.run(async () => {
      try {
        const detail = await catalogClient.getPhotoDetail(resource.photoId);
        const filePath = derivePhotoResourcePath(paths, resource, detail);
        const bytes = await readFile(filePath);
        if (!isJpeg(bytes)) {
          return unavailableResponse();
        }
        return new Response(bytes, { status: 200, headers: JPEG_HEADERS });
      } catch {
        return unavailableResponse();
      }
    });
  };
}

export function registerPhotoProtocol(
  paths: CollectionPaths,
  catalogClient: PhotoProtocolCatalogClient
): void {
  protocol.handle('pt-photo', createPhotoProtocolHandler(paths, catalogClient));
}
