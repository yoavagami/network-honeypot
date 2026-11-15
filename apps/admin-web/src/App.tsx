import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth.js";
import { Layout } from "./components/Layout.js";
import { LoginPage } from "./pages/LoginPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { LiveStreamPage } from "./pages/LiveStreamPage.js";
import { RequestsPage } from "./pages/RequestsPage.js";
import { AgentsPage } from "./pages/AgentsPage.js";
import { AgentVisitPage } from "./pages/AgentVisitPage.js";
import { AgentSignalsPage } from "./pages/AgentSignalsPage.js";
import { IpsBreakdownPage } from "./pages/IpsBreakdownPage.js";
import { UserAgentsBreakdownPage } from "./pages/UserAgentsBreakdownPage.js";
import { ActorsPage } from "./pages/ActorsPage.js";
import { ActorProfilePage } from "./pages/ActorProfilePage.js";
import { DetectionsPage } from "./pages/DetectionsPage.js";
import { AlertsPage } from "./pages/AlertsPage.js";
import { CanariesPage } from "./pages/CanariesPage.js";
import { VulnerabilitiesPage } from "./pages/VulnerabilitiesPage.js";
import { GeographyPage } from "./pages/GeographyPage.js";
import { FirstContactPage } from "./pages/FirstContactPage.js";
import { SearchPage } from "./pages/SearchPage.js";
import { EventDetailPage } from "./pages/EventDetailPage.js";
import { AccessLogPage } from "./pages/AccessLogPage.js";
import { MerchantsPage, MerchantTrafficPage, MerchantTrafficVisitPage, MerchantTrafficOrderPage } from "./pages/MerchantsAdmin.js";
import {
  MerchantAuthProvider, RequireMerchant, MerchantLayout, MerchantLoginPage, MerchantInvitePage, MerchantOverviewPage, MerchantLivePage,
  MerchantVisitsPage, MerchantVisitPage, MerchantOrdersPage, MerchantOrderPage, MerchantIntegrationPage, MerchantSettingsPage,
} from "./pages/MerchantPortal.js";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { username, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="muted" style={{ padding: "2rem" }}>Loading…</p>;
  // Remember where the admin was going, so login can send them back there.
  if (!username) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

/** Regular admins who type the URL get sent to Overview, as if the page didn't exist. */
function RequireSuperadmin({ children }: { children: React.ReactNode }) {
  const { role } = useAuth();
  if (role !== "superadmin") return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Merchant portal (/m/*): its own sign-in against merchant-api, never the SOC admin session. */
function MerchantRoutes() {
  return (
    <MerchantAuthProvider>
      <Routes>
        <Route path="login" element={<MerchantLoginPage />} />
        <Route path="invite/:token" element={<MerchantInvitePage />} />
        <Route element={<RequireMerchant><MerchantLayout /></RequireMerchant>}>
          <Route index element={<MerchantOverviewPage />} />
          <Route path="live" element={<MerchantLivePage />} />
          <Route path="visits" element={<MerchantVisitsPage />} />
          <Route path="visits/:id" element={<MerchantVisitPage />} />
          <Route path="orders" element={<MerchantOrdersPage />} />
          <Route path="orders/:id" element={<MerchantOrderPage />} />
          <Route path="integration" element={<MerchantIntegrationPage />} />
          <Route path="settings" element={<MerchantSettingsPage />} />
        </Route>
      </Routes>
    </MerchantAuthProvider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/m/*" element={<MerchantRoutes />} />
      <Route path="*" element={<AdminApp />} />
    </Routes>
  );
}

function AdminApp() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<OverviewPage />} />
          <Route path="live" element={<LiveStreamPage />} />
          <Route path="requests" element={<RequestsPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="agents/signals" element={<AgentSignalsPage />} />
          <Route path="agents/:id" element={<AgentVisitPage />} />
          <Route path="overview/ips" element={<IpsBreakdownPage />} />
          <Route path="overview/user-agents" element={<UserAgentsBreakdownPage />} />
          <Route path="actors" element={<ActorsPage />} />
          <Route path="actors/:id" element={<ActorProfilePage />} />
          <Route path="detections" element={<DetectionsPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="canaries" element={<CanariesPage />} />
          <Route path="vulnerabilities" element={<VulnerabilitiesPage />} />
          <Route path="geography" element={<GeographyPage />} />
          <Route path="first-contact" element={<FirstContactPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="events/:id" element={<EventDetailPage />} />
          <Route path="merchants" element={<MerchantsPage />} />
          <Route path="merchant-traffic" element={<MerchantTrafficPage />} />
          <Route path="merchant-traffic/visits/:id" element={<MerchantTrafficVisitPage />} />
          <Route path="merchant-traffic/orders/:id" element={<MerchantTrafficOrderPage />} />
          <Route
            path="access-log"
            element={
              <RequireSuperadmin>
                <AccessLogPage />
              </RequireSuperadmin>
            }
          />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
