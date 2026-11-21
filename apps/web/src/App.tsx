import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { SessionProvider } from './state/session';
import { useAuth } from './auth/AuthContext';
import { LandingPage } from './pages/landing/LandingPage';
import { ProjectsPage } from './pages/ProjectsPage';

// Code-split: the signed-out landing and the projects list load first; the
// editor, catalog and dev WASM pages are fetched when first opened.
const EditorPage = lazy(() => import('./pages/EditorPage').then((m) => ({ default: m.EditorPage })));
const CatalogPage = lazy(() => import('./pages/CatalogPage').then((m) => ({ default: m.CatalogPage })));
const WasmTonePage = lazy(() => import('./pages/WasmTonePage').then((m) => ({ default: m.WasmTonePage })));
const WasmRenderPage = lazy(() => import('./pages/WasmRenderPage').then((m) => ({ default: m.WasmRenderPage })));

/**
 * Routes mirror rory-fe's three screens (LoginView, ProjectsView, Editor):
 *
 *   /                          → Projects   (home — listing + Create CTA)
 *   /editor                    → redirect to Projects
 *   /editor/:songId            → redirect to Timeline tab
 *   /editor/:songId/sound      → Editor · Sound Design tab
 *   /editor/:songId/timeline   → Editor · Timeline tab
 *   /editor/:songId/structure  → Editor · Structure tab
 *
 * Signed-out users see only the landing (LandingPage). Signed-in users get
 * the full route tree wrapped in <SessionProvider>.
 */
export function App() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <BootSplash />;
  if (!user) return <LandingPage />; // public landing for everyone signed out

  return (
    <SessionProvider>
      <Suspense fallback={<PageSplash />}>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        {/* The sound library lists source names: admins only. */}
        {user.isAdmin ? <Route path="/catalog" element={<CatalogPage />} /> : null}
        {/* dev-only WASM spikes stay reachable when signed in */}
        <Route path="/wasm-tone" element={<WasmTonePage />} />
        <Route path="/wasm-render" element={<WasmRenderPage />} />
        <Route path="/editor" element={<Navigate to="/" replace />} />
        <Route path="/editor/:songId" element={<Navigate to="timeline" replace />} />
        <Route path="/editor/:songId/sound" element={<EditorPage tab="sound" />} />
        <Route path="/editor/:songId/timeline" element={<EditorPage tab="timeline" />} />
        <Route path="/editor/:songId/structure" element={<EditorPage tab="structure" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </SessionProvider>
  );
}

function BootSplash() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-bg text-sm text-muted">
      Loading…
    </div>
  );
}

function PageSplash() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-bg text-sm text-muted">
      Loading…
    </div>
  );
}
