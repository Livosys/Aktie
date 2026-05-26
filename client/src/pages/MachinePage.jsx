import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SectionHeader, SystemConclusionBox } from '../shared.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtDuration(startIso, endIso) {
  if (!startIso || !endIso) return '–';
  const ms = new Date(endIso) - new Date(startIso);
  if (ms < 0) return '–';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

function calcDurationMs(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso) - new Date(startIso);
  return ms >= 0 ? ms : null;
}

function sumCandlesSaved(backfillBySymbol) {
  if (!backfillBySymbol) return 0;
  return Object.values(backfillBySymbol).reduce((acc, v) => acc + (v.candles2m || 0), 0);
}

function countStepErrors(steps) {
  if (!steps) return 0;
  return Object.values(steps).filter(s => s && s.ok === false).length;
}

function countSymbolErrors(backfillBySymbol) {
  if (!backfillBySymbol) return 0;
  return Object.values(backfillBySymbol).filter(v => v.error).length;
}

// ── Swedish translations ──────────────────────────────────────────────────────

const BLOCKER_SV = {
  'Three Finger Spread':           'Priset är för utsträckt',
  'price extended':                'Priset är för långt från bra nivå',
  'low liquidity':                 'Svag volym',
  'choppy market':                 'Stökig marknad',
  'WIDE_AVOID state':              'Priset är för brett',
  'WIDE_AVOID':                    'Priset är för brett',
  'fakeout risk':                  'Fakeout-risk',
  'fakeout high':                  'Hög fakeout-risk',
  'DATA: missing price':           'Saknar priskurs',
  'DATA: stale >10m':              'Datan är gammal',
  'DATA: missing candles':         'Saknar historik-candles',
  'missing candles':               'Saknar historik-candles',
  'market state filter':           'Marknadsfilter aktivt',
  'Confidence Engine':             'Systemet stoppar signalen',
  'MTF conflict':                  'Tidsramarna säger emot',
  'MTF mixed':                     'Blandade tidsramssignaler',
  'breakout already occurred':     'Utbrottet skedde redan',
  'score lowered after initial pass': 'Poäng sänktes av lärande',
  'NO_TRADE state':                'Inget handelsläge',
  'NO_TRADE':                      'Inget handelsläge',
};

function svBlocker(key) {
  return BLOCKER_SV[key] || key;
}

const REGIME_SV = {
  BULLISH_TREND:   'Stark upptrend',
  BEARISH_TREND:   'Stark nedtrend',
  CHOPPY:          'Stökig marknad',
  RANGE_DAY:       'Sidledsdag',
  TREND_DAY_UP:    'Trenddag uppåt',
  TREND_DAY_DOWN:  'Trenddag nedåt',
  HIGH_VOLATILITY: 'Hög volatilitet',
  PANIC:           'Panik',
  UNKNOWN:         'Okänt',
};

// ── Existing machine status hook ──────────────────────────────────────────────

function useMachineStatus(pollingActive) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const timerRef = useRef(null);

  const fetch_ = useCallback(async () => {
    try {
      const res  = await fetch('/api/system/auto-machine-status');
      const json = res.ok ? await res.json() : null;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetch_(); }, [fetch_]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (pollingActive || !!data?.running) {
      timerRef.current = setInterval(fetch_, 5000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [pollingActive, data, fetch_]);

  return { data, loading, error, refresh: fetch_ };
}

// ── New data hooks ────────────────────────────────────────────────────────────

function useSignalDecisions() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/debug/signal-decisions')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok) setData(d); })
      .catch(() => {});
  }, []);
  return data;
}

function useLearningSummary() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/history/learning-summary')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok && d.summary) setData(d.summary); })
      .catch(() => {});
  }, []);
  return data;
}

function useRuleMemoryData() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/history/rule-memory')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok && d.memory) setData(d.memory); })
      .catch(() => {});
  }, []);
  return data;
}

function useSymbolProfilesData() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/history/symbol-profiles')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok && d.profiles) setData(d.profiles); })
      .catch(() => {});
  }, []);
  return data;
}

function useRegimeProfilesData() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/history/regime-profiles')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok && d.profiles) setData(d.profiles); })
      .catch(() => {});
  }, []);
  return data;
}

function useScoreCalibrationData() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/history/score-calibration')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok && d.calibration) setData(d.calibration); })
      .catch(() => {});
  }, []);
  return data;
}

function useFakeoutDnaData() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/history/fakeout-dna')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok && d.dna) setData(d.dna); })
      .catch(() => {});
  }, []);
  return data;
}

function useRuleHealth() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/history/rule-health')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok && d.health) setData(d.health); })
      .catch(() => {});
  }, []);
  return data;
}

function useMomentumBacktest() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/history/momentum-backtest')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok && d.report) setData(d.report); })
      .catch(() => {});
  }, []);
  return data;
}

function useMarketPersonality() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/market/personality')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ok) setData(d); })
      .catch(() => {});
  }, []);
  return data;
}

const SG_COLORS = {
  COMPRESSION: '#818cf8', BREAKOUT: '#34d399', MOMENTUM: '#10b981',
  TREND: '#06b6d4',       EXHAUSTION: '#f97316', REVERSAL: '#ef4444',
  CHOPPY: '#6b7280',      UNKNOWN: '#374151',
};
const SG_LABELS = {
  COMPRESSION: 'Komprimering', BREAKOUT: 'Utbrott', MOMENTUM: 'Momentum',
  TREND: 'Trend', EXHAUSTION: 'Utmattning', REVERSAL: 'Vändning',
  CHOPPY: 'Choppig', UNKNOWN: 'Okänd',
};

function useStateGraphSummary() {
  const [stocks, setStocks] = useState(null);
  const [crypto, setCrypto] = useState(null);
  useEffect(() => {
    fetch('/api/scan/stocks')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.results) setStocks(d.results); })
      .catch(() => {});
    fetch('/api/scan/crypto')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.results) setCrypto(d.results); })
      .catch(() => {});
  }, []);
  return { stocks, crypto };
}

