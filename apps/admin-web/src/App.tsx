import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth.js";
import { Layout } from "./components/Layout.js";
import { LoginPage } from "./pages/LoginPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { LiveStreamPage } from "./pages/LiveStreamPage.js";
import { RequestsPage } from "./pages/RequestsPage.js";
import { ActorsPage } from "./pages/ActorsPage.js";
import { ActorProfilePage } from "./pages/ActorProfilePage.js";
import { DetectionsPage } from "./pages/DetectionsPage.js";
import { AlertsPage } from "./pages/AlertsPage.js";
import { CanariesPage } from "./pages/CanariesPage.js";
import { GeographyPage } from "./pages/GeographyPage.js";
import { FirstContactPage } from "./pages/FirstContactPage.js";
import { SearchPage } from "./pages/SearchPage.js";
import { EventDetailPage } from "./pages/EventDetailPage.js";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { username, loading } = useAuth();
  if (loading) return <p className="muted" style={{ padding: "2rem" }}>Loading…</p>;
  if (!username) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
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
          <Route path="actors" element={<ActorsPage />} />
          <Route path="actors/:id" element={<ActorProfilePage />} />
          <Route path="detections" element={<DetectionsPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="canaries" element={<CanariesPage />} />
          <Route path="geography" element={<GeographyPage />} />
          <Route path="first-contact" element={<FirstContactPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="events/:id" element={<EventDetailPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
