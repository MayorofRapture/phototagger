import type {
  LibraryViewSessionResultDto,
  ViewNavigationDirectionDto,
} from '../../../shared/contracts/catalog-api';
import type { IpcResult } from '../../../shared/errors/app-error';
import type { ImageRendererApi } from './image-api';

export type ViewerDestination = 'library' | 'image';

export interface ImageViewState {
  destination: ViewerDestination;
  session: LibraryViewSessionResultDto | null;
  isEntering: boolean;
  isNavigating: boolean;
  imageLoadFailed: boolean;
  error: string | null;
}

const initialState: ImageViewState = {
  destination: 'library',
  session: null,
  isEntering: false,
  isNavigating: false,
  imageLoadFailed: false,
  error: null,
};

function resultError<T>(result: IpcResult<T>, fallback: string): string {
  return result.ok ? fallback : result.error.message;
}

export class ImageViewController {
  private state: ImageViewState = initialState;
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  constructor(private readonly api: ImageRendererApi) {}

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getSnapshot = (): ImageViewState => this.state;

  public canOpenImage(
    selectionCount: number,
    knownSelectedPhotoId: number | null
  ): boolean {
    if (selectionCount === 0) {
      return this.state.session !== null;
    }
    return selectionCount === 1 && knownSelectedPhotoId !== null;
  }

  public async openImage(
    queryFingerprint: string | null,
    selectionCount: number,
    knownSelectedPhotoId: number | null
  ): Promise<void> {
    if (!this.canOpenImage(selectionCount, knownSelectedPhotoId) || this.state.isEntering) {
      return;
    }
    const generation = ++this.generation;
    this.setState({ ...this.state, isEntering: true, error: null });

    try {
      if (selectionCount === 0) {
        const active = this.state.session;
        if (!active) {
          return;
        }
        const detailResult = await this.api.getPhotoDetail(active.detail.photoId);
        if (generation !== this.generation) {
          return;
        }
        if (!detailResult.ok) {
          this.setState({
            ...initialState,
            error: resultError(detailResult, 'The active Image View session is no longer available.'),
          });
          return;
        }
        this.setState({
          ...this.state,
          destination: 'image',
          session: { ...active, detail: detailResult.data },
          isEntering: false,
          imageLoadFailed: false,
          error: null,
        });
        return;
      }

      if (queryFingerprint === null || knownSelectedPhotoId === null) {
        this.setState({ ...this.state, isEntering: false });
        return;
      }
      const result = await this.api.createViewSession(
        queryFingerprint,
        knownSelectedPhotoId
      );
      if (generation !== this.generation) {
        return;
      }
      if (!result.ok) {
        this.setState({
          ...this.state,
          destination: 'library',
          isEntering: false,
          error: resultError(result, 'Image View could not be opened.'),
        });
        return;
      }
      this.setState({
        destination: 'image',
        session: result.data,
        isEntering: false,
        isNavigating: false,
        imageLoadFailed: false,
        error: null,
      });
    } catch {
      if (generation === this.generation) {
        this.setState({
          ...this.state,
          destination: 'library',
          isEntering: false,
          error: 'Image View could not be opened.',
        });
      }
    }
  }

  public async showLibrary(refreshLibrary: () => Promise<void>): Promise<void> {
    ++this.generation;
    this.setState({
      ...this.state,
      destination: 'library',
      session: this.state.isNavigating ? null : this.state.session,
      isEntering: false,
      isNavigating: false,
      imageLoadFailed: false,
      error: null,
    });
    await refreshLibrary();
  }

  public async navigate(direction: ViewNavigationDirectionDto): Promise<void> {
    const session = this.state.session;
    if (!session || this.state.destination !== 'image' || this.state.isNavigating) {
      return;
    }
    const atBoundary = direction === 'previous'
      ? session.position === 0
      : session.position === session.count - 1;
    if (atBoundary || session.count <= 1) {
      return;
    }

    const generation = ++this.generation;
    const sessionId = session.viewSessionId;
    this.setState({ ...this.state, isNavigating: true, error: null });
    try {
      const result = await this.api.navigateView(sessionId, direction);
      if (
        generation !== this.generation ||
        this.state.destination !== 'image' ||
        this.state.session?.viewSessionId !== sessionId
      ) {
        return;
      }
      if (!result.ok) {
        this.setState({
          ...this.state,
          isNavigating: false,
          error: resultError(result, 'Image navigation could not be completed.'),
        });
        return;
      }
      this.setState({
        ...this.state,
        session: result.data,
        isNavigating: false,
        imageLoadFailed: false,
        error: null,
      });
    } catch {
      if (generation === this.generation) {
        this.setState({
          ...this.state,
          isNavigating: false,
          error: 'Image navigation could not be completed.',
        });
      }
    }
  }

  public markImageLoadFailed(): void {
    if (!this.state.imageLoadFailed) {
      this.setState({ ...this.state, imageLoadFailed: true });
    }
  }

  public dispose(): void {
    ++this.generation;
    this.listeners.clear();
  }

  private setState(state: ImageViewState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
