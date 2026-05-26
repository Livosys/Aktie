import React from 'react';

// ── PreMovePanel ──────────────────────────────────────────────────────────────

export function PreMovePanel({ r }) {
  const ctx = r?.preMoveContext;
  if (!ctx) return null;
  const { preMoveProbability, expansionBias, compressionStrength, breakoutPressure, preMoveWatchMode, explanationSv } = ctx;
  if (preMoveProbability < 20) return null;

  const biasColor = expansionBias === 'bullish' ? 'var(--green)' : expansionBias === 'bearish' ? 'var(--red)' : 'var(--text-muted)';
  const probColor = preMoveProbability >= 65 ? 'var(--green)' : preMoveProbability >= 40 ? 'var(--yellow)' : 'var(--text-muted)';

  return (
    <div className="panel premove-panel">
      <div className="panel-title">🌀 Rörelsen är under uppbyggnad</div>
      <div className="premove-grid">
        <div className="premove-row">
          <span className="premove-label">Priset rör sig trångt</span>
          <div className="premove-bar-wrap">
            <div className="premove-bar" style={{ width: `${compressionStrength}%`, background: 'var(--blue)' }} />
          </div>
          <span className="premove-val">{compressionStrength}%</span>
        </div>
        <div className="premove-row">
          <span className="premove-label">Utbrytarpress</span>
          <div className="premove-bar-wrap">
            <div className="premove-bar" style={{ width: `${breakoutPressure}%`, background: 'var(--purple, #a855f7)' }} />
          </div>
          <span className="premove-val">{breakoutPressure}%</span>
        </div>
        <div className="premove-row">
          <span className="premove-label">Chans för rörelse</span>
          <div className="premove-bar-wrap">
            <div className="premove-bar" style={{ width: `${preMoveProbability}%`, background: probColor }} />
          </div>
          <span className="premove-val" style={{ color: probColor, fontWeight: 700 }}>{preMoveProbability}%</span>
        </div>
      </div>
      <div className="premove-meta">
        <span className="premove-bias" style={{ color: biasColor }}>
          {expansionBias === 'bullish' ? '▲ Trolig uppgång' : expansionBias === 'bearish' ? '▼ Trolig nedgång' : '◆ Neutral riktning'}
        </span>
        {preMoveWatchMode && <span className="badge badge-watch" style={{ marginLeft: 8 }}>BEVAKA</span>}
      </div>
      {explanationSv && <div className="panel-explanation">{explanationSv}</div>}
    </div>
  );
}

// ── FatiguePanel ──────────────────────────────────────────────────────────────

const DECAY_LABEL_SV = { none: 'Ingen', mild: 'Mild', moderate: 'Måttlig', severe: 'Stark' };
const DECAY_COLOR    = { none: 'var(--green)', mild: 'var(--yellow)', moderate: '#f97316', severe: 'var(--red)' };

export function FatiguePanel({ r }) {
  const ctx = r?.fatigueContext;
  if (!ctx) return null;
  const { fatigueScore, continuationDecay, fatigueReasons, explanationSv } = ctx;
  if (fatigueScore < 25) return null;

  const color = DECAY_COLOR[continuationDecay] || 'var(--text-muted)';

  return (
    <div className="panel fatigue-panel">
      <div className="panel-title">⚡ Rörelsen tappar kraft</div>
      <div className="fatigue-header">
        <div className="fatigue-bar-wrap">
          <div className="fatigue-bar" style={{ width: `${fatigueScore}%`, background: color }} />
        </div>
        <span className="fatigue-score" style={{ color, fontWeight: 700, marginLeft: 8 }}>{fatigueScore}/100</span>
        <span className="fatigue-decay-badge" style={{ background: color, color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: '0.7rem', marginLeft: 6 }}>
          {DECAY_LABEL_SV[continuationDecay] || continuationDecay}
        </span>
      </div>
      {fatigueReasons.length > 0 && (
        <ul className="fatigue-reasons">
          {fatigueReasons.map((reason, i) => <li key={i}>{reason}</li>)}
        </ul>
      )}
      {explanationSv && <div className="panel-explanation">{explanationSv}</div>}
    </div>
  );
}

