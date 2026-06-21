import { Navigate, Route, Routes } from 'react-router-dom';

import { SessionProvider } from './state/session';
import { LoginPage } from './pages/LoginPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { EditorPage } from './pages/EditorPage';
import { CatalogPage } from './pages/CatalogPage';
import { WasmTonePage } from './pages/WasmTonePage';
import { WasmRenderPage } from './pages/WasmRenderPage';

/**
 * Routes mirror rory-fe's three screens (LoginView, ProjectsView, Editor):
 *
 *   /                          → Projects   (home — listing + Create CTA)
 *   /login                     → Login      (visual mock; no backend auth)
 *   /editor                    → redirect to Projects
 *   /editor/:songId            → redirect to Timeline tab
 *   /editor/:songId/sound      → Editor · Sound Design tab
 *   /editor/:songId/timeline   → Editor · Timeline tab
 *   /editor/:songId/structure  → Editor · Structure tab
 *
 * Session state (generated songs, active selection) wraps everything
 * via <SessionProvider>.
 */
export function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/catalog" element={<CatalogPage />} />
        {/* docs/60 Phase 0 — WASM render pipeline spike (dev-only) */}
        <Route path="/wasm-tone" element={<WasmTonePage />} />
        {/* docs/60 Phase 1 — in-browser streaming render, live playback (dev-only) */}
        <Route path="/wasm-render" element={<WasmRenderPage />} />
        <Route path="/editor" element={<Navigate to="/" replace />} />
        <Route path="/editor/:songId" element={<Navigate to="timeline" replace />} />
        <Route path="/editor/:songId/sound" element={<EditorPage tab="sound" />} />
        <Route path="/editor/:songId/timeline" element={<EditorPage tab="timeline" />} />
        <Route path="/editor/:songId/structure" element={<EditorPage tab="structure" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionProvider>
  );
}
