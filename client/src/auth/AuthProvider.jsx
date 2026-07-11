import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { apiFetch, installAuthenticatedFetch } from '../lib/apiClient.js';

const AuthContext = createContext(null);

const initialState = {
  loading: true,
  authenticated: false,
  authEnabled: true,
  user: null,
  csrfToken: null,
  expiresAt: null,
  message: '',
};

function sessionFromPayload(payload) {
  return {
    loading: false,
    authenticated: payload?.authenticated === true,
    authEnabled: payload?.authEnabled !== false,
    user: payload?.user || null,
    csrfToken: payload?.csrfToken || null,
    expiresAt: payload?.expiresAt || null,
    message: '',
  };
}

export function AuthProvider({ children }) {
  const [state, setState] = useState(initialState);
  const csrfRef = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    csrfRef.current = state.csrfToken || null;
  }, [state.csrfToken]);

  const markUnauthorized = useCallback(() => {
    setState((current) => ({
      ...current,
      loading: false,
      authenticated: false,
      user: null,
      csrfToken: null,
      expiresAt: null,
      message: 'Din session har gått ut. Logga in igen.',
    }));
    if (window.location.pathname !== '/login') {
      navigate('/login', {
        replace: true,
        state: { from: `${window.location.pathname}${window.location.search}` },
      });
    }
  }, [navigate]);

  useEffect(() => {
    return installAuthenticatedFetch({
      getCsrfToken: () => csrfRef.current,
      onUnauthorized: markUnauthorized,
    });
  }, [markUnauthorized]);

  const refreshSession = useCallback(async () => {
    setState((current) => ({ ...current, loading: true }));
    try {
      const res = await fetch('/api/auth/session', { credentials: 'include' });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload) throw new Error(payload?.error || `HTTP ${res.status}`);
      setState(sessionFromPayload(payload));
      return payload;
    } catch (_) {
      setState({
        ...initialState,
        loading: false,
        message: 'Kunde inte kontrollera sessionen.',
      });
      return null;
    }
  }, []);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  const login = useCallback(async ({ username, password }) => {
    const payload = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    setState(sessionFromPayload(payload));
    return payload;
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (_) {
      // A stale session still gets cleared client-side.
    }
    setState({
      ...initialState,
      loading: false,
      message: '',
    });
    navigate('/login', { replace: true });
  }, [navigate]);

  const value = useMemo(() => ({
    ...state,
    login,
    logout,
    refreshSession,
    currentPath: `${location.pathname}${location.search}`,
  }), [state, login, logout, refreshSession, location.pathname, location.search]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function RequireAuth({ children }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.loading) {
    return (
      <div className="tos-loading" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        Laddar Trading OS…
      </div>
    );
  }
  if (!auth.authenticated) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return children;
}
