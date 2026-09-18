import React from 'react';
import { LibraryView } from './library/LibraryView';

export const App: React.FC = () => (
  <div className="app-shell">
    <header className="primary-navigation">
      <span className="app-brand">PhotoTagger</span>
      <span className="current-destination" aria-current="page">Library View</span>
    </header>
    <main className="content-region">
      <LibraryView />
    </main>
    <footer className="status-bar" aria-label="Application status">
      <span>Library View</span>
      <span className="status-bar-note">Read-only Library</span>
    </footer>
  </div>
);
