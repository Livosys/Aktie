import React, { useEffect, useState, useCallback } from 'react';
import { SectionHeader } from '../shared.jsx';

const QUICK_QUESTIONS = [
  'Varför öppnas inga trades?',
  'Varför blir det timeout?',
  'Vad ska jag justera först?',
  'Vilken strategi fungerar bäst?',
  'Är systemet säkert?',
  'Varför blockar riskmotorn?',
  'Vad säger Exit Engine?',
];

function Badge({ label, color = 'gray' }) {
  const colors = { high: 'var(--red)', medium: 'var(--yellow)', low: 'var(--blue)', info: 'var(--green)', gray: 'var(--muted)' };
  return (
    <span style={{ background: colors[color] || colors.gray, color: '#fff', borderRadius: 4, padding: '1px 7px', fontSize: 11, fontWeight: 700, marginRight: 6 }}>
      {label}
    </span>
  );
}

function ConfidenceBar({ value }) {
  const pct = Math.min(100, Math.max(0, Number(value) || 0));
  const color = pct >= 75 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
      <div style={{ flex: 1, background: 'var(--card-border)', borderRadius: 4, height: 6 }}>
        <div style={{ width: `${pct}%`, background: color, borderRadius: 4, height: 6, transition: 'width 0.4s' }} />
      </div>
      <small style={{ color: 'var(--muted)', minWidth: 36 }}>{pct}%</small>
    </div>
  );
}

function AdjBadge({ value }) {
  const n = Number(value) || 0;
  const color = n > 0 ? 'var(--green)' : n < 0 ? 'var(--red)' : 'var(--muted)';
  return <span style={{ color, fontWeight: 700, fontSize: 13 }}>{n >= 0 ? `+${n}` : n}</span>;
}

function RecBadge({ rec }) {
  const colors = { BUY: 'var(--green)', SELL: 'var(--red)', HOLD: 'var(--yellow)', OBSERVE: 'var(--blue)' };
  const r = String(rec || 'OBSERVE').toUpperCase();
  return <span style={{ background: colors[r] || 'var(--muted)', color: '#fff', borderRadius: 4, padding: '2px 10px', fontSize: 12, fontWeight: 700 }}>{r}</span>;
}

// ── TradingAgents panel ───────────────────────────────────────────────────────

