import React, { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';

const EXAMPLES = [
  'Sammanfatta marknaden',
  'Finns det systemfel?',
  'Förklara dagens larm',
  'Vilka signaler ska jag bevaka?',
  'Förklara vald symbol',
];

function pageFromPath(pathname) {
  if (pathname.startsWith('/alerts')) return 'alerts';
  if (pathname.startsWith('/system-health') || pathname.startsWith('/health')) return 'system-health';
  if (pathname.startsWith('/aktier')) return 'stocks';
  if (pathname.startsWith('/krypto')) return 'crypto';
  if (pathname.startsWith('/historik')) return 'history';
  if (pathname.startsWith('/review-chart')) return 'review';
  return 'live';
}

function symbolFromSearch(search) {
  const params = new URLSearchParams(search);
  const symbol = params.get('symbol') || params.get('s');
  return symbol ? symbol.toUpperCase().slice(0, 24) : '';
}

export default function AiCopilot() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [context, setContext] = useState(null);
  const [contextLabel, setContextLabel] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [queuedRequest, setQueuedRequest] = useState(null);

  const page = useMemo(() => pageFromPath(location.pathname), [location.pathname]);
  const symbol = useMemo(() => symbolFromSearch(location.search), [location.search]);

  useEffect(() => {
    function handleOpen(event) {
      const detail = event?.detail || {};
      const nextQuestion = String(detail.question || detail.prompt || '').trim();
      const nextContext = detail.context && typeof detail.context === 'object' ? detail.context : null;
      setOpen(true);
      if (nextQuestion) {
        setQuestion(nextQuestion);
      }
      setContext(nextContext);
      setContextLabel(String(detail.label || detail.title || detail.sourceLabel || detail.sectionLabel || nextContext?.sectionLabel || nextContext?.moduleLabel || '').trim());
      if (nextQuestion && detail.autoAsk === true) {
        setQueuedRequest({ question: nextQuestion, context: nextContext });
      }
      if (!nextQuestion && nextContext && detail.autoAsk === true) {
        setQueuedRequest({ question: String(detail.fallbackQuestion || 'Förklara detta sammanhang.').trim(), context: nextContext });
      }
    }

    window.addEventListener('ai-copilot:open', handleOpen);
    return () => window.removeEventListener('ai-copilot:open', handleOpen);
  }, []);

  useEffect(() => {
    if (!queuedRequest) return;
    const next = queuedRequest;
    setQueuedRequest(null);
    ask(next.question, next.context);
  }, [queuedRequest]);

  async function ask(nextQuestion = question, nextContext = context) {
    const q = String(nextQuestion || '').trim();
    if (!q || loading) return;

    setQuestion(q);
    setContext(nextContext && typeof nextContext === 'object' ? nextContext : null);
    setLoading(true);
    setError('');
    setAnswer('');

    try {
      const res = await fetch('/api/ai/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ question: q, page, symbol: symbol || undefined, context: nextContext || undefined }),
      });
      const json = await res.json().catch(() => null);

      if (!res.ok || !json?.ok) {
        if (json?.error === 'AI is not configured') {
          setError('AI-assistenten är inte konfigurerad ännu. Lägg till AI_API_KEY på servern för att aktivera den.');
        } else {
          setError(json?.error || 'AI-assistenten kunde inte svara just nu.');
        }
        return;
      }

      setAnswer(json.answer || 'AI-assistenten gav inget svar.');
    } catch (_) {
      setError('AI-assistenten kunde inte nå servern just nu.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button className="ai-fab" type="button" onClick={() => setOpen(true)}>
        Fråga AI
      </button>

      {open && (
        <div className="ai-shell" role="dialog" aria-modal="true" aria-label="AI Copilot">
          <button className="ai-backdrop" type="button" onClick={() => setOpen(false)} aria-label="Stäng AI" />
          <aside className="ai-panel">
            <div className="ai-head">
              <div>
                <div className="ai-kicker">Read-only Copilot</div>
                <h2>Fråga AI</h2>
              </div>
              <button className="ai-close" type="button" onClick={() => setOpen(false)} aria-label="Stäng">
                ×
              </button>
            </div>

            <p className="ai-intro">
              Fråga om marknad, signaler, larm, historik eller systemhälsa. AI:n kan bara läsa data och utför inga trades.
            </p>

            {context && (
              <div className="ai-context">
                <div className="ai-context-label">Aktiv kontext</div>
                <div className="ai-context-value">
                  {contextLabel || context.sectionLabel || context.moduleLabel || context.module || 'Anpassad vy'}
                </div>
              </div>
            )}

            <div className="ai-examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => ask(ex)} disabled={loading}>
                  {ex}
                </button>
              ))}
            </div>

            <label className="ai-label" htmlFor="ai-question">Din fråga</label>
            <textarea
              id="ai-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Exempel: Sammanfatta läget och vad jag bör bevaka."
              rows={4}
            />

            <button className="ai-submit" type="button" onClick={() => ask()} disabled={loading || !question.trim()}>
              {loading ? 'Tänker...' : 'Skicka'}
            </button>

            {error && <div className="ai-error">{error}</div>}
            {answer && <div className="ai-answer">{answer}</div>}

            <div className="ai-risk">
              Read-only: inga trades, inga ordrar och ingen livehandel. Här visas bara data och sammanfattning.
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