function useSchedulerStatus() {
  const [sched, setSched]   = useState(null);
  const [loading, setLoading] = useState(true);

  const fetch_ = useCallback(async () => {
    try {
      const res  = await fetch('/api/system/scheduler-status');
      const json = res.ok ? await res.json() : null;
      setSched(json);
    } catch (_) {
      setSched(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetch_(); }, [fetch_]);
  return { sched, loading, refresh: fetch_ };
}

// ── NEW: Systemets lärdomar just nu (top stat cards) ─────────────────────────

function LearningTopCards({ decisions, showTech }) {
  if (!decisions) {
    return <div className="lrn-empty">Hämtar signaldata…</div>;
  }

  const rows = decisions.signalDecisionSummary || [];
  const total = rows.length;

  if (!total) {
    return <div className="lrn-empty">Inga aktiva signaler hittades. Kontrollera att scanning är aktiv.</div>;
  }

  const ready       = rows.filter(r => r.status === 'READY');
  const watch       = rows.filter(r => r.status === 'WATCH');
  const dataWarn    = rows.filter(r => r.status === 'DATA_WARNING');
  const hardBlocked = rows.filter(r => r.status !== 'DATA_WARNING' && (r.readyGap?.hardBlockers?.length ?? 0) > 0);
  const softBlocked = rows.filter(r =>
    r.status === 'BLOCKED' && (r.readyGap?.hardBlockers?.length ?? 0) === 0
  );

  const reasonCount = {};
  for (const row of rows) {
    for (const rule of (row.failedRules || [])) {
      reasonCount[rule] = (reasonCount[rule] || 0) + 1;
    }
  }
  const topReason = Object.entries(reasonCount).sort((a, b) => b[1] - a[1])[0];

  const nearestReady = [...rows]
    .filter(r => r.status !== 'READY' && r.status !== 'DATA_WARNING' && (r.readyGap?.hardBlockers?.length ?? 0) === 0)
    .sort((a, b) => (a.readyGap?.closestToReadyRank ?? 999) - (b.readyGap?.closestToReadyRank ?? 999))[0];

  return (
    <div className="lrn-cards-grid">
      <div className="lrn-card">
        <div className="lrn-card-val">{total}</div>
        <div className="lrn-card-label">Analyserade signaler</div>
      </div>
      <div className="lrn-card">
        <div className="lrn-card-val" style={{ color: 'var(--green)' }}>{ready.length}</div>
        <div className="lrn-card-label">READY</div>
        {showTech && <div className="lrn-card-tech">score ≥ 60, inga blockerare</div>}
      </div>
      <div className="lrn-card">
        <div className="lrn-card-val" style={{ color: '#38bdf8' }}>{watch.length}</div>
        <div className="lrn-card-label">WATCH</div>
        {showTech && <div className="lrn-card-tech">score 20–59, bevaka</div>}
      </div>
      <div className="lrn-card">
        <div className="lrn-card-val" style={{ color: 'var(--red)' }}>{hardBlocked.length}</div>
        <div className="lrn-card-label">HARD BLOCKED</div>
        {showTech && <div className="lrn-card-tech">TFS / WIDE_AVOID / fakeout high</div>}
      </div>
      <div className="lrn-card">
        <div className="lrn-card-val" style={{ color: 'var(--orange)' }}>{softBlocked.length}</div>
        <div className="lrn-card-label">SOFT BLOCKED</div>
        {showTech && <div className="lrn-card-tech">Confidence Engine / pris / volym</div>}
      </div>
      <div className="lrn-card">
        <div className="lrn-card-val" style={{ color: 'var(--muted)' }}>{dataWarn.length}</div>
        <div className="lrn-card-label">DATA WARNING</div>
        {showTech && <div className="lrn-card-tech">inget pris / gammal data</div>}
      </div>
      {topReason && (
        <div className="lrn-card lrn-card-wide">
          <div className="lrn-card-label-sm">Vanligaste stopporsak</div>
          <div className="lrn-card-text">
            {svBlocker(topReason[0])}
            <span className="lrn-card-count"> ({topReason[1]}x)</span>
          </div>
          {showTech && <div className="lrn-card-tech">{topReason[0]}</div>}
        </div>
      )}
      {nearestReady && (
        <div className="lrn-card lrn-card-wide lrn-card-nearest">
          <div className="lrn-card-label-sm">Symbol närmast READY</div>
          <div className="lrn-card-text">
            {nearestReady.symbol}
            {(nearestReady.readyGap?.missingScore ?? 0) > 0 && (
              <span className="lrn-card-count"> — saknar {nearestReady.readyGap.missingScore}p</span>
            )}
          </div>
          {showTech && <div className="lrn-card-tech">rank #{nearestReady.readyGap?.closestToReadyRank} · score {nearestReady.readyGap?.tradeScore}</div>}
        </div>
      )}
    </div>
  );
}

// ── NEW: Stop reasons chart (CSS bars) ────────────────────────────────────────

const STOP_GROUPS = [
  { keys: ['Three Finger Spread', 'WIDE_AVOID state', 'WIDE_AVOID'], label: 'Priset är för utsträckt', tech: 'Three Finger Spread / WIDE_AVOID', color: '#ef4444' },
  { keys: ['price extended'],                                          label: 'Priset är för långt från bra nivå', tech: 'priceToZoneAtr > 1.5', color: '#f97316' },
  { keys: ['low liquidity'],                                           label: 'Svag volym / låg likviditet', tech: 'relVol20 < 0.7', color: '#eab308' },
  { keys: ['choppy market', 'market state filter'],                    label: 'Stökig marknad', tech: 'CHOPPY / RANGE_DAY / HIGH_VOLATILITY', color: '#8b5cf6' },
  { keys: ['fakeout risk', 'fakeout high'],                            label: 'Fakeout-risk', tech: 'fakeoutRiskLevel=high / fakeoutProb≥70', color: '#ec4899' },
  { keys: ['Confidence Engine'],                                       label: 'Systemet stoppar signalen', tech: 'autoFilter.blocked', color: '#6366f1' },
  { keys: ['breakout already occurred'],                               label: 'Utbrottet skedde redan', tech: 'breakoutAlreadyOccurred', color: '#94a3b8' },
  { keys: ['MTF conflict', 'MTF mixed'],                               label: 'Tidsramskonflit', tech: 'mtfAlignment=conflicting', color: '#14b8a6' },
  { keys: ['DATA: missing price', 'DATA: stale >10m', 'DATA: missing candles', 'missing candles'], label: 'Datafel', tech: 'DATA_WARNING', color: '#6b7280' },
];

function StopReasonsChart({ decisions, showTech }) {
  const rows = decisions?.signalDecisionSummary || [];
  if (!rows.length) return <div className="sr-empty">Ingen data ännu.</div>;

  const counts = {};
  for (const row of rows) {
    for (const rule of (row.failedRules || [])) {
      counts[rule] = (counts[rule] || 0) + 1;
    }
  }

  const grouped = STOP_GROUPS.map(g => ({
    label: g.label,
    tech: g.tech,
    color: g.color,
    count: g.keys.reduce((s, k) => s + (counts[k] || 0), 0),
  })).filter(g => g.count > 0).sort((a, b) => b.count - a.count);

  const groupedKeys = new Set(STOP_GROUPS.flatMap(g => g.keys));
  const other = Object.entries(counts)
    .filter(([k]) => !groupedKeys.has(k))
    .reduce((s, [, v]) => s + v, 0);
  if (other > 0) grouped.push({ label: 'Annat', tech: 'other', color: '#94a3b8', count: other });

  if (!grouped.length) return <div className="sr-empty">Inga stopporsaker hittades — alla signaler är READY eller DATA_WARNING.</div>;

  const maxCount = Math.max(...grouped.map(g => g.count), 1);

  return (
    <div className="sr-chart">
      {grouped.map(g => (
        <div key={g.label} className="sr-row">
          <div className="sr-label">
            {g.label}
            {showTech && <span className="sr-tech"> ({g.tech})</span>}
          </div>
          <div className="sr-bar-wrap">
            <div className="sr-bar" style={{ width: `${(g.count / maxCount) * 100}%`, background: g.color }} />
          </div>
          <div className="sr-count">{g.count}</div>
        </div>
      ))}
    </div>
  );
}

// ── NEW: Block type explainer ─────────────────────────────────────────────────

function BlockTypeExplainer({ showTech }) {
  return (
    <div className="bt-explainer">
      <div className="bt-card bt-hard">
        <div className="bt-icon">🚫</div>
        <div className="bt-content">
          <div className="bt-title">Hard block — ska inte jagas</div>
          <div className="bt-desc">Signalen har ett farligt stopp: priset är för utsträckt, hög risk för falsk rörelse, eller utbrottet skedde redan.</div>
          {showTech && <div className="bt-tech">Three Finger Spread · WIDE_AVOID · fakeoutRiskLevel=high · breakoutAlreadyOccurred</div>}
        </div>
      </div>
      <div className="bt-card bt-soft">
        <div className="bt-icon">👀</div>
        <div className="bt-content">
          <div className="bt-title">Soft block — intressant men inte redo</div>
          <div className="bt-desc">Signalen är lovande men hindras av: låg volym, priset är lite för långt, stökig marknad, eller systemets interna bedömning.</div>
          <div className="bt-desc" style={{ marginTop: 4, color: 'var(--muted)' }}>Det betyder att systemet hellre väntar än jagar en osäker rörelse.</div>
          {showTech && <div className="bt-tech">relVol20 &lt; 0.7 · priceToZoneAtr &gt; 1.5 · CHOPPY · Confidence Engine</div>}
        </div>
      </div>
      <div className="bt-card bt-data">
        <div className="bt-icon">⚠️</div>
        <div className="bt-content">
          <div className="bt-title">Data warning — tekniskt/data-problem</div>
          <div className="bt-desc">Signalen saknar aktuell data: inget pris, gammal data, eller för få candles. Inte ett tradingbeslut.</div>
          {showTech && <div className="bt-tech">!price · stale &gt;10m · candleCount &lt; 40</div>}
        </div>
      </div>
    </div>
  );
}

// ── NEW: Närmast READY list ───────────────────────────────────────────────────

function NearestReadyList({ decisions, showTech }) {
  const rows = (decisions?.signalDecisionSummary || [])
    .filter(r => r.status !== 'READY' && r.status !== 'DATA_WARNING')
    .sort((a, b) => (a.readyGap?.closestToReadyRank ?? 999) - (b.readyGap?.closestToReadyRank ?? 999))
    .slice(0, 8);

  if (!rows.length) {
    return <div className="nr-empty">Mer historik behövs — kör Auto Motor.</div>;
  }

  return (
    <div className="nr-list">
      {rows.map((row, idx) => {
        const rg = row.readyGap || {};
        const isHard    = (rg.hardBlockers?.length ?? 0) > 0;
        const isSoft    = !isHard && (rg.softBlockers?.length ?? 0) > 0;
        const missing   = rg.missingScore ?? 0;
        const topHard   = (rg.hardBlockers || []).slice(0, 2);
        const topSoft   = (rg.softBlockers || []).slice(0, 2);

        return (
          <div key={row.symbol} className={`nr-row ${isHard ? 'nr-hard' : isSoft ? 'nr-soft' : 'nr-ok'}`}>
            <div className="nr-rank">#{idx + 1}</div>
            <div className="nr-sym">
              <span className="nr-sym-name">{row.symbol}</span>
              <span className="nr-market">{row.market === 'crypto' ? '₿ krypto' : '📈 aktie'}</span>
            </div>
            <div className="nr-score-col">
              <span className={`nr-score-val${(rg.tradeScore ?? 0) >= 50 ? ' nr-score-high' : ''}`}>
                {rg.tradeScore ?? '–'}p
              </span>
              {missing > 0 && (
                <span className="nr-missing">saknar {missing}p till READY</span>
              )}
              {showTech && <span className="nr-tech-sm">readyGap rank {rg.closestToReadyRank}</span>}
            </div>
            <div className="nr-blockers-col">
              {isHard ? (
                <div className="nr-blockers">
                  {topHard.map((b, i) => (
                    <span key={i} className="nr-tag nr-tag-hard">{svBlocker(b)}</span>
                  ))}
                  {showTech && topHard.map((b, i) => (
                    <span key={`t${i}`} className="nr-tag-tech">{b}</span>
                  ))}
                </div>
              ) : isSoft ? (
                <div className="nr-blockers">
                  {topSoft.map((b, i) => (
                    <span key={i} className="nr-tag nr-tag-soft">{svBlocker(b)}</span>
                  ))}
                  {showTech && topSoft.map((b, i) => (
                    <span key={`t${i}`} className="nr-tag-tech">{b}</span>
                  ))}
                </div>
              ) : (
                <span className="nr-label-sv">{rg.label || 'Behöver mer poäng'}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── NEW: Vad systemet har lärt sig ────────────────────────────────────────────

function SystemInsightsSection({ summary, ruleHealth }) {
  const insights = [];

  if (summary?.insightsSv?.length) {
    insights.push(...summary.insightsSv.slice(0, 5));
  }

  if (ruleHealth) {
    const { globalWinRate, degradingCount, improvingCount, totalRules, recentWindowDays } = ruleHealth;
    if (degradingCount > 0) {
      insights.push(`${degradingCount} av ${totalRules} regler presterar sämre de senaste ${recentWindowDays} dagarna — systemet bevakar.`);
    }
    if (improvingCount > 0 && !insights.some(i => i.includes('förbättr'))) {
      insights.push(`${improvingCount} regler förbättras — systemet anpassar sig till nuvarande marknadsläge.`);
    }
    if (globalWinRate != null && !insights.some(i => i.includes('träffsäkerhet'))) {
      const wrPct = Math.round(globalWinRate * 100);
      if (wrPct >= 55) {
        insights.push(`Systemets träffsäkerhet är ${wrPct}% — bra prestanda just nu.`);
      } else if (wrPct < 48) {
        insights.push(`Träffsäkerhet ${wrPct}% — mer historik behövs för tillförlitliga slutsatser.`);
      }
    }
  }

  if (summary?.overallWinRate != null && !insights.some(i => i.includes('träffsäkerhet') || i.includes('%'))) {
    const wrPct = Math.round(summary.overallWinRate * 100);
    insights.push(`${wrPct}% av historiska signaler gick i rätt riktning.`);
  }

  if (summary?.commonFailureReasons?.length) {
    const top = summary.commonFailureReasons[0];
    if (top?.labelSv && !insights.some(i => i.includes(top.labelSv))) {
      insights.push(`Vanligaste orsak till missad signal: "${top.labelSv}".`);
    }
  }

  if (summary?.bestSymbols?.length) {
    const best = summary.bestSymbols[0];
    if (best?.key && best?.winRate != null) {
      const pct = Math.round(best.winRate * 100);
      if (!insights.some(i => i.includes(best.key))) {
        insights.push(`${best.key} fungerar bäst historiskt (${pct}% träffsäkerhet).`);
      }
    }
  }

  if (summary?.bestMarketRegimes?.length) {
    const bestR = summary.bestMarketRegimes[0];
    const key = bestR?.key || bestR;
    if (key && !insights.some(i => i.includes('marknadsläge'))) {
      const label = REGIME_SV[key] || key;
      insights.push(`Bästa marknadsläge för signaler: ${label}.`);
    }
  }

  if (!insights.length) {
    return (
      <div className="si-empty">
        <div className="si-empty-icon">🌱</div>
        <div className="si-empty-text">
          Mer historik behövs — kör Auto Motor för att bygga lärdomar.<br />
          <span className="si-empty-sub">Systemet lär sig med varje körning.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="si-insights">
      {insights.map((text, i) => (
        <div key={i} className="si-insight">
          <span className="si-bullet">→</span>
          <span>{text}</span>
        </div>
      ))}
    </div>
  );
}

// ── NEW: Minnesbanken — standalone panels ─────────────────────────────────────

function RuleMemoryBankPanel({ memory }) {
  if (!memory) return <div className="mb-empty">Mer historik behövs — kör Auto Motor.</div>;
  const rules = (memory.rules || []).slice(0, 8);
  if (!rules.length) return <div className="mb-empty">Inga regler i minnet ännu.</div>;

  return (
    <div className="mb-rule-list">
      <div className="mb-meta">
        {memory.totalRules ?? rules.length} regler inlärda · {memory.watchModeRules ?? 0} bevakningsregler
        {memory.builtAt && <span className="mb-meta-date"> · {new Date(memory.builtAt).toLocaleDateString('sv-SE')}</span>}
      </div>
      {rules.map((rule, i) => {
        const confColor = rule.confidence === 'high' ? 'var(--green)'
                        : rule.confidence === 'medium' ? 'var(--orange)' : 'var(--muted)';
        const confLabel = rule.confidence === 'high' ? 'Hög' : rule.confidence === 'medium' ? 'Medel' : 'Låg';
        return (
          <div key={i} className="mb-rule-row">
            <div className="mb-rule-reason">"{rule.primaryReason}"</div>
            <div className="mb-rule-stats">
              <span>{rule.missedMoveCount}/{rule.count ?? rule.totalCount} fortsatte starkt</span>
              <span className="mb-sep">·</span>
              <span>snitt styrka {rule.avgContinuation}</span>
              <span className="mb-sep">·</span>
              <span style={{ color: confColor }}>{confLabel} historik</span>
              {rule.watchModeRecommended && (
                <span className="mb-watch-tag">BEVAKA</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SymbolProfilesBankPanel({ profiles }) {
  if (!profiles) return <div className="mb-empty">Mer historik behövs — kör Auto Motor.</div>;

  const symbols = Object.entries(profiles.symbols || {})
    .map(([sym, p]) => ({ sym, ...p }))
    .filter(s => (s.samples ?? s.signalCount ?? 0) >= 5)
    .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))
    .slice(0, 10);

  if (!symbols.length) return <div className="mb-empty">Inga symbolprofiler med tillräcklig historik ännu.</div>;

  const globalWR = profiles.globalWinRate != null ? `${(profiles.globalWinRate * 100).toFixed(1)}%` : '–';

  return (
    <div className="mb-sym-wrap">
      <div className="mb-meta">Global träffsäkerhet: {globalWR} · {Object.keys(profiles.symbols || {}).length} symboler spårade</div>
      <div className="mb-sym-table">
        <div className="mb-sym-header">
          <span>Symbol</span>
          <span>Träffsäkerhet</span>
          <span>Fakeout</span>
          <span>Justering</span>
          <span>Karaktär</span>
        </div>
        {symbols.map(({ sym, winRate, fakeoutRate, scoreAdjustment, personalitySv, confidence }) => {
          const adjColor = (scoreAdjustment ?? 0) > 0 ? 'var(--green)' : (scoreAdjustment ?? 0) < 0 ? 'var(--red)' : 'var(--muted)';
          const wrColor  = winRate != null && winRate >= 0.55 ? 'var(--green)' : winRate != null && winRate < 0.45 ? 'var(--red)' : 'var(--text)';
          return (
            <div key={sym} className="mb-sym-row">
              <span className="mb-sym-name">{sym}</span>
              <span style={{ color: wrColor }}>{winRate != null ? `${(winRate * 100).toFixed(1)}%` : '–'}</span>
              <span>{fakeoutRate != null ? `${(fakeoutRate * 100).toFixed(0)}%` : '–'}</span>
              <span style={{ color: adjColor }}>{(scoreAdjustment ?? 0) > 0 ? '+' : ''}{scoreAdjustment ?? '0'}p</span>
              <span className="mb-sym-personality">{personalitySv || '–'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RegimeProfilesBankPanel({ profiles }) {
  if (!profiles) return <div className="mb-empty">Mer historik behövs — kör Auto Motor.</div>;

  const regimes = Object.entries(profiles.regimes || {})
    .map(([key, p]) => ({ key, ...p }))
    .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0));

  if (!regimes.length) return <div className="mb-empty">Inga marknadsprofiler ännu.</div>;

  const globalWR = profiles.globalWinRate != null ? `${(profiles.globalWinRate * 100).toFixed(1)}%` : '–';

  return (
    <div className="mb-regime-wrap">
      <div className="mb-meta">Global träffsäkerhet: {globalWR}</div>
      <div className="mb-regime-list">
        {regimes.map(({ key, winRate, samples, scoreAdjustment, descSv, insightSv }) => {
          const label    = REGIME_SV[key] || descSv || key;
          const adjColor = (scoreAdjustment ?? 0) > 0 ? 'var(--green)' : (scoreAdjustment ?? 0) < 0 ? 'var(--red)' : 'var(--muted)';
          const wrColor  = winRate != null && winRate >= 0.55 ? 'var(--green)' : winRate != null && winRate < 0.45 ? 'var(--red)' : 'var(--text)';
          return (
            <div key={key} className="mb-regime-row">
              <div className="mb-regime-left">
                <span className="mb-regime-name">{label}</span>
                {insightSv && <span className="mb-regime-insight">{insightSv}</span>}
              </div>
              <div className="mb-regime-right">
                <span style={{ color: wrColor }}>{winRate != null ? `${(winRate * 100).toFixed(1)}%` : '–'}</span>
                <span className="mb-sep">·</span>
                <span className="mb-muted">{samples ?? '–'} signaler</span>
                {(scoreAdjustment ?? 0) !== 0 && (
                  <span style={{ color: adjColor, marginLeft: 4 }}>
                    {(scoreAdjustment ?? 0) > 0 ? '+' : ''}{scoreAdjustment}p
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScoreCalibrationBankPanel({ calibration }) {
  if (!calibration) return <div className="mb-empty">Mer historik behövs — kör Auto Motor.</div>;

  // calibration.byScoreRange is the main bucket source
  const rawBuckets = calibration.byScoreRange || calibration.buckets || calibration.scoreGroups || {};
  const buckets = Object.entries(rawBuckets)
    .map(([key, b]) => ({ key, ...b }))
    .sort((a, b) => {
      const an = parseFloat(a.key);
      const bn = parseFloat(b.key);
      return isNaN(an) || isNaN(bn) ? (b.samples ?? b.sampleCount ?? b.count ?? 0) - (a.samples ?? a.sampleCount ?? a.count ?? 0) : bn - an;
    })
    .slice(0, 8);

  const total = calibration.totalDirectedSignals ?? calibration.totalDirected ?? calibration.totalSignals ?? 0;

  return (
    <div className="mb-scal-wrap">
      <div className="mb-meta">
        {total.toLocaleString('sv')} signaler kalibrerade · global träffsäkerhet: {calibration.globalWinRate != null ? `${(calibration.globalWinRate * 100).toFixed(1)}%` : '–'}
        {calibration.updatedAt && <span className="mb-meta-date"> · {new Date(calibration.updatedAt).toLocaleDateString('sv-SE')}</span>}
      </div>
      {buckets.length > 0 ? (
        <div className="mb-scal-table">
          <div className="mb-scal-header">
            <span>Poänggrupp</span>
            <span>Träffsäkerhet</span>
            <span>Antal signaler</span>
          </div>
          {buckets.map(({ key, winRate, samples, count, sampleCount }) => {
            const n  = samples ?? sampleCount ?? count ?? 0;
            const wr = winRate ?? 0;
            const wrColor = wr >= 0.55 ? 'var(--green)' : wr >= 0.45 ? 'var(--yellow)' : 'var(--red)';
            return (
              <div key={key} className="mb-scal-row">
                <span className="mb-scal-key">{key}</span>
                <span style={{ color: wrColor }}>{(wr * 100).toFixed(1)}%</span>
                <span className="mb-muted">{n.toLocaleString('sv')}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mb-empty-sub">Detaljerade poänggrupper byggs vid nästa Auto Motor-körning.</div>
      )}
    </div>
  );
}

function FakeoutDnaBankPanel({ dna }) {
  if (!dna) return <div className="mb-empty">Mer historik behövs — kör Auto Motor.</div>;

  const globalFR  = dna.globalFakeoutRate ?? null;
  const features  = (dna.features || [])
    .filter(f => (f.elevation ?? 0) > 0.02)
    .sort((a, b) => (b.elevation ?? 0) - (a.elevation ?? 0))
    .slice(0, 6);

  return (
    <div className="mb-dna-wrap">
      <div className="mb-meta">
        {globalFR != null && (
          <>Global fakeout-rate: <strong>{(globalFR * 100).toFixed(1)}%</strong></>
        )}
        {dna.totalDirected != null && (
          <span className="mb-meta-date"> · {dna.totalDirected.toLocaleString('sv')} signaler analyserade</span>
        )}
      </div>
      {features.length > 0 ? (
        <div className="mb-dna-features">
          <div className="mb-meta mb-meta-sub">Faktorer som ökar fakeout-risken:</div>
          {features.map((f, i) => {
            const fakeoutPct = f.fakeoutRate != null ? `${(f.fakeoutRate * 100).toFixed(1)}%` : '–';
            const elevPct    = f.elevation != null ? `+${(f.elevation * 100).toFixed(1)}%` : '';
            return (
              <div key={i} className="mb-dna-row">
                <span className="mb-dna-key">{f.feature && f.value ? `${f.feature}: ${f.value}` : (f.key || f.feature || `Faktor ${i + 1}`)}</span>
                <span className="mb-dna-rate">{fakeoutPct} fakeout</span>
                <span className="mb-dna-el" style={{ color: '#ef4444' }}>{elevPct} förhöjt</span>
                <span className="mb-muted">{(f.total ?? 0)} signaler</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mb-empty-sub">Inga signifikanta riskfaktorer identifierade ännu.</div>
      )}
    </div>
  );
}

function MemoryBankSection({ ruleMemory, symbolProfiles, regimeProfiles, scoreCalibration, fakeoutDna }) {
  const [openKey, setOpenKey] = useState(null);

  const SECTIONS = [
    {
      key: 'rules',
      title: 'Regelminne',
      icon: '🎓',
      desc: 'Blockerade signaler som fortsatte starkt',
      count: ruleMemory?.totalRules ?? null,
      component: <RuleMemoryBankPanel memory={ruleMemory} />,
    },
    {
      key: 'symbols',
      title: 'Symbolminne',
      icon: '👤',
      desc: 'Varje symbols historiska beteende och träffsäkerhet',
      count: symbolProfiles ? Object.keys(symbolProfiles.symbols || {}).length : null,
      component: <SymbolProfilesBankPanel profiles={symbolProfiles} />,
    },
    {
      key: 'regimes',
      title: 'Marknadsminne',
      icon: '🌐',
      desc: 'Hur signaler fungerar i olika marknadslägen',
      count: regimeProfiles ? Object.keys(regimeProfiles.regimes || {}).length : null,
      component: <RegimeProfilesBankPanel profiles={regimeProfiles} />,
    },
    {
      key: 'score',
      title: 'Score-minne',
      icon: '🎯',
      desc: 'Historisk träffsäkerhet per poänggrupp',
      count: scoreCalibration ? ((scoreCalibration.totalDirected ?? scoreCalibration.totalSignals) ?? null) : null,
      component: <ScoreCalibrationBankPanel calibration={scoreCalibration} />,
    },
    {
      key: 'fakeout',
      title: 'Fakeout-minne',
      icon: '🧬',
      desc: 'Mönster som ökar risken för falska rörelser',
      count: dna => dna?.features?.length ?? null,
      component: <FakeoutDnaBankPanel dna={fakeoutDna} />,
    },
  ];

  const realSections = SECTIONS.map(s => ({
    ...s,
    count: typeof s.count === 'function' ? s.count(fakeoutDna) : s.count,
  }));

  return (
    <div className="mb-bank">
      {realSections.map(sec => (
        <div key={sec.key} className="mb-bank-section">
          <button
            className={`mb-bank-header${openKey === sec.key ? ' mb-bank-open' : ''}`}
            onClick={() => setOpenKey(openKey === sec.key ? null : sec.key)}
          >
            <span className="mb-bank-icon">{sec.icon}</span>
            <div className="mb-bank-header-text">
              <span className="mb-bank-title">{sec.title}</span>
              <span className="mb-bank-desc">{sec.desc}</span>
            </div>
            {sec.count != null && <span className="mb-bank-badge">{sec.count.toLocaleString('sv')}</span>}
            <span className="mb-bank-chevron">{openKey === sec.key ? '▲' : '▼'}</span>
          </button>
          {openKey === sec.key && (
            <div className="mb-bank-body">{sec.component}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Pipeline step definitions ─────────────────────────────────────────────────

const PIPELINE_STEPS = [
  { key: 'backfill',              icon: '📥', label: 'Fyll historik',      desc: 'Hämtar historiska candles via Alpaca och Binance' },
  { key: 'replay',                icon: '▶️', label: 'Testa historik',     desc: 'Spelar upp candles genom hela signalflödet' },
  { key: 'huntSignals',           icon: '🎯', label: 'Hitta signaler',     desc: 'Hittar och sparar intressanta signaler' },
  { key: 'analyzeOutcomes',       icon: '📊', label: 'Analysera resultat', desc: 'Analyserar vad som hände efter varje signal' },
  { key: 'updateLearning',        icon: '🧠', label: 'Uppdatera lärande',  desc: 'Uppdaterar lärande med ny statistik' },
  { key: 'analyzeMomentumIntelligence', icon: '📈', label: 'Fartanalys', desc: 'Historiskt testar fart, falska rörelser och stopjakt' },
  { key: 'buildRuleMemory',       icon: '🎓', label: 'Regelminne',         desc: 'Bygger regelminne för blockerade signaler som fortsatte starkt' },
  { key: 'buildSymbolProfiles',   icon: '👤', label: 'Symbolprofiler',     desc: 'Bygger beteendeprofiler per symbol' },
  { key: 'buildRegimeProfiles',   icon: '🌐', label: 'Marknadsprofiler',   desc: 'Bygger profiler per marknadsläge' },
  { key: 'buildScoreCalibration', icon: '🎯', label: 'Poängjustering',     desc: 'Justerar poänggrupper mot historiska resultat' },
  { key: 'buildFakeoutDna',       icon: '🧬', label: 'Falsk rörelse-DNA',  desc: 'Lär sig mönster för falska rörelser från historiska resultat' },
  { key: 'buildRuleHealth',       icon: '💊', label: 'Regelhälsa',         desc: 'Spårar när regler och signaltyper blir sämre' },
  { key: 'invalidateCaches',      icon: '⚡', label: 'Uppdatera cache',    desc: 'Rensar historik- och anpassningscache' },
];

function stepStatus(stepKey, steps, isRunning, currentStepIdx) {
  if (!steps) return 'idle';
  const stepIdx = PIPELINE_STEPS.findIndex(s => s.key === stepKey);
  if (steps[stepKey] === undefined) {
    if (isRunning && stepIdx >= currentStepIdx) return 'pending';
    return 'idle';
  }
  if (steps[stepKey]?.ok === false) return 'error';
  return 'ok';
}

function guessCurrentStep(steps) {
  if (!steps) return 0;
  let last = 0;
  PIPELINE_STEPS.forEach((s, i) => { if (steps[s.key] !== undefined) last = i + 1; });
  return last;
}

function StepBadge({ status }) {
  if (status === 'ok')      return <span className="mc-step-badge mc-step-ok">✓</span>;
  if (status === 'error')   return <span className="mc-step-badge mc-step-err">✗</span>;
  if (status === 'pending') return <span className="mc-step-badge mc-step-pending"><span className="spinner mc-spinner" /></span>;
  return <span className="mc-step-badge mc-step-idle">–</span>;
}

function StepDetail({ stepKey, steps }) {
  const s = steps?.[stepKey];
  if (!s) return null;
  if (stepKey === 'backfill' && s.bySymbol) {
    const total2m = sumCandlesSaved(s.bySymbol);
    const symErrs = countSymbolErrors(s.bySymbol);
    return (
      <span className="mc-step-detail">
        {total2m.toLocaleString('sv')} candles
        {symErrs > 0 && <span className="mc-step-detail-warn"> · {symErrs} symfel</span>}
      </span>
    );
  }
  if (stepKey === 'replay')      return <span className="mc-step-detail">{(s.totalEvents ?? 0).toLocaleString('sv')} events</span>;
  if (stepKey === 'huntSignals') return <span className="mc-step-detail">{(s.totalSignals ?? 0).toLocaleString('sv')} signaler</span>;
  if (stepKey === 'analyzeOutcomes') return <span className="mc-step-detail">{(s.processed ?? 0).toLocaleString('sv')} utfall</span>;
  if (stepKey === 'buildRuleMemory')       return <span className="mc-step-detail">{(s.totalRules ?? 0).toLocaleString('sv')} regler · {s.watchModeRules ?? 0} watch</span>;
  if (stepKey === 'buildSymbolProfiles')   return <span className="mc-step-detail">{s.totalSymbols ?? 0} symboler · {s.highConfSymbols ?? 0} hög konfidenz</span>;
  if (stepKey === 'buildRegimeProfiles')   return <span className="mc-step-detail">{s.totalRegimes ?? 0} regimer · bäst: {s.bestRegime ?? '–'}</span>;
  if (stepKey === 'buildScoreCalibration') return <span className="mc-step-detail">{(s.totalDirected ?? 0).toLocaleString('sv')} signals · {s.buckets ?? '–'}</span>;
  if (stepKey === 'analyzeMomentumIntelligence') return <span className="mc-step-detail">{(s.analyzed ?? 0).toLocaleString('sv')} samples · {s.verdict ?? '–'}</span>;
  if (stepKey === 'buildFakeoutDna')       return <span className="mc-step-detail">{s.features ?? 0} features · globalFR: {s.globalFakeoutRate ?? '–'}</span>;
  if (stepKey === 'buildRuleHealth')       return <span className="mc-step-detail">{s.totalRules ?? 0} regler · {s.degradingCount ?? 0} degradering</span>;
  if (s.error) return <span className="mc-step-detail mc-step-detail-err">{s.error}</span>;
  return null;
}

function PipelineSteps({ steps, isRunning }) {
  const currentIdx = isRunning ? guessCurrentStep(steps) : -1;
  return (
    <div className="mc-pipeline">
      {PIPELINE_STEPS.map((step, idx) => {
        const status   = stepStatus(step.key, steps, isRunning, currentIdx);
        const isActive = isRunning && status === 'pending' && idx === currentIdx;
        return (
          <div key={step.key} className={`mc-step${isActive ? ' mc-step-active' : ''}`}>
            <div className="mc-step-left">
              <span className="mc-step-icon">{step.icon}</span>
              <div className="mc-step-info">
                <span className="mc-step-label">{step.label}</span>
                <span className="mc-step-desc">{step.desc}</span>
              </div>
            </div>
            <div className="mc-step-right">
              <StepDetail stepKey={step.key} steps={steps} />
              <StepBadge status={status} />
            </div>
            {idx < PIPELINE_STEPS.length - 1 && (
              <div className={`mc-step-connector${status === 'ok' ? ' mc-connector-ok' : ''}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function StatCard({ icon, val, label, color }) {
  return (
    <div className="mc-stat-card">
      <div className="mc-stat-icon">{icon}</div>
      <div className="mc-stat-val" style={color ? { color } : {}}>{val ?? '–'}</div>
      <div className="mc-stat-label">{label}</div>
    </div>
  );
}

function ResultStats({ result }) {
  if (!result) return null;
  const steps      = result.steps || {};
  const candles    = sumCandlesSaved(steps.backfill?.bySymbol);
  const events     = steps.replay?.totalEvents ?? 0;
  const signals    = steps.huntSignals?.totalSignals ?? 0;
  const outcomes   = steps.analyzeOutcomes?.processed ?? 0;
  const stepErrors = countStepErrors(steps);
  const durationMs = calcDurationMs(result.startedAt, result.finishedAt);
  const durSec     = durationMs != null ? (durationMs / 1000).toFixed(1) : null;
  return (
    <div className="mc-stat-strip">
      <StatCard icon="🕯️" val={candles.toLocaleString('sv')} label="Candles sparade"    color="var(--blue)" />
      <StatCard icon="▶️" val={events.toLocaleString('sv')}   label="Replay events"      color="var(--green)" />
      <StatCard icon="🎯" val={signals.toLocaleString('sv')}  label="Signaler hittade"   color="var(--yellow)" />
      <StatCard icon="📊" val={outcomes.toLocaleString('sv')} label="Utfall analyserade" color="var(--purple)" />
      <StatCard icon="⏱️" val={durSec ? `${durSec} s` : '–'} label="Körtid" />
      <StatCard
        icon={stepErrors === 0 ? '✅' : '⚠️'}
        val={stepErrors === 0 ? 'OK' : stepErrors}
        label={stepErrors === 0 ? 'Inga fel' : 'Stegfel'}
        color={stepErrors === 0 ? 'var(--green)' : 'var(--orange)'}
      />
    </div>
  );
}

function RunForm({ isRunning, onTriggered }) {
  const [stocks,     setStocks]     = useState(true);
  const [crypto,     setCrypto]     = useState(true);
  const [lookback,   setLookback]   = useState(7);
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState(null);
  const [success,    setSuccess]    = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    const groups = [];
    if (stocks) groups.push('stocks');
    if (crypto) groups.push('crypto');
    if (!groups.length) { setError('Välj minst en grupp (Aktier eller Krypto).'); return; }
    setSubmitting(true);
    try {
      const res  = await fetch('/api/system/run-auto-machine', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ lookbackDays: lookback, groups }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Okänt serverfel');
      setSuccess(true);
      onTriggered();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const busy = isRunning || submitting;
  return (
    <div className="mc-run-form">
      <div className="mc-run-form-title">Kör maskinen manuellt</div>
      {isRunning && (
        <div className="mc-running-banner">
          <span className="spinner" style={{ width: 14, height: 14 }} />
          Maskinen kör redan. Vänta tills den är klar.
        </div>
      )}
      <form onSubmit={handleSubmit} className="mc-form-body">
        <div className="mc-form-row">
          <div className="mc-form-group">
            <span className="mc-form-label">Grupper</span>
            <div className="mc-checkboxes">
              <label className={`mc-checkbox${stocks ? ' mc-cb-active' : ''}`}>
                <input type="checkbox" checked={stocks} onChange={e => setStocks(e.target.checked)} disabled={busy} />
                <span>📈 Aktier</span>
                <span className="mc-cb-hint">NVDA AMD TSLA AAPL MSFT AMZN META QQQ</span>
              </label>
              <label className={`mc-checkbox${crypto ? ' mc-cb-active' : ''}`}>
                <input type="checkbox" checked={crypto} onChange={e => setCrypto(e.target.checked)} disabled={busy} />
                <span>₿ Krypto</span>
                <span className="mc-cb-hint">BTCUSDT ETHUSDT SOLUSDT</span>
              </label>
            </div>
          </div>
          <div className="mc-form-group">
            <span className="mc-form-label">Historik (dagar tillbaka)</span>
            <div className="mc-lookback-options">
              {[1, 3, 7, 30].map(d => (
                <button key={d} type="button" className={`mc-lb-btn${lookback === d ? ' mc-lb-active' : ''}`}
                  onClick={() => setLookback(d)} disabled={busy}>{d}d</button>
              ))}
            </div>
          </div>
        </div>
        <div className="mc-form-actions">
          <button className={`mc-run-btn${busy ? ' mc-run-btn-busy' : ''}`} type="submit" disabled={busy}>
            {submitting
              ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Startar…</>
              : isRunning
              ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Kör redan…</>
              : '🤖 Kör maskinen nu'}
          </button>
          {success && !isRunning && <span className="mc-form-ok">✓ Maskin startad — polling aktiv</span>}
        </div>
        {error && <div className="mc-form-error">✗ {error}</div>}
      </form>
    </div>
  );
}

function pct(v) { return v == null ? '–' : `${Math.round(v * 100)}%`; }

function MomentumBucketLine({ label, bucket }) {
  if (!bucket) return (
    <div className="mc-mb-line"><span>{label}</span><strong>–</strong></div>
  );
  return (
    <div className="mc-mb-line">
      <span>{label}</span>
      <strong>{bucket.label || bucket.key}</strong>
      <span>{(bucket.samples ?? 0).toLocaleString('sv')} samples</span>
      <span>{pct(bucket.winRate)} WR</span>
    </div>
  );
}

function MomentumBacktestPanel({ report }) {
  if (!report) return (
    <div className="mc-mb-empty">Kör Auto Motor för att bygga historiskt test för fartanalys.</div>
  );
  const sweep    = report.liquidity?.sweep_detected;
  const noSweep  = report.liquidity?.no_sweep;
  const sweepText = report.summary?.liquiditySweepsImprove == null
    ? 'För lite sweep-data'
    : report.summary.liquiditySweepsImprove
    ? `Ja (${pct(sweep?.winRate)} vs ${pct(noSweep?.winRate)})`
    : `Nej (${pct(sweep?.winRate)} vs ${pct(noSweep?.winRate)})`;
  return (
    <div className="mc-mb-panel">
      <div className="mc-mb-top">
        <div>
          <div className="mc-mb-title">Historiskt test av fartanalys</div>
          <div className="mc-mb-sub">
            {(report.source?.analyzed ?? 0).toLocaleString('sv')} analyserade signaler · total träffsäkerhet {pct(report.global?.winRate)}
          </div>
        </div>
        <div className={`mc-mb-verdict mc-mb-${(report.conclusion?.verdict || '').replace(/\s+/g, '-')}`}>
          {report.conclusion?.verdict || '–'}
        </div>
      </div>
      <div className="mc-mb-grid">
        <MomentumBucketLine label="Bästa fartgrupp"              bucket={report.summary?.bestMomentumBucket} />
        <MomentumBucketLine label="Sämsta grupp för falsk rörelse" bucket={report.summary?.worstFakeoutBucket} />
        <MomentumBucketLine label="Bästa kombination"            bucket={report.summary?.bestCombination} />
        <MomentumBucketLine label="Sämsta kombination"           bucket={report.summary?.worstCombination} />
      </div>
      <div className="mc-mb-sweep">
        <span>Förbättrar stopjakt resultaten?</span>
        <strong>{sweepText}</strong>
      </div>
      {report.conclusion?.conclusionSv && (
        <div className="mc-mb-conclusion">{report.conclusion.conclusionSv}</div>
      )}
    </div>
  );
}

const PERSONALITY_ICON = {
  panic_trend_day:          '🚨',
  fakeout_heavy_day:        '⚠️',
  choppy_trap_market:       '🌀',
  exhaustion_environment:   '😴',
  continuation_environment: '✅',
  momentum_heavy_day:       '🚀',
  trend_day:                '📈',
  compression_day:          '🗜️',
  balanced_market:          '⚖️',
  insufficient_data:        '📡',
};

function PersonalityMeter({ label, value, color }) {
  return (
    <div className="mc-pm-row">
      <span className="mc-pm-label">{label}</span>
      <div className="mc-pm-bar-wrap">
        <div className="mc-pm-bar" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="mc-pm-val">{value}</span>
    </div>
  );
}

function MarketPersonalityCard({ personality, group }) {
  if (!personality) return (
    <div className="mc-personality-card mc-personality-empty">
      <div className="mc-personality-icon">📡</div>
      <div className="mc-personality-label">{group === 'crypto' ? 'Krypto' : 'Aktier'}: väntar på scan…</div>
    </div>
  );
  const icon       = PERSONALITY_ICON[personality.personalityLabel] || '📊';
  const trustColor = personality.marketTrustScore >= 65 ? '#22c55e' : personality.marketTrustScore >= 40 ? '#eab308' : '#ef4444';
  return (
    <div className="mc-personality-card">
      <div className="mc-personality-header">
        <span className="mc-personality-icon">{icon}</span>
        <div>
          <div className="mc-personality-label">{group === 'crypto' ? 'Krypto' : 'Aktier'}</div>
          <div className="mc-personality-title">{personality.personalityLabel.replace(/_/g, ' ')}</div>
        </div>
        <div className="mc-personality-trust" style={{ color: trustColor }}>
          <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>{personality.marketTrustScore}</div>
          <div style={{ fontSize: '0.65rem', color: 'var(--muted)' }}>Tilltro</div>
        </div>
      </div>
      <div className="mc-personality-sv">{personality.personalitySv}</div>
      <div className="mc-personality-meters">
        <PersonalityMeter label="Fortsättning" value={personality.continuationProbability} color="#22c55e" />
        <PersonalityMeter label="Falsk rörelse" value={personality.fakeoutRisk}            color="#ef4444" />
        <PersonalityMeter label="Tryck"         value={personality.aggressionLevel}        color="#3b82f6" />
        <PersonalityMeter label="Utmattning"    value={personality.exhaustionLevel}        color="#f97316" />
      </div>
      <div className="mc-personality-meta">
        {personality.symbolCount} symbol{personality.symbolCount !== 1 ? 'er' : ''} · {personality.computedAt ? new Date(personality.computedAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '–'}
      </div>
    </div>
  );
}

function RuleHealthPanel({ health }) {
  if (!health) return (
    <div className="mc-rule-health-empty">Kör Auto Motor för att bygga Rule Health rapport.</div>
  );
  const { totalRules, degradingCount, improvingCount, stableCount, globalWinRate, recentWindowDays, rules } = health;
  const degradingRules = (rules || []).filter(r => r.status === 'degrading').slice(0, 8);
  const improvingRules = (rules || []).filter(r => r.status === 'improving').slice(0, 4);
  return (
    <div className="mc-rule-health">
      <div className="mc-rh-stats">
        <div className="mc-rh-stat"><span className="mc-rh-stat-val">{totalRules ?? 0}</span><span className="mc-rh-stat-label">Regler totalt</span></div>
        <div className="mc-rh-stat" style={{ color: degradingCount > 0 ? '#ef4444' : 'var(--text)' }}><span className="mc-rh-stat-val">{degradingCount ?? 0}</span><span className="mc-rh-stat-label">Degraderar</span></div>
        <div className="mc-rh-stat" style={{ color: improvingCount > 0 ? '#22c55e' : 'var(--text)' }}><span className="mc-rh-stat-val">{improvingCount ?? 0}</span><span className="mc-rh-stat-label">Förbättrar</span></div>
        <div className="mc-rh-stat"><span className="mc-rh-stat-val">{stableCount ?? 0}</span><span className="mc-rh-stat-label">Stabila</span></div>
        <div className="mc-rh-stat"><span className="mc-rh-stat-val">{Math.round((globalWinRate ?? 0.5) * 100)}%</span><span className="mc-rh-stat-label">Global WR</span></div>
        <div className="mc-rh-stat"><span className="mc-rh-stat-val">{recentWindowDays}d</span><span className="mc-rh-stat-label">Fönster</span></div>
      </div>
      {degradingRules.length > 0 && (
        <div className="mc-rh-section">
          <div className="mc-rh-section-title" style={{ color: '#ef4444' }}>⬇ Degraderar ({recentWindowDays}d vs historik)</div>
          {degradingRules.map(r => (
            <div key={r.ruleKey} className="mc-rh-rule mc-rh-degrading">
              <span className="mc-rh-rule-label">{r.label}</span>
              <span className="mc-rh-rule-rates">
                <span style={{ color: '#ef4444' }}>{Math.round(r.recentWinRate * 100)}%</span>
                <span className="mc-rh-rule-arrow">← </span>
                <span>{Math.round(r.historicalWinRate * 100)}%</span>
              </span>
              <span className="mc-rh-rule-drift" style={{ color: '#ef4444' }}>{Math.round(r.drift * 100)}%</span>
            </div>
          ))}
        </div>
      )}
      {improvingRules.length > 0 && (
        <div className="mc-rh-section">
          <div className="mc-rh-section-title" style={{ color: '#22c55e' }}>⬆ Förbättrar</div>
          {improvingRules.map(r => (
            <div key={r.ruleKey} className="mc-rh-rule mc-rh-improving">
              <span className="mc-rh-rule-label">{r.label}</span>
              <span className="mc-rh-rule-rates">
                <span style={{ color: '#22c55e' }}>{Math.round(r.recentWinRate * 100)}%</span>
                <span className="mc-rh-rule-arrow">← </span>
                <span>{Math.round(r.historicalWinRate * 100)}%</span>
              </span>
              <span className="mc-rh-rule-drift" style={{ color: '#22c55e' }}>+{Math.round(r.drift * 100)}%</span>
            </div>
          ))}
        </div>
      )}
      {degradingCount === 0 && improvingCount === 0 && (
        <div className="mc-rh-all-stable">
          ✓ Alla regler är stabila — inga signifikanta driftar detekterade inom {recentWindowDays} dagar.
          {totalRules > 0 && <span style={{ color: 'var(--muted)', display: 'block', marginTop: 4, fontSize: '0.75rem' }}>
            OBS: Driftar syns tydligare med mer historisk data (&gt;30 dagar).
          </span>}
        </div>
      )}
    </div>
  );
}

function fmtTimeShort(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

function SchedulerPanel({ sched }) {
  if (!sched) return null;
  const active  = sched.schedulerActive;
  const enabled = sched.enabled;
  return (
    <div className="mc-sched-panel">
      <div className="mc-sched-header">
        <span className="mc-sched-title">⏰ Scheduler</span>
        <span className={`mc-sched-pill ${active ? 'mc-sched-on' : 'mc-sched-off'}`}>
          {active ? '● Aktiv' : '○ Avstängd'}
        </span>
      </div>
      {!enabled && (
        <div className="mc-sched-warn">
          ⚠ Scheduler är avstängd — sätt <code>AUTO_MACHINE_ENABLED=true</code> i .env för att aktivera automatiska körningar.
        </div>
      )}
      {enabled && active && (
        <div className="mc-sched-ok">✓ Scheduler är aktiv och kör automatiskt var {sched.intervalMinutes} min.</div>
      )}
      <div className="mc-sched-grid">
        <div className="mc-sched-item"><span className="mc-sched-item-label">Interval</span><span className="mc-sched-item-val">{sched.intervalMinutes} min</span></div>
        <div className="mc-sched-item"><span className="mc-sched-item-label">Lookback</span><span className="mc-sched-item-val">{sched.lookbackDays} dagar</span></div>
        <div className="mc-sched-item"><span className="mc-sched-item-label">Grupper</span><span className="mc-sched-item-val">{(sched.groups || []).join(', ') || '–'}</span></div>
        <div className="mc-sched-item">
          <span className="mc-sched-item-label">Nästa körning</span>
          <span className="mc-sched-item-val">{active && sched.nextRunEstimate ? fmtTimeShort(sched.nextRunEstimate) : '–'}</span>
        </div>
        <div className="mc-sched-item">
          <span className="mc-sched-item-label">Pipeline kör nu</span>
          <span className="mc-sched-item-val" style={{ color: sched.running ? 'var(--yellow)' : 'var(--muted)' }}>{sched.running ? 'Ja' : 'Nej'}</span>
        </div>
      </div>
      <div className="mc-sched-env-note">
        Styrs av <code>AUTO_MACHINE_ENABLED</code> · <code>AUTO_MACHINE_INTERVAL_MINUTES</code> · <code>AUTO_MACHINE_LOOKBACK_DAYS</code> · <code>AUTO_MACHINE_GROUPS</code> i .env
      </div>
    </div>
  );
}

function buildStateDistribution(results) {
  const dist = {};
  for (const r of (results || [])) {
    const state = r?.stateGraph?.currentState;
    if (state) dist[state] = (dist[state] || 0) + 1;
  }
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  return { dist, total };
}

function StateDistBar({ state, count, total }) {
  if (!count) return null;
  const pct2 = Math.round((count / total) * 100);
  const color = SG_COLORS[state] || '#6b7280';
  return (
    <div className="sg-dist-row">
      <span className="sg-dist-label" style={{ color }}>{SG_LABELS[state] || state}</span>
      <div className="sg-dist-bar-wrap">
        <div className="sg-dist-bar" style={{ width: `${pct2}%`, background: color }} />
      </div>
      <span className="sg-dist-count">{count}</span>
    </div>
  );
}

function StateDistPanel({ results, title }) {
  const { dist, total } = buildStateDistribution(results);
  if (!total) return <div className="sg-dist-empty">Väntar på scan…</div>;
  const ORDER = ['COMPRESSION','BREAKOUT','MOMENTUM','TREND','EXHAUSTION','REVERSAL','CHOPPY','UNKNOWN'];
  return (
    <div className="sg-dist-panel">
      <div className="sg-dist-title">{title} <span className="sg-dist-total">({total} symboler)</span></div>
      {ORDER.map(st => dist[st] ? <StateDistBar key={st} state={st} count={dist[st]} total={total} /> : null)}
    </div>
  );
}

function LiveIntelligencePanel({ stocks, crypto }) {
  const all = [...(stocks || []), ...(crypto || [])];
  if (!all.length) return null;
  const stale = all.filter(r => r?.decayContext?.stale && r.price)
    .sort((a, b) => (a.decayContext.penalty ?? 0) - (b.decayContext.penalty ?? 0));
  const top = all.filter(r => r.price && r.tradeScore >= 40 && !r.autoFilter?.blocked && !r.decayContext?.stale)
    .sort((a, b) => b.tradeScore - a.tradeScore).slice(0, 5);
  const compressing = all.filter(r => r?.stateGraph?.currentState === 'COMPRESSION' && r.price)
    .sort((a, b) => (b.preMoveContext?.compressionStrength ?? 0) - (a.preMoveContext?.compressionStrength ?? 0));
  if (!stale.length && !top.length && !compressing.length) return null;
  return (
    <div className="li-panel">
      {top.length > 0 && (
        <div className="li-section">
          <div className="li-section-title">Starkaste signaler</div>
          {top.map(r => (
            <div className="li-row" key={r.symbol}>
              <span className="li-sym">{r.symbol}</span>
              <span className="li-state" style={{ color: SG_COLORS[r.stateGraph?.currentState] || 'var(--muted)' }}>{SG_LABELS[r.stateGraph?.currentState] || r.stateGraph?.currentState || '–'}</span>
              <span className="li-score" style={{ color: r.tradeScore >= 65 ? 'var(--green)' : r.tradeScore >= 45 ? '#fbbf24' : 'var(--muted)' }}>{r.tradeScore}p</span>
            </div>
          ))}
        </div>
      )}
      {compressing.length > 0 && (
        <div className="li-section">
          <div className="li-section-title">Komprimering — pre-move kandidater</div>
          {compressing.map(r => (
            <div className="li-row" key={r.symbol}>
              <span className="li-sym">{r.symbol}</span>
              <span className="li-state" style={{ color: '#818cf8' }}>{r.preMoveContext?.expansionBias || 'neutral'} · {Math.round(r.preMoveContext?.compressionStrength ?? 0)}%</span>
              <span className="li-score" style={{ color: r.preMoveContext?.preMoveWatchMode ? '#34d399' : 'var(--muted)' }}>{r.preMoveContext?.preMoveWatchMode ? 'BEVAKA' : `${r.tradeScore}p`}</span>
            </div>
          ))}
        </div>
      )}
      {stale.length > 0 && (
        <div className="li-section">
          <div className="li-section-title" style={{ color: '#fbbf24' }}>Åldrande signaler</div>
          {stale.map(r => (
            <div className="li-row" key={r.symbol}>
              <span className="li-sym">{r.symbol}</span>
              <span className="li-state" style={{ color: 'var(--muted)' }}>{r.decayContext.decayMinutes} min · t={r.decayContext.ticks}</span>
              <span className="li-score" style={{ color: 'var(--red)' }}>{r.decayContext.penalty}p</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MachinePage() {
  const [triggered, setTriggered] = useState(false);
  const [showTech,  setShowTech]  = useState(false);
  const [motorOpen, setMotorOpen] = useState(false);

  const { data, loading, error: fetchError, refresh } = useMachineStatus(triggered);
  const { sched, refresh: refreshSched }  = useSchedulerStatus();
  const personality    = useMarketPersonality();
  const ruleHealth     = useRuleHealth();
  const momentumBacktest = useMomentumBacktest();
  const stateGraphData = useStateGraphSummary();

  const decisions       = useSignalDecisions();
  const learningSummary = useLearningSummary();
  const ruleMemory      = useRuleMemoryData();
  const symbolProfiles  = useSymbolProfilesData();
  const regimeProfiles  = useRegimeProfilesData();
  const scoreCalibration = useScoreCalibrationData();
  const fakeoutDna      = useFakeoutDnaData();

  useEffect(() => {
    if (triggered && data && !data.running) setTriggered(false);
  }, [triggered, data]);

  const isRunning  = !!data?.running;
  const status     = data?.status || null;
  const lastResult = status?.lastResult || null;
  const steps      = lastResult?.steps || null;
  const config     = data?.config || {};
  const lastRunAt  = status?.startedAt ? fmtDateTime(status.startedAt) : null;
  const duration   = status?.startedAt && status?.finishedAt
    ? fmtDuration(status.startedAt, status.finishedAt) : null;

  function handleTriggered() {
    setTriggered(true);
    refresh();
    refreshSched();
  }

  return (
    <div>
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <div className="page-hero">
        <div className="hero-left">
          <div className="hero-title">
            <span style={{ color: 'var(--blue)' }}>🧠 Intelligens</span>
            <span style={{ color: 'var(--muted)', fontSize: '1rem', fontWeight: 400 }}> · Lärdomar & minne</span>
          </div>
          <div className="hero-sub">
            Vad systemet har lärt sig och vilka signaler som är närmast redo just nu.
          </div>
        </div>
        <div className="status-bar-v2">
          {isRunning ? (
            <span className="status-pill s-scan">
              <span className="spinner" style={{ width: 10, height: 10 }} />
              Motor kör…
            </span>
          ) : (
            <span className="status-pill s-ok">● Redo</span>
          )}
          <button
            className={`btn lrn-tech-toggle${showTech ? ' lrn-tech-on' : ''}`}
            onClick={() => setShowTech(v => !v)}
            title="Visa/dölj tekniska detaljer"
          >
            {showTech ? '🔬 Tekniska detaljer på' : '🔬 Visa tekniska detaljer'}
          </button>
          <button className="btn" onClick={() => { refresh(); refreshSched(); }} style={{ fontSize: 11, padding: '3px 10px' }}>↻</button>
        </div>
      </div>

      {/* ── 1. Systemets lärdomar just nu ────────────────────────────────── */}
      <div className="sec">
        <SectionHeader
          icon="📊"
          title="Systemets lärdomar just nu"
          desc="Hur ser signalerna ut just nu? Vad stoppar dem?"
        />
        <LearningTopCards decisions={decisions} showTech={showTech} />
      </div>

      {/* ── 2. Varför stoppas signaler? ───────────────────────────────────── */}
      <div className="sec">
        <SectionHeader
          icon="🚧"
          title="Varför stoppas signaler?"
          desc="Fördelning av stopporsaker från alla aktiva signaler."
        />
        <div className="sr-wrap">
          <StopReasonsChart decisions={decisions} showTech={showTech} />
          <BlockTypeExplainer showTech={showTech} />
        </div>
      </div>

      {/* ── 3. Närmast READY ─────────────────────────────────────────────── */}
      <div className="sec">
        <SectionHeader
          icon="🎯"
          title="Närmast READY"
          desc="Symboler som är närmast ett köpläge — sorterade efter avstånd till READY."
        />
        <NearestReadyList decisions={decisions} showTech={showTech} />
      </div>

      {/* ── 4. Vad systemet har lärt sig ─────────────────────────────────── */}
      <div className="sec">
        <SectionHeader
          icon="🧠"
          title="Vad systemet har lärt sig"
          desc="Svenska lärdomar från historiska signaler och regelanalys."
        />
        <SystemInsightsSection summary={learningSummary} ruleHealth={ruleHealth} />
        {learningSummary && (
          <div style={{ marginTop: 16 }}>
            <SystemConclusionBox learning={learningSummary} />
          </div>
        )}
      </div>

      {/* ── 5. Minnesbanken ──────────────────────────────────────────────── */}
      <div className="sec">
        <SectionHeader
          icon="💾"
          title="Minnesbanken"
          desc="Allt systemet minns — regelminne, symbolminne, marknadsminne, score-minne och fakeout-minne."
        />
        <MemoryBankSection
          ruleMemory={ruleMemory}
          symbolProfiles={symbolProfiles}
          regimeProfiles={regimeProfiles}
          scoreCalibration={scoreCalibration}
          fakeoutDna={fakeoutDna}
        />
      </div>

      {/* ── 6. Live Marknadskaraktär ──────────────────────────────────────── */}
      <div className="sec">
        <SectionHeader icon="🧠" title="Live Marknadskaraktär" desc="Beräknas automatiskt varje scan-tick från alla aktiva symboler." />
        <div className="mc-personality-grid">
          <MarketPersonalityCard personality={personality?.stocks} group="stocks" />
          <MarketPersonalityCard personality={personality?.crypto} group="crypto" />
        </div>
      </div>

      {/* ── 7. Marknadscykel ─────────────────────────────────────────────── */}
      <div className="sec">
        <SectionHeader icon="🔄" title="Marknadscykel — State Graph" desc="Var befinner sig varje symbol i marknadslogiken just nu?" />
        <div className="sg-dist-grid">
          <StateDistPanel results={stateGraphData.stocks} title="Aktier" />
          <StateDistPanel results={stateGraphData.crypto} title="Krypto" />
        </div>
      </div>

      {/* ── 8. Live Intelligens ──────────────────────────────────────────── */}
      {(stateGraphData.stocks?.length || stateGraphData.crypto?.length) ? (
        <div className="sec">
          <SectionHeader icon="⚡" title="Live Intelligens" desc="Starkaste signaler, komprimering och åldrande setups just nu." />
          <LiveIntelligencePanel stocks={stateGraphData.stocks} crypto={stateGraphData.crypto} />
        </div>
      ) : null}

      {/* ── 9. Auto Motor (collapsible) ──────────────────────────────────── */}
      <div className="sec">
        <button className="lrn-motor-toggle" onClick={() => setMotorOpen(v => !v)}>
          <span>🤖 Auto Motor — pipeline, scheduler & manuell körning</span>
          <span className="lrn-motor-chevron">{motorOpen ? '▲' : '▼'}</span>
          {isRunning && <span className="lrn-motor-running"><span className="spinner" style={{ width: 10, height: 10 }} /> Kör…</span>}
        </button>

        {motorOpen && (
          <>
            {fetchError && (
              <div className="market-banner" style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--red-dim)', marginTop: 12 }}>
                ✗ Kunde inte hämta status: {fetchError}
              </div>
            )}
            {loading && !data && (
              <div className="empty"><span className="spinner" /> Hämtar status…</div>
            )}

            <div className="sec" style={{ marginTop: 16 }}>
              <SectionHeader icon="📈" title="Historiskt test av fartanalys" desc="Mäter om fortsättning, falska rörelser och stopjakt förbättrar historiska signaler." />
              <MomentumBacktestPanel report={momentumBacktest} />
            </div>

            {data && (
              <>
                <div className="mc-status-row">
                  <div className="mc-status-card">
                    <div className="mc-status-card-label">Status</div>
                    <div className={`mc-status-card-val ${isRunning ? 'mc-status-running' : 'mc-status-idle'}`}>
                      {isRunning
                        ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Kör…</>
                        : lastResult?.ok === false ? '✗ Senaste fel'
                        : lastResult ? '✓ Klar'
                        : '– Ej körts'}
                    </div>
                  </div>
                  <div className="mc-status-card">
                    <div className="mc-status-card-label">Senaste körning</div>
                    <div className="mc-status-card-val mc-status-mono">{lastRunAt ?? '–'}</div>
                  </div>
                  <div className="mc-status-card">
                    <div className="mc-status-card-label">Körtid</div>
                    <div className="mc-status-card-val mc-status-mono">{duration ?? '–'}</div>
                  </div>
                  <div className="mc-status-card">
                    <div className="mc-status-card-label">Lookback</div>
                    <div className="mc-status-card-val mc-status-mono">
                      {lastResult?.lookbackDays ? `${lastResult.lookbackDays} dagar` : config.lookbackDays ? `${config.lookbackDays} d (default)` : '–'}
                    </div>
                  </div>
                  <div className="mc-status-card">
                    <div className="mc-status-card-label">Grupper</div>
                    <div className="mc-status-card-val" style={{ fontSize: '0.8rem' }}>
                      {(lastResult?.groups ?? config.groups ?? []).join(', ') || '–'}
                    </div>
                  </div>
                </div>

                {lastResult && (
                  <div className="sec">
                    <SectionHeader icon="📈" title="Senaste resultatet" desc={`${lastResult.start ?? '?'} → ${lastResult.end ?? '?'}`} />
                    <ResultStats result={lastResult} />
                  </div>
                )}

                <div className="sec">
                  <SectionHeader icon="🔄" title="Pipeline-steg" desc="Varje steg körs i ordning." />
                  <PipelineSteps steps={steps} isRunning={isRunning} />
                </div>

                <div className="sec">
                  <SectionHeader icon="🎛️" title="Kör manuellt" desc="Välj grupper och tidsperiod och starta pipelinen." />
                  <RunForm isRunning={isRunning} onTriggered={handleTriggered} />
                </div>

                <div className="sec">
                  <SectionHeader icon="💊" title="Rule Health Monitor" desc={`Spårar prestanda per signaltyp — ${ruleHealth?.recentWindowDays ?? 14}d rullande vs historisk basline.`} />
                  <RuleHealthPanel health={ruleHealth} />
                </div>

                <div className="sec">
                  <SectionHeader icon="⏰" title="Scheduler" desc="Automatisk körning enligt schema." />
                  <SchedulerPanel sched={sched} />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
