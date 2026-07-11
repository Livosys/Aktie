import React, { useEffect, useMemo, useState } from 'react';
import { DashboardShell } from '../components/dashboard/DashboardKit.jsx';
import {
  buildBasicAuthHeader,
  emptyOperatorCredentials,
  passwordInputType,
  passwordToggleLabel,
  sanitizeCredentialText,
} from '../lib/futuresPaperStrategyApproval.mjs';

const FETCH_TIMEOUT_MS = 8000;
const TABS = [
  ['overview', 'Översikt'],
  ['queue', 'Forskningskö'],
  ['strategies', 'Strategier'],
  ['versions', 'Versioner'],
  ['tests', 'Tester'],
  ['ai', 'AI-utvärdering'],
  ['tradingview', 'TradingView-validering'],
  ['tech', 'Teknik'],
];

const EMPTY = Object.freeze({
  overview: { summary: {}, safety: {}, dataQualityWarnings: [], parityWarnings: [] },
  config: { budget: {}, provider: {}, adapters: {}, store: {}, safety: {} },
  candidates: [],
  versions: [],
  testRuns: [],
  evaluations: [],
  validations: [],
  queue: [],
});

async function parseResponseBody(res) {
  if (!res) return null;
  const contentType = String(res.headers && res.headers.get ? res.headers.get('content-type') || '' : '');
  if (contentType.includes('application/json')) {
    return res.json().catch(() => null);
  }
  const text = await res.text().catch(() => '');
  const trimmed = String(text || '').trim();
  return trimmed ? { error: trimmed } : null;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: options.credentials || 'omit',
      signal: controller.signal,
    });
    const data = await parseResponseBody(res);
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function friendlyError(err) {
  if (err?.status === 401) return 'Operatörsautentisering krävs för den här ändringen.';
  if (err?.status === 403) return 'Du har inte behörighet att ändra Pine Research.';
  if (err?.status === 422) return err?.data?.error || 'Valideringen stoppade ändringen.';
  if (err?.status === 503) return 'AI-provider eller research-tjänst är tillfälligt otillgänglig.';
  if (String(err?.message || '').includes('timeout')) return 'Servern svarade inte i tid.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(String(err?.message || ''))) return 'Kunde inte nå servern.';
  return err?.message || 'Okänt fel.';
}

function formatNumber(value, fallback = '–') {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 }).format(n);
}

function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '–';
  return `${formatNumber(n)}%`;
}

function Badge({ children, tone = 'neutral' }) {
  const styles = {
    neutral: { background: 'rgba(148,163,184,0.14)', color: 'var(--text)' },
    success: { background: 'rgba(34,197,94,0.16)', color: '#22c55e' },
    warning: { background: 'rgba(245,158,11,0.16)', color: '#f59e0b' },
    danger: { background: 'rgba(239,68,68,0.14)', color: '#ef4444' },
    info: { background: 'rgba(56,189,248,0.14)', color: '#38bdf8' },
  };
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      minHeight: 24,
      border: '1px solid var(--border)',
      borderRadius: 999,
      padding: '3px 8px',
      fontSize: 12,
      fontWeight: 800,
      ...styles[tone],
    }}
    >
      {children}
    </span>
  );
}

function toneForStatus(status) {
  if (['ready_for_test', 'static_valid', 'completed', 'matched', 'candidate'].includes(status)) return 'success';
  if (['blocked', 'invalid', 'static_invalid', 'major_differences', 'provider_error', 'rejected'].includes(status)) return 'danger';
  if (['draft', 'generated', 'partial', 'needs_review', 'minor_differences'].includes(status)) return 'warning';
  return 'neutral';
}

function Section({ title, actions, children }) {
  return (
    <section style={{
      borderTop: '1px solid var(--border)',
      padding: '18px 0',
    }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        marginBottom: 12,
      }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, detail }) {
  return (
    <div style={{
      minWidth: 150,
      flex: '1 1 150px',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: 12,
      background: 'var(--panel)',
    }}
    >
      <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 800 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 24, fontWeight: 900 }}>{value}</div>
      {detail ? <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12 }}>{detail}</div> : null}
    </div>
  );
}

function EmptyState({ children }) {
  return (
    <div style={{
      border: '1px dashed var(--border)',
      borderRadius: 8,
      padding: 16,
      color: 'var(--muted)',
      background: 'rgba(148,163,184,0.06)',
    }}
    >
      {children}
    </div>
  );
}

