export type PhotoId = number & { readonly __brand: 'PhotoId' };
export type TagId = number & { readonly __brand: 'TagId' };

export function makePhotoId(id: number): PhotoId {
  if (!Number.isInteger(id) || id <= 0 || id > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid PhotoId: ${id}`);
  }
  return id as PhotoId;
}

export function makeTagId(id: number): TagId {
  if (!Number.isInteger(id) || id <= 0 || id > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid TagId: ${id}`);
  }
  return id as TagId;
}
