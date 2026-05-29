import React, { useState, useEffect, useCallback } from 'react';
import { PlatformEmptyState } from '../components/PlatformControls.jsx';

// ─── Data hook ────────────────────────────────────────────────────────────────

function useDaytradingData() {
  const [state, setState] = useState({
    status: null, strategies: null, pipeline: null,
    liveTrades: null, recommendation: null, impact: null, symbols: null, runtime: null,
    loading: true, error: false,
  });

  const fetchAll = useCallback(async () => {
    const get = url => fetch(url).then(r => r.json()).catch(() => null);
    const [statusD, strD, pipeD, tradesD, recD, impD, symD, runtimeD] = await Promise.all([
      get('/api/daytrading/status'), get('/api/daytrading/strategies'),
      get('/api/daytrading/pipeline'), get('/api/daytrading/live-trades'),
      get('/api/daytrading/recommendation'), get('/api/daytrading/impact-summary'),
      get('/api/daytrading/symbols'), get('/api/daytrading/runtime-strategies'),
    ]);
    setState({
      status: statusD, strategies: strD, pipeline: pipeD, liveTrades: tradesD,
      recommendation: recD, impact: impD, symbols: symD, runtime: runtimeD,
      loading: false, error: !statusD?.ok,
    });
  }, []);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 20000);
    return () => clearInterval(t);
  }, [fetchAll]);

  return { ...state, refresh: fetchAll };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeSince(iso) {
  if (!iso) return null;
  const diff = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff} sek sedan`;
  if (diff < 3600) return `${Math.floor(diff / 60)} min sedan`;
  return `${Math.floor(diff / 3600)} tim sedan`;
}

function fmtScore(s)  { return s != null ? Math.round(s) : '–'; }
function fmtPct(v) {
  if (v == null) return '–';
  const n = Number(v);
  return isNaN(n) ? '–' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function sanitizePipeText(text) {
  if (!text) return text;
  if (text.includes('Ingen strategi') && text.endsWith('matchade.')) return 'Ingen strategi har matchat ännu.';
  return text;
}

function badgeColor(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'aktiv') return 'dt-badge-green';
  if (s === 'pausad') return 'dt-badge-yellow';
  if (s.includes('undvik') || s.includes('blockerad')) return 'dt-badge-red';
  if (s === 'testas') return 'dt-badge-blue';
  return 'dt-badge-gray';
}

function runtimeClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active' || s === 'aktiv') return 'dt-runtime-active';
  if (s === 'partial' || s === 'delvis') return 'dt-runtime-partial';
  if (s === 'paused' || s === 'pausad') return 'dt-runtime-paused';
  if (s === 'disabled' || s.includes('avstängd')) return 'dt-runtime-paused';
  if (s === 'no_entry_rule' || s.includes('entry')) return 'dt-runtime-data';
  if (s === 'needs_data' || s.includes('behöver')) return 'dt-runtime-data';
  return 'dt-runtime-unlinked';
}

function pipeClass(status) {
  if (status === 'klar') return 'dt-pipe-klar';
  if (status === 'kor')  return 'dt-pipe-kor';
  if (status === 'blockerad') return 'dt-pipe-blockerad';
  if (status === 'fel')  return 'dt-pipe-fel';
  return 'dt-pipe-vantar';
}

const PIPE_SV = { klar: 'Klar', kor: 'Kör', vantar: 'Väntar', blockerad: 'Blockerad', fel: 'Fel' };
const PIPE_ICONS = {
  data: '⬇', scanner: '⊙', symbol: '◎', strategy: '⬡',
  risk: '⊘', safety: '🔒', paper: '◉', follow: '◷', exit: '↗', result: '▣', learning: '⟳',
};

// ─── A) Status chips ──────────────────────────────────────────────────────────

function Chip({ label, value, color }) {
  return (
    <div className={`dt-chip dt-chip-${color || 'gray'}`}>
      <span className="dt-chip-dot" />
      <span className="dt-chip-label">{label}</span>
      {value && <span className="dt-chip-value">{value}</span>}
    </div>
  );
}

function StatusBar({ status }) {
  if (!status) return null;
  const liveOn = status.live_trading === true || status.live_trading_enabled === true;
  return (
    <div className="dt-status-bar">
      <Chip label="Backend"       value={status.backend_connected ? 'Ansluten' : 'Ej ansluten'} color={status.backend_connected ? 'green' : 'red'} />
      <Chip label="Scanner"       value={status.scanner_active ? 'Aktiv' : 'Pausad'}             color={status.scanner_active ? 'green' : 'yellow'} />
      <Chip label="Data"          value={status.data_active ? 'Aktiv' : 'Saknas'}                color={status.data_active ? 'green' : 'yellow'} />
      <Chip label="Inlärning"     value={status.learning_active ? 'Aktiv' : 'Av'}                color={status.learning_active ? 'green' : 'yellow'} />
      {status.latest_scan && <Chip label="Senaste scan" value={timeSince(status.latest_scan)} color="blue" />}
      <Chip label="Paper trading" value={status.paper_trading ? 'PÅ' : 'AV'}                     color={status.paper_trading ? 'green' : 'gray'} />
      {liveOn
        ? <Chip label="Live trading" value="PÅ — kontrollera backend" color="red" />
        : <Chip label="Live trading" value="AV" color="gray" />
      }
    </div>
  );
}

// ─── B) Safety banner ─────────────────────────────────────────────────────────

function SafetyBanner({ status }) {
  const liveOn = status?.live_trading === true || status?.live_trading_enabled === true;
  if (liveOn) {
    return (
      <div className="dt-safety-banner dt-safety-warn">
        <span>⚠️</span>
        <div><strong>Varning: live trading verkar vara aktiverat.</strong><span>Kontrollera backend innan du fortsätter.</span></div>
      </div>
    );
  }
  return (
    <div className="dt-safety-banner dt-safety-ok">
      <span>🔒</span>
      <div>
        <strong>Safety aktiv:</strong>
        <span>Systemet kan analysera och paper-trada, men kan inte lägga riktiga ordrar.</span>
        <div className="dt-safety-flags">
          <code>actions_allowed=false</code>
          <code>can_place_orders=false</code>
          <code>live_trading_enabled=false</code>
        </div>
      </div>
    </div>
  );
}

// ─── C) Process just nu ───────────────────────────────────────────────────────

function ProcessCard({ status, pipeline }) {
  const steps = pipeline?.pipeline || [];
  const symStep   = steps.find(s => s.id === 'symbol');
  const stratStep = steps.find(s => s.id === 'strategy');
  const decStep   = steps.find(s => s.id === 'paper');

  const symbol   = symStep?.text?.match(/^(\S+)\s/)?.[1] ?? '–';
  const stratTxt = stratStep?.text || '';
  const strategy = !stratTxt.includes('Ingen')
    ? (stratTxt.match(/^(.+?)\s+matchade/)?.[1] ?? stratTxt.replace(/\.$/, ''))
    : '–';

  const items = [
    { label: 'Senaste symbol',   value: symbol },
    { label: 'Senaste strategi', value: strategy },
    { label: 'Senaste beslut',   value: sanitizePipeText(decStep?.text) || '–' },
    { label: 'Safety',           value: '🔒 Aktiv',                              cls: 'dt-pv-green' },
    { label: 'Senaste scan',     value: status?.latest_scan ? timeSince(status.latest_scan) : '–' },
    { label: 'Paper trading',    value: status?.paper_trading ? 'PÅ' : 'AV',    cls: status?.paper_trading ? 'dt-pv-green' : '' },
    { label: 'Live trading',     value: 'AV',                                    cls: 'dt-pv-gray' },
  ];

  return (
    <div className="dt-process-card">
      <div className="dt-process-title">Process just nu</div>
      <div className="dt-process-grid">
        {items.map(({ label, value, cls }) => (
          <div key={label} className="dt-process-item">
            <div className="dt-process-label">{label}</div>
            <div className={`dt-process-value${cls ? ` ${cls}` : ''}`}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── D) Pipeline ──────────────────────────────────────────────────────────────

function PipelineSection({ pipeline }) {
  const steps = pipeline?.pipeline || [];
  const activeStep = steps.find(s => s.status === 'kor')
    || [...steps].reverse().find(s => s.status === 'klar' || s.status === 'blockerad');

  function openAi() { document.querySelector('.ai-fab')?.click(); }

  return (
    <div className="dt-panel dt-pipeline-panel">
      <div className="dt-pipeline-header">
        <div>
          <h2 className="dt-pipeline-title">Process från signal till resultat</h2>
          <p className="dt-pipeline-sub">Så går en signal från scan till paper trade, exit, resultat och lärande.</p>
        </div>
        <button type="button" className="dt-ai-hint" onClick={openAi}>Fråga AI om denna pipeline</button>
      </div>

      {!steps.length ? (
        <PlatformEmptyState
          title="Ingen pipeline aktiv just nu"
          text="Pipeline visas när scanner hittar eller analyserar en signal. Kör ny scan."
        />
      ) : (
        <>
          <div className="dt-pipeline-flow">
            {steps.map((step, i) => (
              <React.Fragment key={step.id}>
                {i > 0 && <div className="dt-pipe-arrow">›</div>}
                <div className={`dt-pipe-node ${pipeClass(step.status)}`}>
                  <div className="dt-pipe-node-box">
                    <span className="dt-pipe-node-icon">{PIPE_ICONS[step.id] || '○'}</span>
                    <span className="dt-pipe-node-status">{PIPE_SV[step.status] || '–'}</span>
                  </div>
                  <div className="dt-pipe-node-lbl">{step.label}</div>
                </div>
              </React.Fragment>
            ))}
          </div>
          {activeStep && (
            <div className={`dt-pipe-active-text dt-pipe-text-${pipeClass(activeStep.status).replace('dt-pipe-', '')}`}>
              <strong>{activeStep.label}:</strong> {sanitizePipeText(activeStep.text)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── E) Rekommendation ───────────────────────────────────────────────────────

function RecommendationBar({ rec }) {
  if (!rec?.ok) return null;
  return (
    <div className="dt-rec-bar">
      {rec.best_strategy && (
        <div className="dt-rec-bar-item dt-rec-bar-best">
          <span className="dt-rec-bar-icon">★</span>
          <div>
            <div className="dt-rec-bar-role">Bäst att testa just nu</div>
            <div className="dt-rec-bar-name">{rec.best_strategy.strategy_name}</div>
            {rec.best_strategy.win_rate != null && (
              <div className="dt-rec-bar-sub">{rec.best_strategy.win_rate.toFixed(1)}% WR · score {fmtScore(rec.best_strategy.score)}</div>
            )}
          </div>
        </div>
      )}
      {rec.avoid_strategy && (
        <div className="dt-rec-bar-item dt-rec-bar-avoid">
          <span className="dt-rec-bar-icon">⚠</span>
          <div>
            <div className="dt-rec-bar-role">Undvik i test just nu</div>
            <div className="dt-rec-bar-name">{rec.avoid_strategy.strategy_name}</div>
          </div>
        </div>
      )}
      {rec.recommendation_sv && <p className="dt-rec-bar-text">{rec.recommendation_sv}</p>}
    </div>
  );
}

// ─── F) Filter bar ───────────────────────────────────────────────────────────

const MARKETS   = [{ id:'all',label:'Alla'},{id:'stocks',label:'Aktier'},{id:'nasdaq',label:'Nasdaq'},{id:'crypto',label:'Krypto'},{id:'etf',label:'ETF'}];
const DIRECTIONS= [{ id:'all',label:'Alla'},{id:'long',label:'Long'},{id:'short',label:'Short'}];
const SCORES    = [{ id:0,label:'Alla'},{id:50,label:'50+'},{id:60,label:'60+'},{id:70,label:'70+'},{id:80,label:'80+'}];

function Pills({ options, value, onChange }) {
  return (
    <div className="dt-pills">
      {options.map(o => (
        <button key={o.id} type="button"
          className={`dt-pill${value === o.id ? ' dt-pill-active' : ''}`}
          onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

function FilterBar({ filters, onChange, onScan, scanning, symbols }) {
  const symRows = (symbols?.symbols || []).filter(s => s.enabled && !s.paused);
  const selectedSym = symRows.find(s => s.symbol === filters.symbol);

  return (
    <div className="dt-filter-bar-wrap">
      <div className="dt-filter-bar">
        <div className="dt-filter-bar-group">
          <span className="dt-filter-bar-lbl">Marknad</span>
          <Pills options={MARKETS} value={filters.market}    onChange={v => onChange({...filters, market: v, _dirty: true})} />
        </div>
        <div className="dt-filter-bar-sep" />
        <div className="dt-filter-bar-group">
          <span className="dt-filter-bar-lbl">Riktning</span>
          <Pills options={DIRECTIONS} value={filters.direction} onChange={v => onChange({...filters, direction: v, _dirty: true})} />
        </div>
        <div className="dt-filter-bar-sep" />
        <div className="dt-filter-bar-group">
          <span className="dt-filter-bar-lbl">Score</span>
          <Pills options={SCORES} value={filters.minScore}   onChange={v => onChange({...filters, minScore: v, _dirty: true})} />
        </div>
        {symRows.length > 0 && (
          <>
            <div className="dt-filter-bar-sep" />
            <div className="dt-filter-bar-group">
              <span className="dt-filter-bar-lbl">Symbol</span>
              <select className="dt-filter-select dt-filter-select-sm" value={filters.symbol || ''}
                onChange={e => onChange({...filters, symbol: e.target.value, _dirty: true})}>
                <option value="">Alla</option>
                {symRows.map(s => <option key={s.symbol} value={s.symbol}>{s.symbol}</option>)}
              </select>
              {selectedSym?.data_status_sv && (
                <span className={`dt-sym-inline ${selectedSym.has_data ? 'dt-sym-ok' : 'dt-sym-warn'}`}>
                  {selectedSym.data_status_sv}
                </span>
              )}
            </div>
          </>
        )}
        <button type="button"
          className={`dt-scan-btn dt-scan-btn-sm${scanning ? ' dt-scan-btn-loading' : ''}`}
          onClick={onScan} disabled={scanning}>
          {scanning ? 'Söker...' : 'Kör ny scan'}
        </button>
      </div>
      {filters._dirty && <div className="dt-filter-hint">Filter ändrat – kör ny scan för att uppdatera resultat</div>}
    </div>
  );
}

// ─── G) Strategikontroll ─────────────────────────────────────────────────────

function StrategyDetailModal({ strategy, onClose, onSave, saving }) {
  const cfg = strategy.config || {};
  const [form, setForm] = useState({
    active: cfg.active !== false, market: cfg.market || 'all',
    direction: cfg.direction || 'both', timeframe: cfg.timeframe || '2m',
    min_score: cfg.min_score ?? 50, min_confidence: cfg.min_confidence ?? 65,
    stop_loss: cfg.stop_loss ?? 0.2, take_profit: cfg.take_profit ?? 1.5,
    max_trades: cfg.max_trades ?? 3, hide_avoid: cfg.hide_avoid || false,
  });
  const set = (k, v) => setForm(f => ({...f, [k]: v}));

  return (
    <div className="dt-modal-overlay" onClick={onClose}>
      <div className="dt-modal" onClick={e => e.stopPropagation()}>
        <div className="dt-modal-head">
          <h3>{strategy.name}</h3>
          <button type="button" className="dt-modal-close" onClick={onClose}>✕</button>
        </div>
        <p className="dt-modal-desc">{strategy.simple_explanation_sv || strategy.description_sv || strategy.explanation}</p>
        <div className="dt-modal-form">
          <div className="dt-form-row"><label>Status</label>
            <div className="dt-pills">
              <button type="button" className={`dt-pill${form.active?' dt-pill-active':''}`} onClick={()=>set('active',true)}>Aktiv</button>
              <button type="button" className={`dt-pill${!form.active?' dt-pill-active':''}`} onClick={()=>set('active',false)}>Pausad</button>
            </div>
          </div>
          <div className="dt-form-row"><label>Marknad</label>
            <select className="dt-filter-select" value={form.market} onChange={e=>set('market',e.target.value)}>
              {MARKETS.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          <div className="dt-form-row"><label>Riktning</label>
            <div className="dt-pills">
              {[['both','Båda'],['long','Long'],['short','Short']].map(([id,lbl])=>(
                <button key={id} type="button" className={`dt-pill${form.direction===id?' dt-pill-active':''}`} onClick={()=>set('direction',id)}>{lbl}</button>
              ))}
            </div>
          </div>
          <div className="dt-form-row"><label>Timeframe</label>
            <select className="dt-filter-select" value={form.timeframe} onChange={e=>set('timeframe',e.target.value)}>
              {['1m','2m','5m','15m','30m','1h'].map(t=><option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="dt-form-row"><label>Min score: <strong>{form.min_score}</strong></label>
            <input type="range" min={0} max={90} step={5} value={form.min_score} onChange={e=>set('min_score',Number(e.target.value))} className="dt-slider" />
          </div>
          <div className="dt-form-row"><label>Min confidence: <strong>{form.min_confidence}%</strong></label>
            <input type="range" min={0} max={100} step={5} value={form.min_confidence} onChange={e=>set('min_confidence',Number(e.target.value))} className="dt-slider" />
          </div>
          <div className="dt-form-row"><label>Stop loss: <strong>{form.stop_loss}%</strong></label>
            <input type="range" min={0.05} max={1} step={0.05} value={form.stop_loss} onChange={e=>set('stop_loss',Number(e.target.value))} className="dt-slider" />
          </div>
          <div className="dt-form-row"><label>Take profit: <strong>{form.take_profit}R</strong></label>
            <input type="range" min={0.5} max={5} step={0.1} value={form.take_profit} onChange={e=>set('take_profit',Number(e.target.value))} className="dt-slider" />
          </div>
          <div className="dt-form-row"><label>Max trades/dag: <strong>{form.max_trades}</strong></label>
            <input type="range" min={1} max={10} step={1} value={form.max_trades} onChange={e=>set('max_trades',Number(e.target.value))} className="dt-slider" />
          </div>
          <div className="dt-form-row"><label>Dölj undvik-signaler</label>
            <div className="dt-pills">
              <button type="button" className={`dt-pill${form.hide_avoid?' dt-pill-active':''}`} onClick={()=>set('hide_avoid',!form.hide_avoid)}>
                {form.hide_avoid ? 'Ja – dolda' : 'Nej – visas'}
              </button>
            </div>
          </div>
        </div>
        <div className="dt-modal-foot">
          <div className="dt-modal-safety">🔒 Ändringar påverkar bara strategi, scanner och paper trading. Riktig handel är avstängd.</div>
          <div className="dt-modal-btns">
            <button type="button" className="dt-btn dt-btn-sec" onClick={onClose}>Avbryt</button>
            <button type="button" className="dt-btn dt-btn-pri" onClick={()=>onSave(form)} disabled={saving}>
              {saving ? 'Sparar...' : 'Spara testinställning'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StrategyCard({ strategy, onUpdate, onScan }) {
  const [showDetail, setShowDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const cfg = strategy.config || {};
  const enabledByUser = strategy.enabled_by_user ?? cfg.enabled_by_user ?? (cfg.active !== false);
  const status = strategy.status || (enabledByUser ? 'Aktiv' : 'Pausad');
  const runtime = strategy.runtime || {};
  const runtimeStatus = strategy.runtime_status || runtime.runtime_status || 'not_connected';
  const runtimeLabel = strategy.runtime_label || runtime.runtime_label || 'Ej kopplad till paper ännu';
  const runtimeSignals = strategy.runtime_raw_signals || runtime.runtime_raw_signals || [];
  const runtimeComment = strategy.runtime_comment_sv || runtime.runtime_comment_sv || runtime.comment_sv || 'Finns i katalog/teststatistik men skapar inte paper trades ännu.';
  const paperTrades48h = strategy.paper_trades_48h ?? runtime.paper_trades_48h ?? 0;
  const lastPaperTradeAt = strategy.last_paper_trade_at || runtime.last_paper_trade_at || null;
  const catalogBadges = strategy.catalog_badges || ['Katalog', runtimeLabel];
  const connected = strategy.connected ?? runtime.connected ?? false;
  const entryRuleImplemented = strategy.entry_rule_implemented ?? runtime.entry_rule_implemented ?? false;
  const canCreatePaperTrade = strategy.can_create_paper_trade ?? runtime.can_create_paper_trade ?? false;

  function showToast(msg) { setToast(msg); setTimeout(()=>setToast(null), 2500); }

  async function postUpdate(patch) {
    return fetch(`/api/daytrading/strategies/${strategy.id}/update`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(patch),
    }).then(r=>r.json()).catch(()=>null);
  }

  async function handleSave(form) {
    setSaving(true);
    const res = await postUpdate(form);
    setSaving(false);
    if (res?.ok) { showToast('Strategin uppdaterad'); setShowDetail(false); onUpdate?.(); }
    else showToast(res?.error || 'Kunde inte spara');
  }

  async function handleToggle(active) {
    if (runtimeSaving) return;
    setRuntimeSaving(true);
    const res = await fetch(`/api/daytrading/runtime-strategies/${encodeURIComponent(strategy.id)}/toggle`, { method: 'POST' })
      .then(r=>r.json()).catch(()=>null);
    setRuntimeSaving(false);
    if (res?.ok) { showToast(active ? 'Aktiverad i paper test' : 'Pausad i paper test'); onUpdate?.(); }
    else showToast(res?.error || 'Kunde inte uppdatera strategi-runtime. Försök igen.');
  }

  return (
    <div className={`dt-strategy-card dt-strategy-card-compact ${badgeColor(status).replace('dt-badge-','dt-card-')}`}>
      {toast && <div className="dt-toast">{toast}</div>}

      <div className="dt-strategy-head">
        <div className="dt-strategy-title-wrap">
          <div className="dt-strategy-name">{strategy.name}</div>
        </div>
        <span className={`dt-badge ${badgeColor(status)}`}>{status}</span>
      </div>

      <div className="dt-catalog-badges">
        {catalogBadges.map((badge) => (
          <span key={badge} className="dt-catalog-badge">{badge}</span>
        ))}
      </div>

      <div className="dt-strategy-meta">
        <span>{strategy.market_label || cfg.market || '–'}</span>
        <span className="dt-meta-sep">·</span>
        <span>{cfg.direction==='long'?'Long':cfg.direction==='short'?'Short':'Båda'}</span>
        <span className="dt-meta-sep">·</span>
        <span>{cfg.timeframe||'2m'}</span>
      </div>

      <div className="dt-strategy-metrics">
        <div className="dt-metric">
          <div className="dt-metric-val">{strategy.win_rate!=null?`${Number(strategy.win_rate).toFixed(1)}%`:'–'}</div>
          <div className="dt-metric-lbl">Win rate</div>
        </div>
        <div className="dt-metric">
          <div className="dt-metric-val">{fmtPct(strategy.avg_pnl)}</div>
          <div className="dt-metric-lbl">Snitt P/L</div>
        </div>
        <div className="dt-metric">
          <div className="dt-metric-val">{strategy.trades||0}</div>
          <div className="dt-metric-lbl">Trades</div>
        </div>
        <div className="dt-metric">
          <div className="dt-metric-val dt-score">{fmtScore(strategy.score)}</div>
          <div className="dt-metric-lbl">Score</div>
        </div>
      </div>

      <div className={`dt-runtime-box ${runtimeClass(runtimeStatus)}`}>
        <div className="dt-runtime-row">
          <span>Connected</span>
          <strong>{connected ? 'Ja' : 'Nej'}</strong>
        </div>
        <div className="dt-runtime-row">
          <span>Paper test</span>
          <strong>{enabledByUser ? 'På' : 'Av'}</strong>
        </div>
        <div className="dt-runtime-row">
          <span>Paper-runtime</span>
          <strong>{runtimeLabel}</strong>
        </div>
        <div className="dt-runtime-row">
          <span>Entry-regel</span>
          <strong>{entryRuleImplemented ? (canCreatePaperTrade === 'partial' ? 'Delvis' : 'Implementerad') : 'Saknas'}</strong>
        </div>
        <div className="dt-runtime-row">
          <span>Rå signal</span>
          <strong>{runtimeSignals.length ? runtimeSignals.join(', ') : '–'}</strong>
        </div>
        <div className="dt-runtime-row">
          <span>Paper trades 48h</span>
          <strong>{paperTrades48h}</strong>
        </div>
        {lastPaperTradeAt && (
          <div className="dt-runtime-row">
            <span>Senast</span>
            <strong>{new Date(lastPaperTradeAt).toLocaleString('sv-SE',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</strong>
          </div>
        )}
        <div className="dt-runtime-comment">{runtimeComment}</div>
      </div>

      <div className="dt-strategy-actions">
        {enabledByUser
          ? <button type="button" className="dt-btn-sm dt-btn-warn" disabled={runtimeSaving} onClick={()=>handleToggle(false)}>{runtimeSaving ? 'Sparar...' : 'Paper test Av'}</button>
          : <button type="button" className="dt-btn-sm dt-btn-ok" disabled={runtimeSaving} onClick={()=>handleToggle(true)}>{runtimeSaving ? 'Sparar...' : 'Paper test På'}</button>
        }
        <button type="button" className="dt-btn-sm dt-btn-sec" onClick={()=>onScan?.(strategy.id)}>Kör scan</button>
        <button type="button" className="dt-btn-sm dt-btn-pri" onClick={()=>setShowDetail(true)}>Detaljer</button>
      </div>
      <div className="dt-strategy-mode-note">Paper test styr användarens På/Av. Runtime-status avgör om strategin faktiskt kan skapa paper trades.</div>

      {showDetail && (
        <StrategyDetailModal strategy={strategy} onClose={()=>setShowDetail(false)} onSave={handleSave} saving={saving} />
      )}
    </div>
  );
}

function CollapsibleGroup({ label, colorClass, items, defaultOpen, onUpdate, onScan }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!items.length) return null;
  return (
    <div className="dt-collapsible-group">
      <button type="button" className="dt-group-toggle" onClick={()=>setOpen(v=>!v)}>
        <span className={`dt-group-chip ${colorClass}`}>{label}</span>
        <span className="dt-group-count-badge">{items.length}</span>
        <span className="dt-group-chevron">{open?'▲':'▼'}</span>
      </button>
      {open && (
        <div className="dt-strategy-grid">
          {items.map(s=><StrategyCard key={s.id} strategy={s} onUpdate={onUpdate} onScan={onScan} />)}
        </div>
      )}
    </div>
  );
}

function RuntimeSummary({ runtime }) {
  const summary = runtime?.summary || {};
  return (
    <div className="dt-runtime-summary">
      <div><strong>{summary.total_catalog_strategies ?? 0}</strong><span>Katalogstrategier</span></div>
      <div><strong>{summary.runtime_connected ?? 0}</strong><span>Connected</span></div>
      <div><strong>{summary.enabled_by_user ?? 0}</strong><span>Paper test På</span></div>
      <div><strong>{summary.runtime_active ?? 0}</strong><span>Active</span></div>
      <div><strong>{summary.runtime_partial ?? 0}</strong><span>Partial</span></div>
      <div><strong>{summary.runtime_no_entry_rule ?? 0}</strong><span>Saknar entry</span></div>
      <div><strong>{summary.runtime_disabled ?? 0}</strong><span>Av</span></div>
    </div>
  );
}

function StrategiesSection({ strategies, total, runtime, onUpdate, onScan }) {
  const [showAll, setShowAll] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [runtimeError, setRuntimeError] = useState(null);

  async function bulk(path) {
    setBulkBusy(true);
    setRuntimeError(null);
    try {
      const res = await fetch(path, { method: 'POST' }).then(r => r.json()).catch(() => null);
      if (res?.ok) onUpdate?.();
      else setRuntimeError(res?.error || 'Kunde inte uppdatera strategi-runtime. Försök igen.');
    } finally {
      setBulkBusy(false);
    }
  }

  const isEnabled = (s) => (s.enabled_by_user ?? s.config?.enabled_by_user ?? (s.config?.active !== false)) === true;
  const active    = strategies.filter(isEnabled);
  const paused    = strategies.filter(s => !isEnabled(s));
  const withTrades= active.filter(s=>(s.trades||0)>0).sort((a,b)=>(b.score??0)-(a.score??0));
  const noTrades  = active.filter(s=>(s.trades||0)===0);
  const best      = withTrades.slice(0,5);
  const promising = [...withTrades.slice(5),...noTrades.slice(0,4)];
  const needsData = noTrades.slice(4);

  return (
    <div className="dt-panel dt-strategies-panel">
      <div className="dt-panel-head">
        <h3 className="dt-panel-title">Strategikontroll</h3>
        <span className="dt-count-badge">{strategies.length} st</span>
      </div>
      <div className="dt-strategy-bulk-actions">
        <button type="button" className="dt-btn dt-btn-ok" disabled={bulkBusy} onClick={()=>bulk('/api/daytrading/runtime-strategies/enable-all')}>
          Slå på alla i paper test
        </button>
        <button type="button" className="dt-btn dt-btn-warn" disabled={bulkBusy} onClick={()=>bulk('/api/daytrading/runtime-strategies/disable-all')}>
          Pausa alla i paper test
        </button>
      </div>
      {runtimeError && <div className="dt-inline-error">{runtimeError}</div>}
      <RuntimeSummary runtime={runtime} />
      <div className="dt-strategy-explainer">
        <strong>Source of truth: Daytrading styr strategi-runtime och paper test.</strong>
        <span>Alla katalogstrategier är connected. Strategier utan entry-regel visas som på men kan inte skapa paper trades.</span>
        <div className="dt-strategy-explainer-badges">
          <span>Katalog</span>
          <span>Connected</span>
          <span>Paper test På/Av</span>
          <span>Runtime summary</span>
        </div>
      </div>

      <CollapsibleGroup label="★ Bäst just nu"        colorClass="dt-group-green"  items={best}      defaultOpen={true}  onUpdate={onUpdate} onScan={onScan} />
      <CollapsibleGroup label="◈ Lovande för testning" colorClass="dt-group-blue"   items={promising}  defaultOpen={false} onUpdate={onUpdate} onScan={onScan} />
      <CollapsibleGroup label="◷ Behöver mer data"     colorClass="dt-group-yellow" items={needsData}  defaultOpen={false} onUpdate={onUpdate} onScan={onScan} />
      <CollapsibleGroup label="⏸ Pausade"              colorClass="dt-group-gray"   items={paused}     defaultOpen={false} onUpdate={onUpdate} onScan={onScan} />

      {total > strategies.length && (
        <div className="dt-show-all-wrap">
          <button type="button" className="dt-btn dt-btn-sec" onClick={()=>setShowAll(v=>!v)}>
            {showAll ? '↑ Dölj' : `Visa alla ${total} strategier`}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── H) Kandidater & paper trades ────────────────────────────────────────────

function tradeRowColor(status) {
  const s = String(status||'').toLowerCase();
  if (s.includes('vinst')||s.includes('paper trade öppnad')) return 'dt-row-green';
  if (s.includes('förlust')) return 'dt-row-red';
  if (s.includes('timeout')) return 'dt-row-yellow';
  if (s.includes('blockerad')) return 'dt-row-gray';
  if (s.includes('pågående')) return 'dt-row-blue';
  return '';
}

function TradeModal({ trade, onClose }) {
  return (
    <div className="dt-modal-overlay" onClick={onClose}>
      <div className="dt-modal dt-modal-sm" onClick={e=>e.stopPropagation()}>
        <div className="dt-modal-head">
          <h3>Analys: {trade.symbol}</h3>
          <button type="button" className="dt-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="dt-analyze">
          {[
            ['Symbol',trade.symbol],['Strategi',trade.strategy],['Riktning',trade.direction],
            ['Rå signal',trade.raw_signal],['Katalogstrategi',trade.catalog_strategy],
            ['Mapping',trade.catalog_mapping_confidence],
            ['Status',trade.status],['Anledning',trade.reason],
            ['Entry',trade.entry!=null?trade.entry:null],
            ['Stop loss',trade.stop_loss!=null?`${trade.stop_loss}%`:null],
            ['Take profit',trade.take_profit!=null?`${trade.take_profit}R`:null],
            ['P/L',fmtPct(trade.pnl)],
          ].map(([lbl,val])=>val!=null?(
            <div key={lbl} className="dt-analyze-row"><span>{lbl}</span><span>{val}</span></div>
          ):null)}
          {trade.catalog_mapping_note && (
            <div className="dt-analyze-row"><span>Kommentar</span><span>{trade.catalog_mapping_note}</span></div>
          )}
          <div className="dt-analyze-row dt-analyze-safety">
            <span>Safety</span><span>🔒 Riktiga ordrar är blockerade · endast paper/test</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function LiveTradesSection({ liveTrades }) {
  const [selected, setSelected] = useState(null);
  const trades = liveTrades?.trades || [];
  const summary = liveTrades?.summary_48h || {};
  const stoppage = liveTrades?.stoppage_summary_48h || {};
  const source = liveTrades?.source_of_truth || {};
  return (
    <div className="dt-panel">
      <div className="dt-panel-head">
        <h3 className="dt-panel-title">Kandidater &amp; paper trades</h3>
        <span className="dt-count-badge">{trades.length} st</span>
      </div>
      <div className="dt-paper-note">Detta är test-/paper trades. Inga riktiga ordrar skickas.</div>
      <div className="dt-paper-summary">
        <div className="dt-paper-summary-head">Senaste 48h</div>
        <div className="dt-paper-summary-grid">
          <div><strong>{summary.total ?? 0}</strong><span>Totalt paper trades</span></div>
          <div><strong>{summary.vwap_reclaim_up ?? 0}</strong><span>VWAP_RECLAIM_UP</span></div>
          <div><strong>{summary.vwap_rejection_down ?? 0}</strong><span>VWAP_REJECTION_DOWN</span></div>
          <div><strong>{summary.other_strategies ?? 0}</strong><span>Övriga strategier</span></div>
        </div>
        <p>{summary.text_sv || 'TODO: Kunde inte läsa paper trading history. Kontrollera data/paper-trading/trades.jsonl.'}</p>
      </div>
      <div className="dt-paper-info-grid">
        <div className="dt-paper-info-box">
          <div className="dt-paper-info-title">Varför kördes inte andra strategier?</div>
          <p>{stoppage.text_sv || 'Strategier kan stoppas innan paper trade om signalen är för svag, marknaden inte passar, cooldown finns, eller strategin är pausad.'}</p>
          {stoppage.top_reasons?.length > 0 && (
            <ul>
              {stoppage.top_reasons.slice(0, 5).map((row) => (
                <li key={row.reason}><span>{row.reason}</span><strong>{row.count}</strong></li>
              ))}
            </ul>
          )}
        </div>
        <div className="dt-paper-info-box">
          <div className="dt-paper-info-title">Vad betyder siffrorna?</div>
          <ul>
            <li><span>{source.strategy_control || 'Strategikontroll = katalog + teststatistik + historik'}</span></li>
            <li><span>{source.candidates_paper || 'Kandidater & paper trades = faktiska paper trades från scanner'}</span></li>
            <li><span>{source.safety || 'Safety = live trading är avstängt'}</span></li>
          </ul>
        </div>
      </div>
      {!trades.length ? (
        <PlatformEmptyState title="Inga aktiva paper trades just nu" text="Kör ny scan för att leta efter kandidater." />
      ) : (
        <div className="dt-table-wrap">
          <table className="dt-table">
            <thead><tr><th>Tid</th><th>Symbol</th><th>Marknad</th><th>Rå signal</th><th>Katalogstrategi</th><th>Rikt.</th><th>P/L</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {trades.map((trade,i)=>(
                <tr key={trade.trade_id||i} className={tradeRowColor(trade.status)}>
                  <td className="dt-td-time">{trade.time?new Date(trade.time).toLocaleTimeString('sv-SE',{hour:'2-digit',minute:'2-digit'}):'–'}</td>
                  <td className="dt-td-sym"><strong>{trade.symbol}</strong></td>
                  <td>{trade.market||'–'}</td>
                  <td className="dt-td-raw">{trade.raw_signal||'–'}</td>
                  <td className="dt-td-strategy">
                    <div>{trade.catalog_strategy||'Ej kopplad'}</div>
                    {trade.strategy_id && <div className="dt-table-sub">{trade.strategy_id}</div>}
                    {trade.catalog_mapping_confidence === 'low' && <span className="dt-uncertain">låg säkerhet</span>}
                  </td>
                  <td>{trade.direction||'–'}</td>
                  <td className={trade.pnl>0?'dt-pos':trade.pnl<0?'dt-neg':''}>{fmtPct(trade.pnl)}</td>
                  <td><span className="dt-status-tag">{trade.status||'–'}</span></td>
                  <td><button type="button" className="dt-btn-xs" onClick={()=>setSelected(trade)}>Analysera</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && <TradeModal trade={selected} onClose={()=>setSelected(null)} />}
    </div>
  );
}

// ─── I) Impact ────────────────────────────────────────────────────────────────

function ImpactPanel({ impact, onScan }) {
  if (!impact?.ok||!impact?.generated_at) {
    return (
      <div className="dt-panel dt-impact-panel">
        <h3 className="dt-panel-title">Effekt av senaste ändring</h3>
        <PlatformEmptyState title="Ingen ändring analyserad ännu" text="Ändra ett filter eller en strategi och kör ny scan." />
      </div>
    );
  }
  const {before,after,changed_symbols,summary_sv,generated_at} = impact;
  return (
    <div className="dt-panel dt-impact-panel">
      <div className="dt-panel-head">
        <h3 className="dt-panel-title">Effekt av senaste ändring</h3>
        <span className="dt-muted">{timeSince(generated_at)}</span>
      </div>
      <p className="dt-impact-summary">{summary_sv}</p>
      <div className="dt-impact-cols">
        <div className="dt-impact-col">
          <div className="dt-impact-col-title">Före</div>
          <div className="dt-impact-stat"><span className="dt-impact-num">{before?.candidates??0}</span><span>kandidater</span></div>
          <div className="dt-impact-stat"><span className="dt-impact-num">{before?.signals??0}</span><span>signaler</span></div>
          <div className="dt-impact-stat"><span className="dt-impact-num">{before?.blocked??0}</span><span>blockerade</span></div>
        </div>
        <div className="dt-impact-arrow">→</div>
        <div className="dt-impact-col">
          <div className="dt-impact-col-title">Efter</div>
          <div className="dt-impact-stat"><span className="dt-impact-num">{after?.candidates??0}</span><span>kandidater</span></div>
          <div className="dt-impact-stat"><span className="dt-impact-num">{after?.signals??0}</span><span>signaler</span></div>
          <div className="dt-impact-stat"><span className="dt-impact-num">{after?.blocked??0}</span><span>blockerade</span></div>
        </div>
      </div>
      {changed_symbols?.length>0 && <div className="dt-impact-syms">Symboler: {changed_symbols.slice(0,10).join(', ')}</div>}
      <button type="button" className="dt-btn dt-btn-sec" onClick={onScan}>Kör ny scan</button>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const DEFAULT_FILTERS = { market:'all', direction:'all', minScore:0, symbol:'', _dirty:false };

export default function DaytradingPage() {
  const { status, strategies, pipeline, liveTrades, recommendation, impact, symbols, runtime, loading, error, refresh } = useDaytradingData();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);

  // Hide floating AI fab on this page — in-pipeline button provides same function
  useEffect(() => {
    const fab = document.querySelector('.ai-fab');
    if (!fab) return;
    const prev = fab.style.display;
    fab.style.display = 'none';
    return () => { fab.style.display = prev; };
  }, []);

  function handleFilterChange(next) {
    setFilters(next);
    fetch('/api/daytrading/filters', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({market:next.market, symbols:next.symbol?[next.symbol]:[]}),
    }).catch(()=>{});
  }

  async function handleScan(strategyId) {
    setScanning(true);
    try {
      const res = await fetch('/api/daytrading/scan', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          market: filters.market,
          symbols: filters.symbol?[filters.symbol]:[],
          ...(strategyId?{strategy_id:strategyId}:{}),
        }),
      }).then(r=>r.json());
      setScanResult(res);
      setFilters(f=>({...f, _dirty:false}));
      refresh();
    } catch {
      setScanResult({ok:false, message_sv:'Kunde inte nå backend. Kontrollera att servern är igång.'});
    } finally {
      setScanning(false);
    }
  }

  const allStrategies = strategies?.strategies || [];
  const visibleStrategies = allStrategies.filter(s => {
    const cfg = s.config || {};
    if (filters.market !== 'all') {
      const m = cfg.market || s.market || 'all';
      if (m !== 'all' && m !== filters.market) return false;
    }
    if (filters.direction !== 'all') {
      const d = cfg.direction || s.direction || 'both';
      if (d !== 'both' && d !== filters.direction) return false;
    }
    if (filters.minScore > 0 && Number(s.score??0) < filters.minScore) return false;
    return true;
  });

  if (loading) return <div className="dt-page"><div className="dt-loading">Laddar Daytrading Control Center...</div></div>;

  if (error && !status) {
    return (
      <div className="dt-page">
        <h1 className="dt-page-title">Daytrading Control Center</h1>
        <div className="dt-backend-down">
          <span>⚠️</span><strong>Backend svarar inte just nu.</strong>
          <span>Kontrollera att servern är igång och försök igen om en stund.</span>
          <button type="button" className="dt-btn dt-btn-pri" onClick={refresh}>Försök igen</button>
        </div>
      </div>
    );
  }

  return (
    <div className="dt-page">

      {/* A) Header */}
      <div className="dt-page-head">
        <div>
          <h1 className="dt-page-title">Daytrading Control Center</h1>
          <p className="dt-page-sub">Livekontroll för strategier, signaler, pipeline och paper trades.</p>
        </div>
        <button type="button" className="dt-btn dt-btn-sec" onClick={refresh}>Uppdatera</button>
      </div>

      {/* A) Status */}
      <StatusBar status={status} />

      {/* B) Safety */}
      <SafetyBanner status={status} />

      {/* Scan result */}
      {scanResult && (
        <div className={`dt-scan-result ${scanResult.ok?'dt-scan-ok':'dt-scan-err'}`}>
          <span>{scanResult.message_sv}</span>
          {scanResult.candidates?.length>0 && <span> · {scanResult.candidates.length} kandidater hittades</span>}
          <button type="button" className="dt-scan-close" onClick={()=>setScanResult(null)}>✕</button>
        </div>
      )}

      {/* C) Process just nu */}
      <ProcessCard status={status} pipeline={pipeline} />

      {/* D) Pipeline — fullbredd, prominent */}
      <PipelineSection pipeline={pipeline} />

      {/* E) Rekommendation */}
      <RecommendationBar rec={recommendation} />

      {/* F) Filter bar */}
      <FilterBar
        filters={filters}
        onChange={handleFilterChange}
        onScan={()=>handleScan()}
        scanning={scanning}
        symbols={symbols}
      />

      {/* G) Strategikontroll — collapsible groups */}
      {!visibleStrategies.length ? (
        <div className="dt-panel">
          <PlatformEmptyState title="Inga strategier matchar filter" text="Ändra filter för att se fler strategier." />
        </div>
      ) : (
        <StrategiesSection
          strategies={visibleStrategies}
          total={allStrategies.length}
          runtime={runtime}
          onUpdate={refresh}
          onScan={handleScan}
        />
      )}

      {/* H) Kandidater & paper trades */}
      <LiveTradesSection liveTrades={liveTrades} />

      {/* I) Effekt av senaste ändring */}
      <ImpactPanel impact={impact} onScan={()=>handleScan()} />

    </div>
  );
}