function OperatorLoginDialog({
  open,
  pendingMutation,
  loginForm,
  setLoginForm,
  passwordVisible,
  onTogglePasswordVisible,
  onSubmit,
  onCancel,
  busy,
  error,
}) {
  if (!open) return null;
  const title = pendingMutation ? pendingMutation.label : 'Operatörsinloggning';
  const description = pendingMutation
    ? `Åtgärd: ${pendingMutation.label}. Uppgifterna sparas bara i minnet och rensas efter varje försök.`
    : 'Logga in för att kunna ändra strategier. Uppgifterna sparas bara i minnet och rensas efter varje försök.';
  const submitDisabled = busy || !loginForm.username || !loginForm.password;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Operatörsinloggning"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        background: 'rgba(15, 23, 42, 0.38)',
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitDisabled) onSubmit();
        }}
        style={{
          width: 'min(480px, 100%)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 16,
          background: 'var(--panel)',
          boxShadow: '0 18px 60px rgba(15, 23, 42, 0.24)',
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 6 }}>{title}</div>
        <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 10 }}>{description}</div>
        {error ? (
          <div style={{
            border: '1px solid rgba(239,68,68,0.35)',
            background: 'rgba(239,68,68,0.08)',
            borderRadius: 8,
            padding: 10,
            marginBottom: 12,
            color: 'var(--text)',
            fontSize: 13,
          }}
          >
            {error.message}
            {error.detail ? <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12 }}>Teknisk detalj: {error.detail}</div> : null}
          </div>
        ) : null}
        <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 800, marginBottom: 10 }}>
          Användarnamn
          <input
            type="text"
            value={loginForm.username}
            autoComplete="username"
            onChange={(event) => setLoginForm((current) => ({ ...current, username: event.target.value }))}
            placeholder="Användarnamn"
            style={{
              minHeight: 38,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface, #fff)',
              color: 'var(--text)',
              padding: '8px 10px',
            }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, fontWeight: 800, marginBottom: 10 }}>
          Lösenord
          <input
            type={passwordInputType(passwordVisible)}
            value={loginForm.password}
            autoComplete="current-password"
            onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))}
            placeholder="Lösenord"
            style={{
              minHeight: 38,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface, #fff)',
              color: 'var(--text)',
              padding: '8px 10px',
            }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onTogglePasswordVisible}
            aria-pressed={passwordVisible}
            style={{
              minHeight: 36,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'transparent',
              color: 'var(--text)',
              padding: '6px 10px',
              fontWeight: 800,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {passwordToggleLabel(passwordVisible)}
          </button>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onCancel}
              style={{
                minHeight: 36,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'transparent',
                color: 'var(--text)',
                padding: '6px 10px',
                fontWeight: 800,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Avbryt
            </button>
            <button
              type="submit"
              disabled={submitDisabled}
              style={{
                minHeight: 36,
                border: '1px solid var(--accent, #2563eb)',
                borderRadius: 8,
                background: submitDisabled ? 'var(--border)' : 'var(--accent, #2563eb)',
                color: submitDisabled ? 'var(--muted)' : '#fff',
                padding: '6px 12px',
                fontWeight: 900,
                cursor: submitDisabled ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {busy ? 'Skickar…' : 'Logga in och fortsätt'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function DataTable({ columns, rows, empty }) {
  if (!rows?.length) return <EmptyState>{empty}</EmptyState>;
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 780 }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={{
                textAlign: 'left',
                padding: '10px 12px',
                borderBottom: '1px solid var(--border)',
                color: 'var(--muted)',
                fontSize: 12,
                whiteSpace: 'nowrap',
              }}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={row.id || row.candidateId || row.pineVersionId || row.testRunId || row.evaluationId || row.validationId || idx}>
              {columns.map((column) => (
                <td key={column.key} style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' }}>
                  {column.render ? column.render(row) : row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JsonBlock({ value }) {
  return (
    <pre style={{
      margin: 0,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: 12,
      maxHeight: 360,
      overflow: 'auto',
      background: 'rgba(2,6,23,0.24)',
      fontSize: 12,
    }}
    >
      {JSON.stringify(value || {}, null, 2)}
    </pre>
  );
}

function InlineList({ items, empty }) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return <span style={{ color: 'var(--muted)' }}>{empty}</span>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {list.map((item, idx) => <li key={`${item}-${idx}`}>{item}</li>)}
    </ul>
  );
}

function recommendedChangesLabel(changes) {
  const list = Array.isArray(changes) ? changes.filter(Boolean) : [];
  if (!list.length) return <span style={{ color: 'var(--muted)' }}>Inga rekommenderade ändringar.</span>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {list.map((change, idx) => (
        <li key={`${change.field}-${idx}`}>
          {change.field}:{change.operation}
          {change.reason ? ` - ${change.reason}` : ''}
        </li>
      ))}
    </ul>
  );
}

function evaluationBasis(row) {
  if (row?.providerResultValid === false || row?.schemaValid === false) {
    return 'Providersvaret kunde inte valideras mot AIEvaluation-kontraktet.';
  }
  if (!Array.isArray(row?.testRunIds) || row.testRunIds.length === 0) {
    return 'Denna AI-utvärdering bygger endast på strategi-, parameter- och kodstruktur. Ingen intern prestandakörning finns ännu.';
  }
  return `${row.testRunIds.length} interna testkörningar ingår i underlaget.`;
}

function PineResearchPage() {
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionStatus, setActionStatus] = useState(null);
  const [operatorDialogOpen, setOperatorDialogOpen] = useState(false);
  const [operatorLoginForm, setOperatorLoginForm] = useState(emptyOperatorCredentials());
  const [operatorCredentials, setOperatorCredentials] = useState(emptyOperatorCredentials());
  const [operatorPasswordVisible, setOperatorPasswordVisible] = useState(false);
  const [operatorDialogError, setOperatorDialogError] = useState(null);
  const [pendingMutation, setPendingMutation] = useState(null);
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [selectedValidationId, setSelectedValidationId] = useState('');
  const [csvForm, setCsvForm] = useState({ symbol: 'MNQ', timeframe: '5m', tradesCsv: '', performanceCsv: '' });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [
        overview,
        config,
        candidatesPayload,
        versionsPayload,
        testRunsPayload,
        evaluationsPayload,
        validationsPayload,
        queuePayload,
      ] = await Promise.all([
        fetchJson('/api/pine-research/overview'),
        fetchJson('/api/pine-research/config'),
        fetchJson('/api/pine-research/candidates'),
        fetchJson('/api/pine-research/versions'),
        fetchJson('/api/pine-research/test-runs'),
        fetchJson('/api/pine-research/evaluations'),
        fetchJson('/api/pine-research/validations'),
        fetchJson('/api/pine-research/queue'),
      ]);
      const next = {
        overview,
        config,
        candidates: candidatesPayload.candidates || [],
        versions: versionsPayload.versions || [],
        testRuns: testRunsPayload.testRuns || [],
        evaluations: evaluationsPayload.evaluations || [],
        validations: validationsPayload.validations || [],
        queue: queuePayload.queue || [],
      };
      setData(next);
      setSelectedVersionId((current) => current || next.versions[0]?.pineVersionId || '');
      setSelectedValidationId((current) => current || next.validations[0]?.validationId || '');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const selectedVersion = useMemo(
    () => data.versions.find((version) => version.pineVersionId === selectedVersionId) || data.versions[0] || null,
    [data.versions, selectedVersionId],
  );
  const selectedValidation = useMemo(
    () => data.validations.find((validation) => validation.validationId === selectedValidationId) || data.validations[0] || null,
    [data.validations, selectedValidationId],
  );

  const hasOperatorCredentials = Boolean(operatorCredentials.username && operatorCredentials.password);

  function openLoginDialog(mutation = null) {
    setPendingMutation(mutation);
    setOperatorDialogError(null);
    setOperatorPasswordVisible(false);
    setOperatorLoginForm(emptyOperatorCredentials());
    setOperatorDialogOpen(true);
  }

  function clearOperatorState(options = {}) {
    const keepPendingMutation = options.keepPendingMutation === true;
    setOperatorCredentials(emptyOperatorCredentials());
    setOperatorLoginForm(emptyOperatorCredentials());
    setOperatorPasswordVisible(false);
    if (!keepPendingMutation) setPendingMutation(null);
  }

  async function executeMutation({ label, url, body = {}, credentials }) {
    const authHeader = buildBasicAuthHeader(credentials);
    if (!authHeader) {
      setOperatorDialogError({
        message: 'Du måste logga in som operatör för att ändra strategier.',
        detail: 'Ingen operatörsheader skickad. Mutation stoppad i dashboarden före POST.',
      });
      setOperatorDialogOpen(true);
      return null;
    }
    let succeeded = false;
    setActionStatus({ type: 'loading', message: `${label} pågår...` });
    try {
      const result = await fetchJson(url, {
        method: 'POST',
        body,
        headers: { Authorization: authHeader },
        credentials: 'omit',
      });
      setActionStatus({ type: 'success', message: `${label} klart. Status hämtas om från backend.` });
      setOperatorDialogError(null);
      await load();
      setOperatorDialogOpen(false);
      succeeded = true;
      return result;
    } catch (err) {
      setActionStatus({
        type: 'error',
        message: friendlyError(err),
        detail: sanitizeCredentialText(err?.data?.error || err?.data?.reason || err?.message || ''),
      });
      setOperatorDialogError({
        message: friendlyError(err),
        detail: sanitizeCredentialText(err?.data?.error || err?.data?.reason || err?.message || ''),
      });
      setOperatorDialogOpen(true);
      return null;
    } finally {
      clearOperatorState({ keepPendingMutation: !succeeded });
    }
  }

  async function mutate(label, url, body = {}) {
    const mutation = { label, url, body };
    if (!hasOperatorCredentials) {
      openLoginDialog(mutation);
      setActionStatus({
        type: 'error',
        message: 'Du måste logga in som operatör för att ändra strategier.',
        detail: 'Ingen operatörsheader skickad. Mutation stoppad i dashboarden före POST.',
      });
      return null;
    }
    return executeMutation({ ...mutation, credentials: operatorCredentials });
  }

  async function submitOperatorLogin() {
    const credentials = {
      username: String(operatorLoginForm.username || '').trim(),
      password: operatorLoginForm.password,
    };
    if (!credentials.username || !credentials.password) return null;
    setOperatorCredentials(credentials);
    if (pendingMutation) {
      setOperatorDialogError(null);
      return executeMutation({ ...pendingMutation, credentials });
    }
    setActionStatus({ type: 'success', message: 'Operatörsinloggning sparad i minnet. Nästa mutation kräver ingen ny inloggning förrän den är genomförd.' });
    setOperatorDialogOpen(false);
    setOperatorDialogError(null);
    setOperatorLoginForm(emptyOperatorCredentials());
    setOperatorPasswordVisible(false);
    return credentials;
  }

  const summary = data.overview.summary || {};
  const provider = data.config.provider || data.overview.provider || {};
  const safety = data.config.safety || data.overview.safety || {};

  return (
    <DashboardShell>
      <main style={{ padding: '24px clamp(14px, 3vw, 32px)', maxWidth: 1440, margin: '0 auto' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 'clamp(26px, 3vw, 38px)' }}>PineScript Research Factory</h1>
            <p style={{ margin: '8px 0 0', color: 'var(--muted)', maxWidth: 860 }}>
              Trading OS skapar research-kandidater, Pine v6-versioner, isolerade testplaner, AI-utvärderingar och TradingView-valideringar. Allt här är paper/replay-only.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Badge tone="success">paper/replay-only</Badge>
            <Badge tone={provider.configured ? 'success' : 'warning'}>{provider.provider || 'provider'} · {provider.model || 'model saknas'}</Badge>
            <Badge tone={hasOperatorCredentials ? 'success' : 'warning'}>{hasOperatorCredentials ? 'Operatör redo' : 'Operatörsinloggning krävs'}</Badge>
            <button type="button" onClick={() => openLoginDialog(null)} style={buttonStyle()}>
              Operatörsinloggning
            </button>
            <button type="button" onClick={load} style={buttonStyle()}>Hämta om</button>
          </div>
        </header>

        <nav style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 12, marginBottom: 12 }}>
          {TABS.map(([key, label]) => (
            <button key={key} type="button" onClick={() => setTab(key)} style={tabStyle(tab === key)}>
              {label}
            </button>
          ))}
        </nav>

        {loading ? <EmptyState>Laddar Pine Research Factory...</EmptyState> : null}
        {error ? <EmptyState>{error}</EmptyState> : null}
        {actionStatus ? (
          <div style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 14,
            background: actionStatus.type === 'error' ? 'rgba(239,68,68,0.12)' : 'rgba(56,189,248,0.10)',
          }}
          >
            <strong>{actionStatus.message}</strong>
            {actionStatus.detail ? <div style={{ marginTop: 4, color: 'var(--muted)', fontSize: 12 }}>Teknisk detalj: {actionStatus.detail}</div> : null}
          </div>
        ) : null}

        <OperatorLoginDialog
          open={operatorDialogOpen}
          pendingMutation={pendingMutation}
          loginForm={operatorLoginForm}
          setLoginForm={setOperatorLoginForm}
          passwordVisible={operatorPasswordVisible}
          onTogglePasswordVisible={() => setOperatorPasswordVisible((current) => !current)}
          onSubmit={submitOperatorLogin}
          onCancel={() => {
            setOperatorDialogOpen(false);
            setOperatorDialogError(null);
            setOperatorLoginForm(emptyOperatorCredentials());
            clearOperatorState();
          }}
          busy={actionStatus?.type === 'loading'}
          error={operatorDialogError}
        />

        {tab === 'overview' ? (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
              <Stat label="Strategier AI undersöker" value={formatNumber(summary.candidates || 0)} />
              <Stat label="Pine-versioner" value={formatNumber(summary.versions || 0)} />
              <Stat label="Testkörningar" value={formatNumber(summary.testRuns || 0)} detail={`${formatNumber(summary.runningTests || 0)} körs`} />
              <Stat label="AI-utvärderingar" value={formatNumber(summary.evaluations || 0)} />
              <Stat label="TradingView-valideringar" value={formatNumber(summary.validations || 0)} />
            </div>
            <Section
              title="Researchläge"
              actions={<button type="button" onClick={() => mutate('Skapa ORB-pilot', '/api/pine-research/candidates', { pilot: true })} style={buttonStyle('primary')}>Skapa ORB-pilot</button>}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
                <div>
                  <h3 style={smallHeadingStyle}>Bästa kandidat</h3>
                  {data.overview.bestCandidate ? <JsonBlock value={data.overview.bestCandidate} /> : <EmptyState>Ingen kandidat har score-satts ännu.</EmptyState>}
                </div>
                <div>
                  <h3 style={smallHeadingStyle}>Nästa rekommenderade experiment</h3>
                  {data.overview.nextRecommendedExperiment ? <JsonBlock value={data.overview.nextRecommendedExperiment} /> : <EmptyState>Ingen AI-rekommendation finns ännu.</EmptyState>}
                </div>
                <div>
                  <h3 style={smallHeadingStyle}>Varningar</h3>
                  {(data.overview.dataQualityWarnings || []).length ? (
                    <ul style={listStyle}>{data.overview.dataQualityWarnings.map((item) => <li key={item}>{item}</li>)}</ul>
                  ) : <EmptyState>Inga datakvalitetsvarningar har registrerats.</EmptyState>}
                </div>
              </div>
            </Section>
            <Section title="Safety">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Badge tone={safety.mode === 'paper_only' ? 'success' : 'danger'}>mode={safety.mode || 'paper_only'}</Badge>
                <Badge tone={safety.actions_allowed === false ? 'success' : 'danger'}>actions_allowed=false</Badge>
                <Badge tone={safety.can_place_orders === false ? 'success' : 'danger'}>can_place_orders=false</Badge>
                <Badge tone={safety.live_trading_enabled === false ? 'success' : 'danger'}>live_trading_enabled=false</Badge>
                <Badge tone={safety.broker_enabled === false ? 'success' : 'danger'}>broker_enabled=false</Badge>
              </div>
            </Section>
          </>
        ) : null}

        {tab === 'queue' ? (
          <>
            <Section
              title="Forskningskö"
              actions={(
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => mutate('Preview round', '/api/pine-research/loop/preview', { candidateId: data.candidates[0]?.candidateId })} style={buttonStyle()}>Preview</button>
                  <button type="button" onClick={() => mutate('Begränsad round', '/api/pine-research/loop/run-round', { ensurePilot: true, runAi: false })} style={buttonStyle('primary')}>Starta begränsad round</button>
                </div>
              )}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 420px)', gap: 12 }}>
                <DataTable
                  rows={data.queue}
                  empty="Forskningskön är tom."
                  columns={[
                    { key: 'candidateId', label: 'Kandidat' },
                    { key: 'status', label: 'Status', render: (row) => <Badge tone={toneForStatus(row.status)}>{row.status || 'queued'}</Badge> },
                    { key: 'blockedReason', label: 'Blockerad av' },
                  ]}
                />
                <div>
                  <h3 style={smallHeadingStyle}>Budget</h3>
                  <JsonBlock value={data.config.budget} />
                </div>
              </div>
            </Section>
          </>
        ) : null}

        {tab === 'strategies' ? (
          <Section title="Strategier">
            <DataTable
              rows={data.candidates}
              empty="Inga research-kandidater finns ännu."
              columns={[
                { key: 'baseStrategyId', label: 'Originalstrategi' },
                { key: 'strategyName', label: 'Namn' },
                { key: 'hypothesis', label: 'Hypotes' },
                { key: 'status', label: 'Status', render: (row) => <Badge tone={toneForStatus(row.status)}>{row.status}</Badge> },
                { key: 'versions', label: 'Versioner', render: (row) => data.versions.filter((version) => version.candidateId === row.candidateId).length },
                { key: 'next', label: 'Nästa steg', render: (row) => data.evaluations.find((evaluation) => evaluation.candidateId === row.candidateId)?.nextAction || 'Väntar data' },
              ]}
            />
          </Section>
        ) : null}

        {tab === 'versions' ? (
          <>
            <Section
              title="Versioner"
              actions={(
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <select value={selectedVersion?.pineVersionId || ''} onChange={(event) => setSelectedVersionId(event.target.value)} style={inputStyle}>
                    {data.versions.map((version) => <option key={version.pineVersionId} value={version.pineVersionId}>{version.pineVersionId}</option>)}
                  </select>
                  <button type="button" disabled={!selectedVersion} onClick={() => mutate('Generera Pine', '/api/pine-research/versions/generate', { pineVersionId: selectedVersion?.pineVersionId })} style={buttonStyle()}>Generera Pine</button>
                  <button type="button" disabled={!selectedVersion} onClick={() => mutate('Statisk validering', `/api/pine-research/versions/${selectedVersion?.pineVersionId}/validate`, {})} style={buttonStyle()}>Validera</button>
                  {selectedVersion ? <a href={`/api/pine-research/export/${selectedVersion.pineVersionId}`} target="_blank" rel="noreferrer" style={linkButtonStyle}>Exportera Pine</a> : null}
                </div>
              )}
            >
              {selectedVersion ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 0.9fr) minmax(320px, 1.1fr)', gap: 12 }}>
                  <div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                      <Badge tone={toneForStatus(selectedVersion.status)}>{selectedVersion.status}</Badge>
                      <Badge tone={toneForStatus(selectedVersion.compileStatus)}>{selectedVersion.compileStatus}</Badge>
                      <Badge>{selectedVersion.direction}</Badge>
                    </div>
                    <JsonBlock value={{
                      parentVersionId: selectedVersion.parentVersionId,
                      changeSummary: selectedVersion.changeSummary,
                      parameters: selectedVersion.parameters,
                      sourceHash: selectedVersion.sourceHash,
                      parameterHash: selectedVersion.parameterHash,
                      warnings: selectedVersion.validationWarnings,
                      compileErrors: selectedVersion.compileErrors,
                      reviewStatus: selectedVersion.reviewStatus,
                    }}
                    />
                  </div>
                  <pre style={{
                    margin: 0,
                    whiteSpace: 'pre',
                    overflow: 'auto',
                    minHeight: 420,
                    maxHeight: 620,
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 12,
                    background: 'rgba(2,6,23,0.28)',
                    fontSize: 12,
                  }}
                  >
                    {selectedVersion.sourceCode || 'Ingen Pine-kod har genererats för versionen ännu.'}
                  </pre>
                </div>
              ) : <EmptyState>Inga Pine-versioner har skapats ännu.</EmptyState>}
            </Section>
          </>
        ) : null}

        {tab === 'tests' ? (
          <Section
            title="Tester"
            actions={(
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" disabled={!selectedVersion} onClick={() => mutate('Skapa testpreview', '/api/pine-research/test-runs/preview', { pineVersionId: selectedVersion?.pineVersionId })} style={buttonStyle()}>Preview testplan</button>
                <button type="button" disabled={!selectedVersion} onClick={() => mutate('Kör isolerad testplan', '/api/pine-research/test-runs/run', { pineVersionId: selectedVersion?.pineVersionId })} style={buttonStyle('primary')}>Kör isolerat</button>
              </div>
            )}
          >
            <DataTable
              rows={data.testRuns}
              empty="Inga interna testkörningar finns ännu."
              columns={[
                { key: 'pineVersionId', label: 'Version' },
                { key: 'engine', label: 'Motor' },
                { key: 'symbol', label: 'Symbol' },
                { key: 'timeframe', label: 'Timeframe' },
                { key: 'direction', label: 'Riktning' },
                { key: 'status', label: 'Status', render: (row) => <Badge tone={toneForStatus(row.status)}>{row.status}</Badge> },
                { key: 'parityStatus', label: 'Paritet', render: (row) => <Badge tone={toneForStatus(row.parityStatus)}>{row.parityStatus}</Badge> },
                { key: 'tradeCount', label: 'Trades', render: (row) => formatNumber(row.tradeCount) },
                { key: 'winRate', label: 'Win rate', render: (row) => formatPercent(row.metrics?.winRate) },
                { key: 'profitFactor', label: 'PF', render: (row) => formatNumber(row.metrics?.profitFactor) },
                { key: 'drawdown', label: 'DD', render: (row) => formatNumber(row.metrics?.maxDrawdown) },
                { key: 'blockedReason', label: 'Blockerad av' },
              ]}
            />
          </Section>
        ) : null}

        {tab === 'ai' ? (
          <Section
            title="AI-utvärdering"
            actions={(
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" disabled={!selectedVersion} onClick={() => mutate('AI-utvärdering', '/api/pine-research/evaluations/run', { pineVersionId: selectedVersion?.pineVersionId })} style={buttonStyle('primary')}>Kör OpenAI-utvärdering</button>
                <button type="button" disabled={!selectedVersion} onClick={() => mutate('Deterministisk utvärdering', '/api/pine-research/evaluations/run', { pineVersionId: selectedVersion?.pineVersionId, providerMode: 'deterministic' })} style={buttonStyle()}>Lokal fallback</button>
              </div>
            )}
          >
            <DataTable
              rows={data.evaluations}
              empty="OpenAI-utvärdering har ännu inte körts."
              columns={[
                { key: 'pineVersionId', label: 'Version' },
                { key: 'verdict', label: 'Verdict', render: (row) => <Badge tone={toneForStatus(row.verdict)}>{row.verdict}</Badge> },
                { key: 'score', label: 'Score', render: (row) => formatNumber(row.score) },
                { key: 'nextAction', label: 'Nästa action', render: (row) => <Badge>{row.nextAction}</Badge> },
                { key: 'confidence', label: 'Confidence', render: (row) => formatPercent(Number(row.confidence) * 100) },
                { key: 'provider', label: 'Provider', render: (row) => `${row.modelProvider}/${row.modelName}` },
                { key: 'basis', label: 'Underlag', render: (row) => evaluationBasis(row) },
                { key: 'strengths', label: 'Styrkor', render: (row) => <InlineList items={row.strengths} empty="Inga dokumenterade styrkor." /> },
                { key: 'weaknesses', label: 'Svagheter', render: (row) => <InlineList items={row.weaknesses} empty="Inga dokumenterade svagheter." /> },
                { key: 'dataQualityWarnings', label: 'Datakvalitet', render: (row) => <InlineList items={row.dataQualityWarnings} empty="Inga datakvalitetsvarningar." /> },
                { key: 'overfitWarnings', label: 'Överanpassning', render: (row) => <InlineList items={row.overfitWarnings} empty="Inga överanpassningsvarningar." /> },
                { key: 'changes', label: 'Rekommenderade ändringar', render: (row) => recommendedChangesLabel(row.recommendedChanges) },
              ]}
            />
          </Section>
        ) : null}

        {tab === 'tradingview' ? (
          <Section
            title="TradingView-validering"
            actions={(
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  disabled={!selectedVersion}
                  onClick={() => mutate('Importera TradingView CSV', '/api/pine-research/tradingview/import', {
                    pineVersionId: selectedVersion?.pineVersionId,
                    symbol: csvForm.symbol,
                    timeframe: csvForm.timeframe,
                    tradesCsv: csvForm.tradesCsv,
                    performanceCsv: csvForm.performanceCsv,
                  })}
                  style={buttonStyle('primary')}
                >
                  Importera CSV
                </button>
                <button
                  type="button"
                  disabled={!selectedValidation}
                  onClick={() => mutate('Jämför TradingView mot intern körning', '/api/pine-research/tradingview/compare', { validationId: selectedValidation?.validationId })}
                  style={buttonStyle()}
                >
                  Jämför
                </button>
              </div>
            )}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 420px) minmax(0, 1fr)', gap: 12 }}>
              <div style={{ display: 'grid', gap: 8 }}>
                <select value={selectedVersion?.pineVersionId || ''} onChange={(event) => setSelectedVersionId(event.target.value)} style={inputStyle}>
                  {data.versions.map((version) => <option key={version.pineVersionId} value={version.pineVersionId}>{version.pineVersionId}</option>)}
                </select>
                <input value={csvForm.symbol} onChange={(event) => setCsvForm((prev) => ({ ...prev, symbol: event.target.value }))} placeholder="Symbol" style={inputStyle} />
                <input value={csvForm.timeframe} onChange={(event) => setCsvForm((prev) => ({ ...prev, timeframe: event.target.value }))} placeholder="Timeframe" style={inputStyle} />
                <textarea value={csvForm.tradesCsv} onChange={(event) => setCsvForm((prev) => ({ ...prev, tradesCsv: event.target.value }))} placeholder="TradingView trades CSV" style={textareaStyle} />
                <textarea value={csvForm.performanceCsv} onChange={(event) => setCsvForm((prev) => ({ ...prev, performanceCsv: event.target.value }))} placeholder="TradingView performance CSV" style={textareaStyle} />
              </div>
              <DataTable
                rows={data.validations}
                empty="Ingen TradingView-validering har importerats."
                columns={[
                  { key: 'pineVersionId', label: 'Version' },
                  { key: 'symbol', label: 'Symbol' },
                  { key: 'timeframe', label: 'Timeframe' },
                  { key: 'validationStatus', label: 'Status', render: (row) => <Badge tone={toneForStatus(row.validationStatus)}>{row.validationStatus}</Badge> },
                  { key: 'tradeCount', label: 'TV trades', render: (row) => formatNumber(row.tradingViewMetrics?.tradeCount) },
                  { key: 'netPnl', label: 'TV net', render: (row) => formatNumber(row.tradingViewMetrics?.netPnl) },
                  { key: 'warnings', label: 'Varningar', render: (row) => (row.warnings || []).join(', ') || '–' },
                ]}
              />
            </div>
          </Section>
        ) : null}

        {tab === 'tech' ? (
          <Section title="Teknik">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
              <div>
                <h3 style={smallHeadingStyle}>Provider</h3>
                <JsonBlock value={provider} />
              </div>
              <div>
                <h3 style={smallHeadingStyle}>Store</h3>
                <JsonBlock value={data.config.store || data.overview.store} />
              </div>
              <div>
                <h3 style={smallHeadingStyle}>Adapters</h3>
                <JsonBlock value={data.config.adapters} />
              </div>
              <div>
                <h3 style={smallHeadingStyle}>Safety flags</h3>
                <JsonBlock value={safety} />
              </div>
            </div>
          </Section>
        ) : null}
      </main>
    </DashboardShell>
  );
}

const smallHeadingStyle = {
  margin: '0 0 8px',
  fontSize: 14,
  color: 'var(--muted)',
  fontWeight: 900,
};

const listStyle = {
  margin: 0,
  paddingLeft: 18,
  color: 'var(--text)',
};

const inputStyle = {
  minHeight: 38,
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--panel)',
  color: 'var(--text)',
  padding: '8px 10px',
};

const textareaStyle = {
  ...inputStyle,
  minHeight: 130,
  resize: 'vertical',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 12,
};

function buttonStyle(tone = 'neutral') {
  return {
    minHeight: 38,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: tone === 'primary' ? 'rgba(56,189,248,0.18)' : 'var(--panel)',
    color: 'var(--text)',
    padding: '8px 12px',
    fontWeight: 800,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

const linkButtonStyle = {
  ...buttonStyle(),
  display: 'inline-flex',
  alignItems: 'center',
  textDecoration: 'none',
};

function tabStyle(active) {
  return {
    ...buttonStyle(active ? 'primary' : 'neutral'),
    borderColor: active ? 'rgba(56,189,248,0.6)' : 'var(--border)',
  };
}

export default PineResearchPage;
