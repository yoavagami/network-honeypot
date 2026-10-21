import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.js";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/live", label: "Live Stream" },
  { to: "/requests", label: "Requests" },
  { to: "/actors", label: "Actors" },
  { to: "/detections", label: "Detections" },
  { to: "/alerts", label: "Alerts" },
  { to: "/canaries", label: "Canaries" },
  { to: "/vulnerabilities", label: "Vulnerabilities" },
  { to: "/geography", label: "Geography" },
  { to: "/first-contact", label: "First Contact" },
  { to: "/search", label: "Search" },
];

// Only rendered for superadmins. Hiding the link is convenience; the real gate is the API's 404.
const SUPERADMIN_NAV = [{ to: "/access-log", label: "Access Log", end: false }];

export function Layout() {
  const { username, role, logout } = useAuth();
  const nav = role === "superadmin" ? [...NAV, ...SUPERADMIN_NAV] : NAV;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Honeypot SOC</div>
        <nav>
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? "active" : "")}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="footer">
          <div style={{ marginBottom: ".5rem" }}>{username}</div>
          <button onClick={() => void logout()}>Sign out</button>
        </div>
      </aside>
      <div className="main">
        <Outlet />
      </div>
    </div>
  );
}
