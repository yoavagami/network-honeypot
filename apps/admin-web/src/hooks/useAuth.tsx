import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type AdminRole } from "../api.js";

interface AuthState {
  username: string | null;
  role: AdminRole | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string | null>(null);
  const [role, setRole] = useState<AdminRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then((r) => (setUsername(r.username), setRole(r.role)))
      .catch(() => (setUsername(null), setRole(null)))
      .finally(() => setLoading(false));
  }, []);

  async function login(u: string, p: string) {
    const r = await api.login(u, p);
    setUsername(r.username);
    setRole(r.role);
  }

  async function logout() {
    await api.logout();
    setUsername(null);
    setRole(null);
  }

  return <AuthContext.Provider value={{ username, role, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
