import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';

import { SessionProvider } from './state/session';
import { useAuth } from './auth/AuthContext';
import { LandingPage } from './pages/landing/LandingPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SignInPage } from './pages/SignInPage';

// Code-split: the signed-out landing and the projects list load first; the
// editor, catalog and dev WASM pages are fetched when first opened.
const EditorPage = lazy(() => import('./pages/EditorPage').then((m) => ({ default: m.EditorPage })));
const SuggestionsPage = lazy(() => import('./pages/SuggestionsPage').then((m) => ({ default: m.SuggestionsPage })));
const SoundLibraryPage = lazy(() => import('./pages/SoundLibraryPage').then((m) => ({ default: m.SoundLibraryPage })));
const CatalogPage = lazy(() => import('./pages/CatalogPage').then((m) => ({ default: m.CatalogPage })));
const WasmTonePage = lazy(() => import('./pages/WasmTonePage').then((m) => ({ default: m.WasmTonePage })));
const WasmRenderPage = lazy(() => import('./pages/WasmRenderPage').then((m) => ({ default: m.WasmRenderPage })));
const HumLabPage = lazy(() => import('./pages/HumLabPage').then((m) => ({ default: m.HumLabPage })));

/**
 * Routes mirror rory-fe's three screens (LoginView, ProjectsView, Editor):
 *
 *   /                          → Projects   (home — listing + Create CTA)
 *   /sounds                    → Sound library (the Sounds tab's browser, no song)
 *   /catalog                   → Sample catalog (admins: source names, audit)
 *   /editor                    → redirect to Projects
 *   /editor/:songId            → redirect to Timeline tab
 *   /editor/:songId/sound      → Editor · Sound Design tab
 *   /editor/:songId/timeline   → Editor · Song tab (the tracks)
 *   /editor/:songId/video      → Editor · Music Video tab
 *   /editor/:songId/structure  → redirects to the track view (Structure was folded in)
 *   /lab/hum                   → Hum lab (beat tracking test bench for "hum a song")
 *
 * Signed-out users see only the landing (LandingPage). Signed-in users get
 * the full route tree wrapped in <SessionProvider>.
 */
export function App() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <BootSplash />;
  if (!user) return window.location.pathname === '/sign-in' ? <SignInPage /> : <LandingPage />; // public landing for everyone signed out

  return (
    <SessionProvider>
      <Suspense fallback={<PageSplash />}>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        {/* The sound library lists source names: admins only. */}
        <Route path="/sounds" element={<SoundLibraryPage />} />
        {user.isAdmin ? <Route path="/catalog" element={<CatalogPage />} /> : null}
        {/* Suggestions (admins): the pattern lab and the Pro-mode mix changes. */}
        {user.isAdmin ? <Route path="/suggestions" element={<SuggestionsPage />} /> : null}
        {user.isAdmin ? <Route path="/patterns" element={<Navigate to="/suggestions" replace />} /> : null}
        {/* dev-only WASM spikes stay reachable when signed in */}
        <Route path="/lab/hum" element={<HumLabPage />} />
        <Route path="/wasm-tone" element={<WasmTonePage />} />
        <Route path="/wasm-render" element={<WasmRenderPage />} />
        <Route path="/editor" element={<Navigate to="/" replace />} />
        <Route path="/editor/:songId" element={<Navigate to="timeline" replace />} />
        <Route path="/editor/:songId/sound" element={<EditorPage tab="sound" />} />
        <Route path="/editor/:songId/timeline" element={<EditorPage tab="timeline" />} />
        <Route path="/editor/:songId/video" element={<EditorPage tab="video" />} />
        {/* The Structure view was folded into the track view (sections are edited from the ruler). */}
        <Route path="/editor/:songId/structure" element={<StructureRedirect />} />
        <Route path="/sign-in" element={<Navigate to="/" replace />} />
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

/** Old Structure links open the track view, where sections are now edited. */
function StructureRedirect() {
  const { songId } = useParams<{ songId: string }>();
  return <Navigate to={`/editor/${songId}/timeline`} replace />;
}
