import { Buffer } from 'buffer';

const FORBIDDEN_SEGMENT_CHARACTERS = /[\u0000-\u001F\u007F/|;]/u;
const UNICODE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

export interface NormalizedTagSegment {
  displayName: string;
  normalizedKey: string;
}

export interface NormalizedTagPath {
  segments: NormalizedTagSegment[];
}

export function normalizeTagSegment(segment: string): NormalizedTagSegment {
  if (typeof segment !== 'string') {
    throw new Error('Tag segment must be a string');
  }

  const displayName = segment.replace(UNICODE_WHITE_SPACE, '').normalize('NFC');
  if (displayName.length === 0) {
    throw new Error('Tag segments cannot be empty');
  }
  if (FORBIDDEN_SEGMENT_CHARACTERS.test(displayName)) {
    throw new Error('Tag segments contain a forbidden character');
  }
  if (Buffer.byteLength(displayName, 'utf8') > 64) {
    throw new Error('Tag segments cannot exceed 64 UTF-8 bytes');
  }

  return {
    displayName,
    normalizedKey: displayName.toLocaleLowerCase('en-US').normalize('NFC'),
  };
}

export function normalizeTagPath(path: string): NormalizedTagPath {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('Tag path cannot be empty');
  }

  const rawSegments = path.split('/');
  if (rawSegments.length > 12) {
    throw new Error('Tag hierarchy cannot exceed 12 levels');
  }

  return {
    segments: rawSegments.map(normalizeTagSegment),
  };
}
