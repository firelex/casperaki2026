import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import {
  AppShell,
  AppShellMain,
  Sidebar,
  SidebarFooter,
  SidebarHeader,
  SidebarNav,
  SidebarNavItem,
  StatusDot,
} from '@teamsuzie/ui';
import { ModelsPage } from './components/ModelsPage.tsx';
import { StudioPage } from './components/StudioPage.tsx';

function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="size-6 rounded-md bg-primary" aria-hidden="true" />
      <span className="text-sm font-semibold tracking-tight">Casperaki</span>
    </div>
  );
}

const NAV = [
  { to: '/studio', label: 'Studio' },
  { to: '/models', label: 'Models' },
];

function Placeholder({ title }: { title: string }) {
  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">Coming soon.</p>
    </div>
  );
}

export default function App() {
  const [healthLoaded, setHealthLoaded] = useState(false);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.ok && r.json())
      .then((d) => setOnline(Boolean(d?.ok)))
      .catch(() => setOnline(false))
      .finally(() => setHealthLoaded(true));
  }, []);

  const state: 'online' | 'offline' | 'pending' = !healthLoaded ? 'pending' : online ? 'online' : 'offline';

  return (
    <AppShell>
      <Sidebar>
        <SidebarHeader>
          <Wordmark />
        </SidebarHeader>
        <SidebarNav>
          {NAV.map((item) => (
            <SidebarNavItem key={item.to} asChild>
              <NavLink to={item.to}>{item.label}</NavLink>
            </SidebarNavItem>
          ))}
        </SidebarNav>
        <SidebarFooter>
          <div className="mt-2">
            <StatusDot name="API" state={state} />
          </div>
        </SidebarFooter>
      </Sidebar>
      <AppShellMain>
        <Routes>
          <Route path="/" element={<Navigate to="/studio" replace />} />
          <Route path="/studio" element={<StudioPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="*" element={<Placeholder title="Not found" />} />
        </Routes>
      </AppShellMain>
    </AppShell>
  );
}
