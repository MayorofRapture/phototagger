import type { ReactElement } from 'react';
import type { PhotoDetailDto } from '../../../shared/contracts/catalog-api';
import { ImageViewController, type ImageViewState } from './image-view-controller';

function unavailableMessage(detail: PhotoDetailDto, imageLoadFailed: boolean): string {
  if (imageLoadFailed) {
    return 'This image could not be loaded.';
  }
  switch (detail.integrityState) {
    case 'missing':
      return 'The photo file is missing from its expected location.';
    case 'unreadable':
      return 'The photo file is unreadable.';
    case 'metadata_conflict':
    case 'content_conflict':
      return 'This photo is unavailable while an external-change conflict is unresolved.';
    case 'recovery_required':
      return 'This photo is unavailable until recovery is completed.';
    case 'clean':
      return 'This image is currently unavailable.';
  }
}

export function ImageView({
  controller,
  state,
}: {
  controller: ImageViewController;
  state: ImageViewState;
}): ReactElement {
  const session = state.session;
  if (!session) {
    return (
      <section className="image-view empty-image-view" aria-label="Image View">
        Select one Library photo to open Image View.
      </section>
    );
  }

  const { detail, position, count } = session;
  const previousDisabled = state.isNavigating || count <= 1 || position === 0;
  const nextDisabled = state.isNavigating || count <= 1 || position === count - 1;
  const showImage = detail.fullImageUrl !== undefined && !state.imageLoadFailed;

  return (
    <section className="image-view" aria-label="Image View">
      <div className="image-view-layout">
        <button
          type="button"
          className="viewer-navigation previous"
          aria-label="Previous photo"
          title="Previous photo"
          disabled={previousDisabled}
          onClick={() => void controller.navigate('previous')}
        >
          <span aria-hidden="true">‹</span>
        </button>

        <figure className="photo-viewer">
          <div className="full-image-stage">
            {showImage ? (
              <img
                key={`${detail.photoId}:${detail.contentRevision}`}
                className="full-image"
                src={detail.fullImageUrl}
                alt={detail.canonicalFilename}
                onError={() => controller.markImageLoadFailed()}
              />
            ) : (
              <div className="full-image-placeholder" role="img" aria-label="Photo unavailable">
                <span aria-hidden="true">▧</span>
                <p>{unavailableMessage(detail, state.imageLoadFailed)}</p>
              </div>
            )}
          </div>
          <figcaption className="image-identity">
            <strong>{detail.canonicalFilename}</strong>
            <span>{position + 1} of {count}</span>
          </figcaption>
        </figure>

        <button
          type="button"
          className="viewer-navigation next"
          aria-label="Next photo"
          title="Next photo"
          disabled={nextDisabled}
          onClick={() => void controller.navigate('next')}
        >
          <span aria-hidden="true">›</span>
        </button>

        <aside className="read-only-tag-panel" aria-label="Tagging Panel">
          <div>
            <h2>Tags</h2>
            <span className="read-only-label">Read-only</span>
          </div>
          {detail.explicitTags.length === 0 ? (
            <p className="no-explicit-tags">No explicit tags</p>
          ) : (
            <ul>
              {detail.explicitTags.map((tag) => (
                <li key={tag.tagId}>{tag.fullPath}</li>
              ))}
            </ul>
          )}
          <dl className="metadata-summary">
            <dt>Metadata</dt>
            <dd>{detail.metadataState.replaceAll('_', ' ')}</dd>
          </dl>
        </aside>
      </div>
      {state.error && <div className="image-view-error" role="alert">{state.error}</div>}
      <div className="image-view-announcement" aria-live="polite">
        {detail.canonicalFilename}, {position + 1} of {count}
      </div>
    </section>
  );
}

