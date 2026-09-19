import type {
  LibraryViewSessionResultDto,
  PhotoDetailDto,
  ViewNavigationDirectionDto,
} from '../../../shared/contracts/catalog-api';
import type { IpcResult } from '../../../shared/errors/app-error';

export interface ImageRendererApi {
  getPhotoDetail(photoId: number): Promise<IpcResult<PhotoDetailDto>>;
  createViewSession(
    queryFingerprint: string,
    selectedPhotoId: number
  ): Promise<IpcResult<LibraryViewSessionResultDto>>;
  navigateView(
    viewSessionId: string,
    direction: ViewNavigationDirectionDto
  ): Promise<IpcResult<LibraryViewSessionResultDto>>;
}

export function createImageRendererApi(): ImageRendererApi {
  return {
    getPhotoDetail: (photoId) => window.photoTagger.photo.getDetail(photoId),
    createViewSession: (queryFingerprint, selectedPhotoId) =>
      window.photoTagger.library.createViewSession(queryFingerprint, selectedPhotoId),
    navigateView: (viewSessionId, direction) =>
      window.photoTagger.library.navigateView(viewSessionId, direction),
  };
}

