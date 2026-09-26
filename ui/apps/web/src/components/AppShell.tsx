import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { NotificationBell } from '../features/notifications/NotificationBell';
import { ToastProvider } from './ui/Toast';
import { DemoBanner } from './DemoBanner';
import { LiveRegionProvider } from './LiveRegion';
import { NavDrawer } from './NavDrawer';
import { PrimaryNav } from './PrimaryNav';
import { RouteErrorBoundary } from './RouteErrorBoundary';
import { SkipToContentLink } from './SkipToContentLink';
import { TopBar } from './TopBar';
import styles from './AppShell.module.css';

export function AppShell() {
  const location = useLocation();
  // MAJOR-1 (PR #318 review): owns NavDrawer's open state so TopBar's hamburger button (visible
  // only below `md`) can open it and a route change can close it, matching the "close on
  // navigate" behaviour NavListContent already wires for a link click or Sign out.
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  return (
    <LiveRegionProvider>
      <ToastProvider>
        <SkipToContentLink />
        {import.meta.env.VITE_DEMO === 'true' && <DemoBanner />}
        <div className={styles.shell}>
          <PrimaryNav />
          <NavDrawer open={navOpen} onOpenChange={setNavOpen} />
          <TopBar onOpenNav={() => setNavOpen(true)} notifications={<NotificationBell />} />
          <div className={styles.main}>
            {/* Keyed by path so navigating to a different route also recovers a tripped
                boundary, not just its own "Try again" button. Each page owns its own <main
                id="main-content"> landmark, so this wrapper stays a plain <div>. */}
            <RouteErrorBoundary key={location.pathname}>
              <Outlet />
            </RouteErrorBoundary>
          </div>
        </div>
      </ToastProvider>
    </LiveRegionProvider>
  );
}
