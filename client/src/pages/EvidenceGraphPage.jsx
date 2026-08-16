import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiFetch } from '../lib/apiClient.js';

function fmtTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return date.toLocaleString('sv-SE', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0%';
  return `${n.toLocaleString('sv-SE', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`;
}

function compactId(value) {
  if (!value) return '-';
  const text = String(value);
  if (text.length <= 30) return text;
  return `${text.slice(0, 14)}...${text.slice(-10)}`;
}

function payloadRef(ref) {
  if (!ref) return 'missing';
  const parts = [
    ref.source,
    ref.file,
    ref.rowIndex != null ? `row:${ref.rowIndex}` : null,
    ref.key ? `key:${ref.key}` : null,
    ref.pointer || null,
    ref.derivedBy ? `derived:${ref.derivedBy}` : null,
  ].filter(Boolean);
  return parts.join(' / ') || 'observed';
}

function identityRows(identity = {}) {
  return [
    ['lifecycleId', identity.lifecycleId],
    ['signalId', identity.signalId],
    ['candidateId', identity.candidateId],
    ['intentId', identity.intentId],
    ['executionId', identity.executionId],
    ['tradeId', identity.tradeId],
    ['idempotencyKey', identity.idempotencyKey],
    ['BrokerOrderId', identity.brokerOrderId],
  ].filter(([, value]) => value);
}

function toneForNode(node) {
  if (node.legacy) return 'legacy';
  if (!node.available) return 'muted';
  if (node.status === 'blocked' || node.reasonCode) return 'warn';
  if (['filled', 'closed', 'closed_trade', 'allowed', 'passed', 'created', 'analyzed'].includes(node.status)) return 'good';
  return 'info';
}

function Kpi({ label, value, tone = 'info' }) {
  return (
    <div className={`eg-kpi is-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function GraphNode({ node }) {
  return (
    <article className={`eg-node is-${toneForNode(node)}`}>
      <div className="eg-node-head">
        <div>
          <span>{fmtTime(node.timestamp)}</span>
          <h2>{node.label}</h2>
        </div>
        <strong>{node.status || '-'}</strong>
      </div>

      <div className="eg-node-meta">
        <span>{node.owner || '-'}</span>
        <span>{node.joinMode || '-'}</span>
        {node.legacy ? <span>legacy</span> : null}
      </div>

      <div className="eg-node-reason">
        <b>reasonCode</b>
        <code>{node.reasonCode || '-'}</code>
      </div>

      <div className="eg-node-ref">
        <b>payload reference</b>
        <code>{payloadRef(node.payloadRef)}</code>
      </div>

      <div className="eg-id-grid">
        {identityRows(node.identity).map(([key, value]) => (
          <div key={key}>
            <span>{key}</span>
            <code title={String(value)}>{compactId(value)}</code>
          </div>
        ))}
      </div>
    </article>
  );
}

function SearchResults({ results, activeId, onSelect }) {
  if (!results?.length) return <div className="eg-empty">Inga träffar</div>;
  return (
    <div className="eg-results">
      {results.map((row) => {
        const key = row.lifecycleId || row.candidateId || row.signalId || row.id;
        return (
          <button
            key={`${key}-${row.source}`}
            type="button"
            className={`eg-result${key === activeId ? ' is-active' : ''}`}
            onClick={() => onSelect(key)}
          >
            <span>{row.lifecycleId || row.id || '-'}</span>
            <strong>{row.candidateId || row.signalId || row.intentId || row.executionId || row.tradeId || row.brokerOrderId || '-'}</strong>
            <small>{row.status || row.source || '-'}</small>
          </button>
        );
      })}
    </div>
  );
}

export default function EvidenceGraphPage() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('id') || params.get('q') || '');
  const [graph, setGraph] = useState(null);
  const [searchPayload, setSearchPayload] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const activeId = graph?.root?.lifecycleId || graph?.root?.graphRootId || null;
  const nodes = graph?.graph?.nodes || [];
  const validation = graph?.validation || {};
  const root = graph?.root || {};

  const availableStages = useMemo(
    () => nodes.filter((node) => node.available).length,
    [nodes],
  );

  async function loadGraph(id, nextQuery = query) {
    const trimmed = String(id || '').trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const searchResult = await apiFetch(`/api/evidence-graph/search?q=${encodeURIComponent(nextQuery || trimmed)}&full=1&limit=20`);
      setSearchPayload(searchResult);
      const payload = await apiFetch(`/api/evidence-graph/${encodeURIComponent(trimmed)}?full=1&limit=3000`);
      setGraph(payload);
      setParams({ id: trimmed }, { replace: true });
    } catch (err) {
      setGraph(null);
      setError(err?.message || 'Kunde inte läsa evidence graph.');
    } finally {
      setLoading(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    loadGraph(query, query);
  }

  useEffect(() => {
    const id = params.get('id') || params.get('q');
    if (!id) return;
    setQuery(id);
    loadGraph(id, id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="eg-page">
      <header className="si-head">
        <div>
          <h1>Evidence Graph</h1>
          <p>Signal / Candidate / Ledger / Analytics</p>
        </div>
        <div className="si-safety">
          <span>read-only</span>
          <span>observability</span>
          {root.legacy ? <span>legacy heuristic</span> : null}
        </div>
      </header>

      <form className="eg-search" onSubmit={submit}>
        <label>
          <span>Sök ID</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="lifecycleId, candidateId, signalId, intentId, executionId, tradeId, BrokerOrderId"
          />
        </label>
        <button type="submit" className="si-icon-button" title="Sök" aria-label="Sök" disabled={loading || !query.trim()}>
          S
        </button>
      </form>

      {error ? <div className="si-error">{error}</div> : null}

      <section className="eg-kpis">
        <Kpi label="Graph coverage" value={fmtPct(validation.graphCoveragePct)} tone={validation.ok === false ? 'bad' : 'good'} />
        <Kpi label="Stage coverage" value={fmtPct(validation.materializedStageCoveragePct)} tone="info" />
        <Kpi label="Orphans" value={String(validation.orphanNodes?.length ?? 0)} tone={(validation.orphanNodes?.length || 0) ? 'bad' : 'good'} />
        <Kpi label="Broken joins" value={String(validation.brokenJoins?.length ?? 0)} tone={(validation.brokenJoins?.length || 0) ? 'bad' : 'good'} />
        <Kpi label="Duplicate roots" value={String(validation.duplicateRoots?.length ?? 0)} tone={(validation.duplicateRoots?.length || 0) ? 'bad' : 'good'} />
      </section>

      <section className="eg-layout">
        <aside className="si-panel">
          <div className="si-panel-head">
            <h2>Sökresultat</h2>
            <span>{searchPayload?.count ?? 0}</span>
          </div>
          <SearchResults results={searchPayload?.results || []} activeId={activeId} onSelect={(id) => loadGraph(id, id)} />
        </aside>

        <section className="si-panel">
          <div className="si-panel-head">
            <h2>{root.graphRootId || 'Graf'}</h2>
            <span>{availableStages}/{nodes.length || 0}</span>
          </div>
          {loading && !graph ? (
            <div className="eg-empty">Laddar graf</div>
          ) : nodes.length ? (
            <div className="eg-tree">
              {nodes.map((node) => <GraphNode key={node.id} node={node} />)}
            </div>
          ) : (
            <div className="eg-empty">Ingen graf vald</div>
          )}
        </section>
      </section>
    </main>
  );
}
