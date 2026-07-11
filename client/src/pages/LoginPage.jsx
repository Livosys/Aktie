import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.jsx';

const fieldStyle = {
  width: '100%',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '10px 12px',
  background: 'var(--surface)',
  color: 'var(--text)',
  fontSize: 14,
  outline: 'none',
};

export default function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = useMemo(() => {
    const value = location.state?.from;
    return value && value !== '/login' ? value : '/supervisor';
  }, [location.state]);
  const [form, setForm] = useState({ username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!auth.loading && auth.authenticated) {
      navigate(from, { replace: true });
    }
  }, [auth.loading, auth.authenticated, from, navigate]);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await auth.login(form);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err?.status === 429
        ? 'För många inloggningsförsök. Vänta en stund och försök igen.'
        : 'Felaktigt användarnamn eller lösenord.');
    } finally {
      setBusy(false);
      setForm((current) => ({ ...current, password: '' }));
    }
  }

  return (
    <main style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      padding: 20,
      background: 'var(--bg)',
      color: 'var(--text)',
    }}>
      <form
        onSubmit={submit}
        style={{
          width: 'min(420px, 100%)',
          display: 'grid',
          gap: 16,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--surface)',
          padding: 24,
          boxShadow: '0 20px 70px rgba(15,23,42,0.22)',
        }}
      >
        <div>
          <div style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0 }}>
            Trading OS
          </div>
          <h1 style={{ margin: '6px 0 0', fontSize: 24, letterSpacing: 0 }}>Logga in till Trading OS</h1>
        </div>

        {auth.message ? (
          <div style={{ border: '1px solid rgba(245,158,11,0.28)', borderRadius: 8, padding: 10, color: 'var(--warning)', background: 'rgba(245,158,11,0.08)', fontSize: 13 }}>
            {auth.message}
          </div>
        ) : null}

        {error ? (
          <div style={{ border: '1px solid rgba(239,68,68,0.28)', borderRadius: 8, padding: 10, color: 'var(--danger)', background: 'rgba(239,68,68,0.08)', fontSize: 13 }}>
            {error}
          </div>
        ) : null}

        <label style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 800 }}>
          Användarnamn
          <input
            value={form.username}
            onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
            type="text"
            autoComplete="username"
            style={fieldStyle}
            disabled={busy}
            autoFocus
          />
        </label>

        <label style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 800 }}>
          Lösenord
          <input
            value={form.password}
            onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
            type="password"
            autoComplete="current-password"
            style={fieldStyle}
            disabled={busy}
          />
        </label>

        <button
          type="submit"
          disabled={busy || !form.username.trim() || !form.password}
          style={{
            border: '1px solid var(--accent)',
            borderRadius: 8,
            background: 'var(--accent)',
            color: '#fff',
            padding: '10px 14px',
            fontSize: 14,
            fontWeight: 900,
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy || !form.username.trim() || !form.password ? 0.65 : 1,
          }}
        >
          {busy ? 'Loggar in…' : 'Logga in'}
        </button>
      </form>
    </main>
  );
}