// ── FakeoutDnaPanel ───────────────────────────────────────────────────────────

const FAKEOUT_RISK_COLOR = { high: 'var(--red)', elevated: '#f97316', normal: 'var(--text-muted)', low: 'var(--green)' };
const FAKEOUT_RISK_SV    = { high: 'Hög', elevated: 'Förhöjd', normal: 'Normal', low: 'Låg' };

export function FakeoutDnaPanel({ r }) {
  const dna = r?.fakeoutDna;
  if (!dna) return null;
  const { fakeoutProbabilityScore, fakeoutRisk, fakeoutAdjustment, matchedFeatures, explanationSv } = dna;
  if (fakeoutProbabilityScore >= 44 && fakeoutProbabilityScore <= 56 && (!matchedFeatures || matchedFeatures.length === 0)) return null;

  const color = FAKEOUT_RISK_COLOR[fakeoutRisk] || 'var(--text-muted)';

  return (
    <div className="panel dna-panel">
      <div className="panel-title">🧬 Risk för falsk rörelse</div>
      <div className="dna-header">
        <div className="dna-bar-wrap">
          <div className="dna-bar" style={{ width: `${fakeoutProbabilityScore}%`, background: color }} />
        </div>
        <span className="dna-score" style={{ color, fontWeight: 700, marginLeft: 8 }}>{fakeoutProbabilityScore}/100</span>
        <span className="dna-risk-badge" style={{ background: color, color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: '0.7rem', marginLeft: 6 }}>
          {FAKEOUT_RISK_SV[fakeoutRisk] || fakeoutRisk}
        </span>
        {fakeoutAdjustment !== 0 && (
          <span style={{ marginLeft: 8, fontSize: '0.75rem', fontWeight: 700, color: fakeoutAdjustment < 0 ? 'var(--red)' : 'var(--green)' }}>
            {fakeoutAdjustment > 0 ? '+' : ''}{fakeoutAdjustment} pts
          </span>
        )}
      </div>
      {matchedFeatures && matchedFeatures.length > 0 && (
        <div className="dna-features">
          {matchedFeatures.slice(0, 4).map((f, i) => (
            <div key={i} className="dna-feature-row">
              <span className="dna-feature-name">{f.feature}</span>
              <span className="dna-feature-val">{f.value}</span>
              <span style={{ color: f.elevation > 0 ? 'var(--red)' : 'var(--green)', fontSize: '0.72rem' }}>
                {Math.round(f.fakeoutRate * 100)}% falsk rörelse ({f.elevation > 0 ? '+' : ''}{Math.round(f.elevation * 100)}%)
              </span>
            </div>
          ))}
        </div>
      )}
      {explanationSv && <div className="panel-explanation">{explanationSv}</div>}
    </div>
  );
}

// ── StateGraphPanel ───────────────────────────────────────────────────────────

const SG_STATE_COLOR = {
  COMPRESSION: '#818cf8',
  BREAKOUT:    '#34d399',
  MOMENTUM:    '#10b981',
  TREND:       '#06b6d4',
  EXHAUSTION:  '#f97316',
  REVERSAL:    '#ef4444',
  CHOPPY:      '#6b7280',
  UNKNOWN:     '#374151',
};

const SG_STATE_SV = {
  COMPRESSION: 'Priset rör sig trångt',
  BREAKOUT:    'Utbrott',
  MOMENTUM:    'Stark rörelse',
  TREND:       'Tydlig trend',
  EXHAUSTION:  'Rörelsen tappar fart',
  REVERSAL:    'Vändning',
  CHOPPY:      'Stökig marknad',
  UNKNOWN:     'Okänd',
};

const SG_CYCLE_SV = { early: 'Tidig fas', mid: 'Mittfas', late: 'Sen fas' };

