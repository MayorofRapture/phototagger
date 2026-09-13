import React, { useEffect, useState } from 'react';
import { AppBootstrapDto } from '../../shared/contracts/ipc';

export const App: React.FC = () => {
  const [bootstrap, setBootstrap] = useState<AppBootstrapDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let isMounted = true;

    async function loadBootstrap() {
      try {
        if (!window.photoTagger || !window.photoTagger.app) {
          if (isMounted) {
            setError('Preload API (window.photoTagger) is unavailable.');
            setLoading(false);
          }
          return;
        }

        const result = await window.photoTagger.app.getBootstrap();
        if (isMounted) {
          if (result.ok) {
            setBootstrap(result.data);
          } else {
            setError(`IPC Error [${result.error.code}]: ${result.error.message}`);
          }
          setLoading(false);
        }
      } catch (err) {
        if (isMounted) {
          setError(`Exception during IPC round trip: ${String(err)}`);
          setLoading(false);
        }
      }
    }

    loadBootstrap();

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <div className="app-container">
      <header>
        <h1>PhotoTagger — Milestone 0 Foundation</h1>
      </header>

      <div className="status-card">
        <h2>IPC Round Trip Status</h2>
        {loading && <p>Connecting to main process...</p>}
        {error && (
          <div>
            <span className="status-badge error">FAILED</span>
            <p>{error}</p>
          </div>
        )}
        {bootstrap && (
          <div>
            <span className="status-badge ok">CONNECTED (IPC OK)</span>
            <p>
              <strong>App Version:</strong> {bootstrap.appVersion}
            </p>
            <p>
              <strong>Electron Version:</strong> {bootstrap.electronVersion}
            </p>
            <p>
              <strong>Node Version:</strong> {bootstrap.nodeVersion}
            </p>
            <p>
              <strong>Collection Path:</strong> {bootstrap.collectionDisplayPath}
            </p>
            <p>
              <strong>Write State:</strong> {bootstrap.writeState}
            </p>
          </div>
        )}
      </div>

      {bootstrap && (
        <div className="status-card">
          <h2>Bootstrap DTO Payload</h2>
          <pre>{JSON.stringify(bootstrap, null, 2)}</pre>
        </div>
      )}
    </div>
  );
};