function TradingAgentsPanel() {
  const [ta, setTa] = useState(null);
  const [taStatus, setTaStatus] = useState(null);
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/tradingagents/status').then(r => r.json()).then(j => { if (j.ok) setTaStatus(j); }).catch(() => {});
  }, []);

  async function analyze() {
    const sym = symbol.trim().toUpperCase();
    if (!sym || busy) return;
    setBusy(true);
    setError(null);
    setTa(null);
    try {
      const res = await fetch('/api/tradingagents/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: sym }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Okänt fel');
      setTa(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadLatest() {
    const sym = symbol.trim().toUpperCase();
    if (!sym || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tradingagents/latest/${sym}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Okänt fel');
      setTa(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sl-panel" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
        <SectionHeader icon="T" title="TradingAgents AI" desc="Read-only AI research layer — kan bara läsa och rekommendera." />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {taStatus && <span style={{ color: 'var(--muted)', fontSize: 12 }}>{taStatus.mode}</span>}
          <Badge label="Read-only research" color="info" />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input
          value={symbol}
          onChange={e => setSymbol(e.target.value.toUpperCase())}
          style={{ flex: 1 }}
          placeholder="t.ex. BTCUSDT"
          onKeyDown={e => { if (e.key === 'Enter') analyze(); }}
        />
        <button className="btn primary" onClick={analyze} disabled={busy}>{busy ? 'Analyserar...' : 'Analysera'}</button>
        <button className="btn" onClick={loadLatest} disabled={busy}>Senaste</button>
      </div>

      {error && <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)', marginTop: 8 }}>{error}</div>}

      {ta && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <strong style={{ fontSize: 14 }}>{ta.symbol}</strong>
            <RecBadge rec={ta.recommendation} />
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>Konfidensändring: <AdjBadge value={ta.confidence_adjustment} /></span>
            {ta.should_block_trade && <Badge label="BLOCK" color="high" />}
          </div>

          {ta.market_narrative && (
            <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 6, padding: '10px 14px', marginBottom: 10 }}>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>{ta.market_narrative}</p>
            </div>
          )}

          <div className="sl-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div>
              <strong style={{ fontSize: 12, color: 'var(--green)' }}>Bull case</strong>
              <ul style={{ marginTop: 4, paddingLeft: 16, fontSize: 12, lineHeight: 1.7 }}>
                {(ta.bull_case || []).map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
            <div>
              <strong style={{ fontSize: 12, color: 'var(--red)' }}>Bear case</strong>
              <ul style={{ marginTop: 4, paddingLeft: 16, fontSize: 12, lineHeight: 1.7 }}>
                {(ta.bear_case || []).map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
            <div>
              <strong style={{ fontSize: 12, color: 'var(--yellow)' }}>Risk notes</strong>
              <ul style={{ marginTop: 4, paddingLeft: 16, fontSize: 12, lineHeight: 1.7 }}>
                {(ta.risk_notes || []).map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          </div>

          {ta.warnings?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {ta.warnings.map((w, i) => <Badge key={i} label={w} color="medium" />)}
            </div>
          )}

          <p style={{ marginTop: 10, fontSize: 11, color: 'var(--muted)', borderTop: '1px solid var(--card-border)', paddingTop: 8 }}>
            ⚠ Read-only AI research layer. can_place_orders: {String(ta.can_place_orders)} · actions_allowed: {String(ta.actions_allowed)} · {ta.source}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function IntelligencePage() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [recs, setRecs] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [symbolInput, setSymbolInput] = useState('BTCUSDT');

  async function loadRecs() {
    try {
      const res = await fetch('/api/intelligence/recommendations');
      const json = await res.json();
      if (json.ok) setRecs(json);
    } catch (_) {}
  }

  async function loadStatus() {
    try {
      const res = await fetch('/api/intelligence/status');
      const json = await res.json();
      if (json.ok) setStatus(json);
    } catch (_) {}
  }

  useEffect(() => {
    loadStatus();
    loadRecs();
  }, []);

  const analyze = useCallback(async (q) => {
    const text = (q || question).trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setQuestion(text);
    try {
      const res = await fetch('/api/intelligence/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Okänt fel');
      setResult(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [question, busy]);

  async function explainSymbol() {
    const sym = symbolInput.trim().toUpperCase();
    if (!sym || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/intelligence/explain/latest/${sym}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Okänt fel');
      setResult(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const priorityColor = (p) => ({ high: 'high', medium: 'medium', low: 'low', info: 'info' }[p] || 'gray');

  return (
    <div>
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title hero-accent-purple">System Intelligence</div>
          <div className="hero-sub">AI-agenten kan bara läsa och rekommendera. Den kan inte ändra systemet.</div>
        </div>
        {status && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>
              {status.mode} · LLM: {status.llm_enabled ? status.llm_provider : 'av'}
            </span>
            <Badge label="Read-only" color="info" />
          </div>
        )}
      </div>

      {/* Quick buttons */}
      <div className="sl-panel" style={{ marginBottom: 16 }}>
        <SectionHeader icon="⚡" title="Snabbfrågor" desc="Klicka för att analysera direkt." />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {QUICK_QUESTIONS.map(q => (
            <button key={q} className="btn" style={{ fontSize: 13 }} onClick={() => analyze(q)} disabled={busy}>
              {q}
            </button>
          ))}
        </div>
      </div>

      <div className="sl-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Ask panel */}
        <div className="sl-panel">
          <SectionHeader icon="?" title="Ställ en fråga" desc="Ange valfri fråga om systemet." />
          <div className="sl-form">
            <label>
              Din fråga
              <textarea
                rows={3}
                value={question}
                onChange={e => setQuestion(e.target.value)}
                placeholder="T.ex. Varför öppnas inga trades?"
                style={{ width: '100%', resize: 'vertical' }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); analyze(); } }}
              />
            </label>
            <button className="btn primary" onClick={() => analyze()} disabled={busy || !question.trim()}>
              {busy ? 'Analyserar...' : 'Fråga agenten'}
            </button>
          </div>
          <div style={{ marginTop: 12 }}>
            <SectionHeader icon="S" title="Förklara symbol" desc="Hämta senaste agentbeslut för en symbol." />
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <input value={symbolInput} onChange={e => setSymbolInput(e.target.value.toUpperCase())} style={{ flex: 1 }} placeholder="t.ex. BTCUSDT" />
              <button className="btn" onClick={explainSymbol} disabled={busy}>Förklara</button>
            </div>
          </div>
        </div>

        {/* Recommendations */}
        <div className="sl-panel">
          <SectionHeader icon="R" title="Rekommendationer" desc="Automatiska systemrekommendationer." />
          {recs ? (
            <div className="sl-list" style={{ marginTop: 8 }}>
              {recs.recommendations.map((r, i) => (
                <div className="sl-list-row" key={i} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2, paddingBottom: 8, borderBottom: '1px solid var(--card-border)' }}>
                  <div><Badge label={r.priority} color={priorityColor(r.priority)} /><strong style={{ fontSize: 13 }}>{r.area}</strong></div>
                  <span style={{ fontSize: 13 }}>{r.message}</span>
                  <small style={{ color: 'var(--muted)' }}>{r.action}</small>
                </div>
              ))}
            </div>
          ) : <span style={{ color: 'var(--muted)' }}>Laddar rekommendationer...</span>}
          <button className="btn" style={{ marginTop: 10, fontSize: 12 }} onClick={loadRecs}>Uppdatera</button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)', marginTop: 12 }}>
          {error}
        </div>
      )}

      {/* Answer */}
      {result && (
        <div className="sl-panel" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
            <SectionHeader icon="A" title="Svar" desc={result.question} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>Motor: {result.engine || result.source}</span>
              <Badge label="Ej verkställande" color="info" />
            </div>
          </div>

          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 6, padding: 14, marginTop: 8 }}>
            <p style={{ margin: 0, lineHeight: 1.6 }}>{result.answer_sv}</p>
          </div>

          <div style={{ marginTop: 8 }}>
            <small style={{ color: 'var(--muted)' }}>Konfidens</small>
            <ConfidenceBar value={result.confidence} />
          </div>

          {result.key_findings?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <strong style={{ fontSize: 13 }}>Nyckelupptäckter</strong>
              <ul style={{ marginTop: 4, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
                {result.key_findings.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}

          {result.recommendations?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <strong style={{ fontSize: 13 }}>Rekommendationer</strong>
              <ul style={{ marginTop: 4, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
                {result.recommendations.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}

          <p style={{ marginTop: 12, fontSize: 11, color: 'var(--muted)', borderTop: '1px solid var(--card-border)', paddingTop: 8 }}>
            ⚠ AI-agenten kan bara läsa och rekommendera. Den kan inte ändra systemet. actions_allowed: {String(result.actions_allowed)} · can_modify_system: {String(result.can_modify_system)}
          </p>
        </div>
      )}

      {/* TradingAgents panel */}
      <TradingAgentsPanel />
    </div>
  );
}
