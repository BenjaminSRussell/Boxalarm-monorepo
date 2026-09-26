import { Component, lazy, Suspense, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { SignInPage } from './pages/SignInPage';
import { RequireAuth } from './routing/RequireAuth';
import { RequireRole } from './routing/RequireRole';
import { GlobalTokensStyle } from './styles/GlobalTokensStyle';

const AuthCallbackPage = lazy(() =>
  import('./pages/AuthCallbackPage').then((mod) => ({ default: mod.AuthCallbackPage })),
);
const LandingPage = lazy(() =>
  import('./pages/LandingPage').then((mod) => ({ default: mod.LandingPage })),
);
const ReportingPage = lazy(() =>
  import('./features/reporting/ReportingPage').then((mod) => ({ default: mod.ReportingPage })),
);
const ApparatusListPage = lazy(() =>
  import('./features/apparatus/ApparatusListPage').then((mod) => ({
    default: mod.ApparatusListPage,
  })),
);
const ApparatusDetailPage = lazy(() =>
  import('./features/apparatus/ApparatusDetailPage').then((mod) => ({
    default: mod.ApparatusDetailPage,
  })),
);
const CompliancePage = lazy(() =>
  import('./features/apparatus/CompliancePage').then((mod) => ({ default: mod.CompliancePage })),
);
const AlertsRosterPage = lazy(() =>
  import('./features/alerts/AlertsRosterPage').then((mod) => ({ default: mod.AlertsRosterPage })),
);
const AlertsDiagnosticsPage = lazy(() =>
  import('./features/alerts/AlertsDiagnosticsPage').then((mod) => ({
    default: mod.AlertsDiagnosticsPage,
  })),
);
const PersonnelListPage = lazy(() =>
  import('./features/personnel/PersonnelListPage').then((mod) => ({
    default: mod.PersonnelListPage,
  })),
);
const MemberDetailPage = lazy(() =>
  import('./features/personnel/MemberDetailPage').then((mod) => ({
    default: mod.MemberDetailPage,
  })),
);
const SettingsPage = lazy(() =>
  import('./features/platform/SettingsPage').then((mod) => ({ default: mod.SettingsPage })),
);
const AuditLogPage = lazy(() =>
  import('./features/platform/AuditLogPage').then((mod) => ({ default: mod.AuditLogPage })),
);
const CertificationsPage = lazy(() =>
  import('./features/training/CertificationsPage').then((mod) => ({
    default: mod.CertificationsPage,
  })),
);
const TrainingEventsPage = lazy(() =>
  import('./features/training/TrainingEventsPage').then((mod) => ({
    default: mod.TrainingEventsPage,
  })),
);
const EquipmentPage = lazy(() =>
  import('./features/inventory/EquipmentPage').then((mod) => ({ default: mod.EquipmentPage })),
);
const EquipmentDetailPage = lazy(() =>
  import('./features/inventory/EquipmentDetailPage').then((mod) => ({
    default: mod.EquipmentDetailPage,
  })),
);
const OccupancyListPage = lazy(() =>
  import('./features/inspections/OccupancyListPage').then((mod) => ({
    default: mod.OccupancyListPage,
  })),
);
const OccupancyDetailPage = lazy(() =>
  import('./features/inspections/OccupancyDetailPage').then((mod) => ({
    default: mod.OccupancyDetailPage,
  })),
);
const HydrantsPage = lazy(() =>
  import('./features/inspections/HydrantsPage').then((mod) => ({ default: mod.HydrantsPage })),
);
const InspectionsPage = lazy(() =>
  import('./features/inspections/InspectionsPage').then((mod) => ({
    default: mod.InspectionsPage,
  })),
);
const MapPage = lazy(() =>
  import('./features/inspections/MapPage').then((mod) => ({ default: mod.MapPage })),
);
const SchedulePage = lazy(() =>
  import('./features/schedule/SchedulePage').then((mod) => ({ default: mod.SchedulePage })),
);
const LosapSettingsPage = lazy(() =>
  import('./features/losap/LosapSettingsPage').then((mod) => ({
    default: mod.LosapSettingsPage,
  })),
);
const IncidentsListPage = lazy(() =>
  import('./features/incidents/IncidentsListPage').then((mod) => ({
    default: mod.IncidentsListPage,
  })),
);
const IncidentDetailPage = lazy(() =>
  import('./features/incidents/IncidentDetailPage').then((mod) => ({
    default: mod.IncidentDetailPage,
  })),
);

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

class ConfigErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main role="alert">
          <h1>Boxalarm can&apos;t start</h1>
          <p>Sign-in configuration is missing or invalid. Contact your department administrator.</p>
        </main>
      );
    }
    return this.props.children;
  }
}

function LoginRoute() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  if (isAuthenticated) return <Navigate to="/" replace />;
  return <SignInPage />;
}

function roleGuarded(element: ReactNode) {
  return <RequireRole>{element}</RequireRole>;
}

export function App() {
  return (
    <ConfigErrorBoundary>
      <GlobalTokensStyle />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || undefined}>
            <Suspense fallback={null}>
              <Routes>
                <Route path="/login" element={<LoginRoute />} />
                <Route path="/auth/callback" element={<AuthCallbackPage />} />
                <Route
                  path="/"
                  element={
                    <RequireAuth>
                      <AppShell />
                    </RequireAuth>
                  }
                >
                  <Route index element={<LandingPage />} />
                  <Route path="alerts/roster" element={roleGuarded(<AlertsRosterPage />)} />
                  <Route
                    path="alerts/diagnostics"
                    element={roleGuarded(<AlertsDiagnosticsPage />)}
                  />
                  <Route path="incidents" element={roleGuarded(<IncidentsListPage />)} />
                  <Route path="incidents/:id" element={roleGuarded(<IncidentDetailPage />)} />
                  <Route path="personnel" element={roleGuarded(<PersonnelListPage />)} />
                  <Route path="personnel/:id" element={roleGuarded(<MemberDetailPage />)} />
                  <Route path="certifications" element={roleGuarded(<CertificationsPage />)} />
                  <Route path="training/events" element={roleGuarded(<TrainingEventsPage />)} />
                  <Route path="apparatus" element={roleGuarded(<ApparatusListPage />)} />
                  <Route path="apparatus/compliance" element={roleGuarded(<CompliancePage />)} />
                  <Route path="apparatus/:id" element={roleGuarded(<ApparatusDetailPage />)} />
                  <Route path="inventory" element={roleGuarded(<EquipmentPage />)} />
                  <Route path="inventory/:assetId" element={roleGuarded(<EquipmentDetailPage />)} />
                  <Route
                    path="inspections/occupancies"
                    element={roleGuarded(<OccupancyListPage />)}
                  />
                  <Route
                    path="inspections/occupancies/:id"
                    element={roleGuarded(<OccupancyDetailPage />)}
                  />
                  <Route path="inspections/hydrants" element={roleGuarded(<HydrantsPage />)} />
                  <Route path="inspections/map" element={roleGuarded(<MapPage />)} />
                  <Route path="inspections" element={roleGuarded(<InspectionsPage />)} />
                  <Route path="schedule" element={roleGuarded(<SchedulePage />)} />
                  <Route path="reporting" element={roleGuarded(<ReportingPage />)} />
                  <Route path="settings" element={roleGuarded(<SettingsPage />)} />
                  <Route path="settings/losap" element={roleGuarded(<LosapSettingsPage />)} />
                  <Route path="audit-log" element={roleGuarded(<AuditLogPage />)} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </ConfigErrorBoundary>
  );
}
