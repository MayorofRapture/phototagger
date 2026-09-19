import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { ImageView } from './image/ImageView';
import { createImageRendererApi } from './image/image-api';
import { ImageViewController } from './image/image-view-controller';
import { createLibraryRendererApi } from './library/library-api';
import {
  LibraryController,
  knownSoleSelectedPhotoId,
} from './library/library-controller';
import { LibraryView } from './library/LibraryView';

export const App: React.FC = () => {
  const libraryControllerRef = useRef<LibraryController | null>(null);
  const imageControllerRef = useRef<ImageViewController | null>(null);
  if (libraryControllerRef.current === null) {
    libraryControllerRef.current = new LibraryController(createLibraryRendererApi());
  }
  if (imageControllerRef.current === null) {
    imageControllerRef.current = new ImageViewController(createImageRendererApi());
  }
  const libraryController = libraryControllerRef.current;
  const imageController = imageControllerRef.current;
  const libraryState = useSyncExternalStore(
    libraryController.subscribe.bind(libraryController),
    libraryController.getSnapshot
  );
  const imageState = useSyncExternalStore(
    imageController.subscribe.bind(imageController),
    imageController.getSnapshot
  );

  useEffect(() => {
    void libraryController.initialize();
    return () => {
      imageController.dispose();
      libraryController.dispose();
    };
  }, [imageController, libraryController]);

  const selectedCount = libraryState.selection?.count ?? 0;
  const selectedPhotoId = knownSoleSelectedPhotoId(libraryState);
  const canOpenImage = imageController.canOpenImage(selectedCount, selectedPhotoId);
  const destinationLabel = imageState.destination === 'image' ? 'Image View' : 'Library View';

  return (
    <div className="app-shell">
      <header className="primary-navigation">
        <span className="app-brand">PhotoTagger</span>
        <nav className="viewer-switcher" aria-label="Photo Viewer">
          <button
            type="button"
            className={!canOpenImage ? 'viewer-switch disabled-viewer-switch' : 'viewer-switch'}
            aria-label="Image View"
            title="Image View"
            aria-current={imageState.destination === 'image' ? 'page' : undefined}
            disabled={imageState.destination === 'image' || !canOpenImage || imageState.isEntering}
            onClick={() => void imageController.openImage(
              libraryState.queryFingerprint,
              selectedCount,
              selectedPhotoId
            )}
          >
            <span aria-hidden="true">▣</span>
            <span>Image View</span>
          </button>
          <button
            type="button"
            className="viewer-switch"
            aria-label="Library View"
            title="Library View"
            aria-current={imageState.destination === 'library' ? 'page' : undefined}
            disabled={imageState.destination === 'library'}
            onClick={() => void imageController.showLibrary(
              () => libraryController.refreshCurrentQuery()
            )}
          >
            <span aria-hidden="true">▦</span>
            <span>Library View</span>
          </button>
        </nav>
        <span className="current-destination" aria-current="page">{destinationLabel}</span>
      </header>
      <main className="content-region">
        {imageState.destination === 'library' && imageState.error && (
          <div className="viewer-transition-error" role="alert">{imageState.error}</div>
        )}
        <LibraryView
          controller={libraryController}
          state={libraryState}
          hidden={imageState.destination !== 'library'}
        />
        {imageState.destination === 'image' && (
          <ImageView controller={imageController} state={imageState} />
        )}
      </main>
      <footer className="status-bar" aria-label="Application status">
        <span>{destinationLabel}</span>
        <span className="status-bar-note">Read-only catalog</span>
      </footer>
    </div>
  );
};
