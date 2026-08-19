import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.js";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/live", label: "Live Stream" },
  { to: "/actors", label: "Actors" },
  { to: "/detections", label: "Detections" },
  { to: "/canaries", label: "Canaries" },
  { to: "/search", label: "Search" },
];

export function Layout() {
  const { username, logout } = useAuth();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Honeypot SOC</div>
        <nav>
          {NAV.map((item) => (
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
