import { Navigate, Route, Routes } from 'react-router-dom';

import { SessionProvider } from './state/session';
import { useAuth } from './auth/AuthContext';
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
 *   /editor                    → redirect to Projects
 *   /editor/:songId            → redirect to Timeline tab
 *   /editor/:songId/sound      → Editor · Sound Design tab
 *   /editor/:songId/timeline   → Editor · Timeline tab
 *   /editor/:songId/structure  → Editor · Structure tab
 *
 * Signed-out users see only the landing (LoginPage). Signed-in users get
 * the full route tree wrapped in <SessionProvider>.
 */
export function App() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <BootSplash />;
  if (!user) return <LoginPage />; // public landing for everyone signed out

  return (
    <SessionProvider>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/catalog" element={<CatalogPage />} />
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
    </SessionProvider>
  );
}

function BootSplash() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#e2e2e2] text-sm text-black/50">
      Loading…
    </div>
  );
}