export function StateGraphPanel({ r }) {
  const sg = r?.stateGraph;
  if (!sg || sg.currentState === 'UNKNOWN') return null;

  const { currentState, stateConfidence, prevState, cyclePosition, expectedNextState,
          transitionProbabilities, barsSinceTransition, actionableInsight } = sg;

  const stateColor = SG_STATE_COLOR[currentState] || '#6b7280';
  const topTransitions = Object.entries(transitionProbabilities || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  return (
    <div className="sg-panel">
      <div className="sg-header">
        <span className="sg-title">Marknadsfas</span>
        <span className="sg-state-badge" style={{ background: stateColor }}>
          {SG_STATE_SV[currentState] || currentState}
        </span>
        {cyclePosition && (
          <span className="sg-cycle-badge" style={{ color: cyclePosition === 'late' ? '#f97316' : cyclePosition === 'mid' ? '#fbbf24' : '#6ee7b7' }}>
            {SG_CYCLE_SV[cyclePosition]}
          </span>
        )}
      </div>

      <div className="sg-conf-row">
        <span className="sg-conf-label">Säkerhet</span>
        <div className="sg-bar-wrap">
          <div className="sg-bar" style={{ width: `${stateConfidence}%`, background: stateColor }} />
        </div>
        <span className="sg-conf-val">{stateConfidence}%</span>
      </div>

      {actionableInsight && (
        <div className="sg-insight">{actionableInsight}</div>
      )}

      <div className="sg-transitions">
        <div className="sg-trans-label">Vart är marknaden troligen på väg?</div>
        {topTransitions.map(([st, pct]) => (
          <div className="sg-trans-row" key={st}>
            <span className="sg-trans-state" style={{ color: SG_STATE_COLOR[st] || '#6b7280' }}>
              {SG_STATE_SV[st] || st}
            </span>
            <div className="sg-trans-bar-wrap">
              <div className="sg-trans-bar" style={{ width: `${pct}%`, background: SG_STATE_COLOR[st] || '#6b7280' }} />
            </div>
            <span className="sg-trans-pct">{pct}%</span>
          </div>
        ))}
      </div>

      <div className="sg-meta">
        {prevState && prevState !== currentState && (
          <span className="sg-meta-chip">Från: {SG_STATE_SV[prevState] || prevState}</span>
        )}
        <span className="sg-meta-chip">{barsSinceTransition} tick{barsSinceTransition !== 1 ? 's' : ''} i denna fas</span>
      </div>
    </div>
  );
}

// ── OrchestratorPanel ─────────────────────────────────────────────────────────

export function OrchestratorPanel({ r }) {
  const orch = r?.orchestrator;
  if (!orch?.enabled || !orch.adjustments?.length) return null;

  const { baseScore, totalAdj, hasConflict, adjustments, finalScore } = orch;

  return (
    <div className="orch-panel">
      <div className="orch-header">
        <span className="orch-title">Samlad poängbedömning</span>
        {hasConflict && <span className="orch-conflict-badge">⚠ Motorerna är oense</span>}
        <span className="orch-final" style={{ color: totalAdj > 0 ? 'var(--green)' : totalAdj < 0 ? 'var(--red)' : 'var(--muted)' }}>
          {baseScore} → {finalScore} ({totalAdj >= 0 ? '+' : ''}{totalAdj})
        </span>
      </div>
      <div className="orch-rows">
        {adjustments.map(({ name, adj }) => (
          <div className="orch-row" key={name}>
            <span className="orch-engine">{name}</span>
            <span className="orch-adj" style={{ color: adj > 0 ? 'var(--green)' : adj < 0 ? 'var(--red)' : 'var(--muted)' }}>
              {adj > 0 ? '+' : ''}{adj}
            </span>
          </div>
        ))}
      </div>
      {hasConflict && (
        <div className="orch-note">Systemets motorer ser olika saker. Betyget justerades ned med 40% för säkerhet.</div>
      )}
    </div>
  );
}

// ── DecayPanel ────────────────────────────────────────────────────────────────

export function DecayPanel({ r }) {
  const dc = r?.decayContext;
  if (!dc?.stale) return null;

  const { ticks, penalty, decayMinutes, explanationSv } = dc;

  return (
    <div className="decay-panel">
      <div className="decay-header">
        <span className="decay-title">Signalen har inte förändrats på länge</span>
        <span className="decay-badge">⏳ {decayMinutes} min</span>
        <span className="decay-penalty">{penalty} p</span>
      </div>
      {explanationSv && <div className="decay-explanation">{explanationSv}</div>}
    </div>
  );
}
