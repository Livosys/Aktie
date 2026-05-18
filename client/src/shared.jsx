import React, { useState } from 'react';
import { useAlerts } from './alertContext.jsx';

// ── Utilities ─────────────────────────────────────────────────────────────────

export function tvLink(symbol) {
  return `https://www.tradingview.com/chart/?symbol=NASDAQ:${symbol}`;
}

export function cryptoTvLink(symbol) {
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}`;
}

export function fmtTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString('sv-SE', { hour12: false });
}

function alertText(r) {
  return (
    `${r.symbol} | ${r.state} | Price: ${r.price ?? 'N/A'} | ` +
    `Signal: ${r.signal} | SMA20: ${r.sma20 ?? 'N/A'} | SMA200: ${r.sma200 ?? 'N/A'} | ` +
    `RSI: ${r.rsi14 ?? 'N/A'} | ATR: ${r.atr14 ?? 'N/A'} | ` +
    `Long: ${r.longTrigger ?? 'N/A'} | Short: ${r.shortTrigger ?? 'N/A'} | ` +
    `Conf: ${r.confidence}%`
  );
}

function claudePrompt(r) {
  const tfs = r.threeFingerSpread || {};
  const eb  = r.elephantBar || {};
  return (
    `Analyze this 2-minute Nasdaq narrow state setup:\n\n` +
    `Symbol: ${r.symbol}\nPrice: ${r.price}\nState: ${r.state}\nSignal: ${r.signal}\n` +
    `Position: ${r.position}\nConfidence: ${r.confidence}%\n` +
    `EventType: ${r.eventType ?? 'N/A'}\nSignalScore: ${r.signalScore ?? 'N/A'} (${r.scoreLabel ?? 'N/A'})\n` +
    `SMA20: ${r.sma20} | SMA200: ${r.sma200} | SMA Gap%: ${r.smaGapPct ?? 'N/A'}\n` +
    `RSI14: ${r.rsi14} | ATR14: ${r.atr14}\n` +
    `Long Trigger: ${r.longTrigger} | Short Trigger: ${r.shortTrigger}\n` +
    `Invalidation Long: ${r.invalidationLong} | Invalidation Short: ${r.invalidationShort}\n` +
    `Target 1 Long: ${r.target1Long} | Target 2 Long: ${r.target2Long}\n` +
    `Target 1 Short: ${r.target1Short} | Target 2 Short: ${r.target2Short}\n` +
    `3 Finger Spread: active=${tfs.active} dir=${tfs.direction} strength=${tfs.strength} P→SMA20=${tfs.priceToSma20Atr}x SMA20→SMA200=${tfs.sma20ToSma200Atr}x\n` +
    `Elephant Bar: active=${eb.active} dir=${eb.direction} rangeMultiple=${eb.rangeMultiple}x bodyPct=${eb.bodyPercent} closeQuality=${eb.closeQuality}\n\n` +
    `Is this a valid Oliver Velez-style narrow state setup? Consider the 3 Finger Spread and Elephant Bar signals. What would be the ideal entry trigger and management plan?`
  );
}

export function copyText(text) {
  navigator.clipboard.writeText(text).catch(() => {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  });
}

export function fmt(v, dec = 2) {
  if (v === null || v === undefined) return <span className="val-null">–</span>;
  return <span className="val-ok">{Number(v).toFixed(dec)}</span>;
}

export function fmtPrice(v) {
  if (v === null || v === undefined) return <span className="val-null">–</span>;
  return <span className="price-cell val-ok">${Number(v).toFixed(2)}</span>;
}

export function fmtPos(pos) {
  if (pos === null || pos === undefined) return <span className="pos pos-zero">–</span>;
  if (pos === 0) return <span className="pos pos-zero">0</span>;
  if (pos > 0) return <span className="pos pos-long">+{pos}</span>;
  return <span className="pos pos-short">{pos}</span>;
}

// ── Svenska översättningar ────────────────────────────────────────────────────

export function svRiktning(dir) {
  if (dir === 'bullish') return 'Uppåt / stark';
  if (dir === 'bearish') return 'Nedåt / svag';
  return dir ?? '–';
}

export function svStyrka(strength) {
  if (strength === 'super_wide') return 'Väldigt långt ifrån';
  if (strength === 'wide')       return 'Långt ifrån';
  if (strength === 'normal')     return 'Normal';
  return strength ?? '–';
}

export function svEventType(eventType) {
  const map = {
    THREE_FINGER_SPREAD_AVOID:  'Priset är för långt bort — jaga inte',
    REGULAR_PULLBACK:           'Vanlig trend — vänta på bättre läge',
    NARROW_WAIT:                'Narrow state — vänta på breakout',
    BULLISH_ELEPHANT_BREAKOUT:  'Stark grön candle — möjlig long',
    BEARISH_ELEPHANT_BREAKDOWN: 'Stark röd candle — möjlig short',
    BULLISH_COLOR_CHANGE:       'Färgbyte uppåt i narrow-zon — bevaka long',
    BEARISH_COLOR_CHANGE:       'Färgbyte nedåt i narrow-zon — bevaka short',
    WIDE_REVERSAL_WATCH:        'Möjlig reversal — bevaka',
    BREAKOUT_ALREADY_OCCURRED:  'Utbrottet har redan hänt — vänta på ny setup',
  };
  return map[eventType] ?? eventType ?? '–';
}

// ── Display Signal — score-medveten badge (Engine v3) ─────────────────────────

export function getDisplaySignal(result) {
  const { signal, tradeScore, state, positionLabelSv, threeFingerSpread, breakoutAlreadyOccurred } = result || {};
  const tfs = threeFingerSpread || {};
  const score = tradeScore ?? 0;
  const avoidState = ['WIDE_AVOID', 'THREE_FINGER_SPREAD_AVOID'].includes(state) || tfs.active;
  const extended   = (positionLabelSv || '').includes('För långt');

  if (avoidState || extended)    return 'JAGA_INTE';
  if (breakoutAlreadyOccurred)   return 'VANTA_PULLBACK';

  if (signal === 'LONG_TRIGGERED') {
    if (score >= 50) return 'LONG_TRIG';
    if (score >= 20) return 'SVAG_LONG';
    return 'LAG_KVALITET';
  }
  if (signal === 'SHORT_TRIGGERED') {
    if (score >= 50) return 'SHORT_TRIG';
    if (score >= 20) return 'SVAG_SHORT';
    return 'LAG_KVALITET';
  }
  if (signal === 'LONG_WATCH')          return score >= 30 ? 'LONG_VAKA'  : 'VANTA';
  if (signal === 'SHORT_WATCH')         return score >= 30 ? 'SHORT_VAKA' : 'VANTA';
  if (signal === 'WAIT_PULLBACK')       return 'VANTA_PULLBACK';
  if (signal === 'WIDE_REVERSAL_WATCH') return 'REVERSAL';
  return 'VANTA';
}

export function getDisplayNote(result) {
  const { tradeScore, positionLabelSv, signal } = result || {};
  const score = tradeScore ?? 0;
  const pl = positionLabelSv || '';
  if (pl.includes('För långt upp') || pl.includes('För långt ned')) {
    return 'Priset är för långt från zonen. Vänta på pullback.';
  }
  if (score < 20 && ['LONG_TRIGGERED', 'SHORT_TRIGGERED', 'LONG_WATCH', 'SHORT_WATCH'].includes(signal)) {
    return 'Signal finns, men kvaliteten är för låg. Vänta.';
  }
  return null;
}

const DISPLAY_SIGNAL_MAP = {
  LONG_TRIG:      { cls: 'badge-green',  label: '🟢 Möjlig uppgång' },
  SHORT_TRIG:     { cls: 'badge-red',    label: '🔴 Möjlig nedgång' },
  LONG_VAKA:      { cls: 'badge-green',  label: '🟢 Möjlig uppgång – bevaka' },
  SHORT_VAKA:     { cls: 'badge-red',    label: '🔴 Möjlig nedgång – bevaka' },
  SVAG_LONG:      { cls: 'badge-orange', label: '🟠 Svag uppgångssignal' },
  SVAG_SHORT:     { cls: 'badge-orange', label: '🟠 Svag nedgångssignal' },
  LAG_KVALITET:   { cls: 'badge-yellow', label: '🟡 Låg kvalitet – vänta' },
  JAGA_INTE:      { cls: 'badge-purple', label: '⚠️ Jaga inte' },
  VANTA_PULLBACK: { cls: 'badge-yellow', label: '🟡 Rörelsen har redan börjat' },
  REVERSAL:       { cls: 'badge-orange', label: 'Reversal?' },
  VANTA:          { cls: 'badge-yellow', label: '🟡 Vänta' },
};

export function DisplaySignalBadge({ result }) {
  const key = getDisplaySignal(result);
  const m = DISPLAY_SIGNAL_MAP[key] || { cls: 'badge-gray', label: key };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

// ── Fallback förklaring ───────────────────────────────────────────────────────

export function svForklaring(r) {
  if (r.actionSv) return r.actionSv;

  const tfs = r.threeFingerSpread || {};
  const eb  = r.elephantBar || {};

  if (tfs.active) {
    if (tfs.strength === 'super_wide') {
      return tfs.direction === 'bullish'
        ? 'Priset har redan gått mycket uppåt. Det är för sent att köpa long. Vänta tills priset kommer närmare SMA20.'
        : 'Priset har redan gått mycket nedåt. Det är för sent att jaga short. Vänta på pullback eller ny setup.';
    }
    const dir = tfs.direction === 'bullish' ? 'uppåt' : 'nedåt';
    return `Priset är för långt ${dir} från SMA20. Jaga inte entry.`;
  }

  if (eb.active) {
    return eb.direction === 'bullish'
      ? 'Stor grön candle. Köpare trycker upp priset.'
      : 'Stor röd candle. Säljare trycker ned priset.';
  }

  if (r.state === 'BREAKOUT_ALREADY_OCCURRED') return 'Utbrottet har redan hänt. Vänta på ny setup.';
  if (r.state === 'THREE_FINGER_SPREAD_AVOID') return 'Priset är för långt ifrån. Jaga inte.';
  if (r.state === 'WIDE_AVOID')          return 'Priset är för långt från en bra entry. Vänta.';
  if (r.state === 'REGULAR_TREND')       return 'Det är vanlig trend just nu. Ingen perfekt narrow state.';
  if (r.state === 'HIGH_QUALITY_NARROW') return 'Priset är ihoptryckt nära SMA20/SMA200. Vänta på tydlig breakout eller breakdown.';
  if (r.state === 'MEDIUM_NARROW')       return 'Priset är ganska ihoptryckt. Kan bli setup — bevaka noga.';
  if (r.state === 'NO_TRADE')            return 'Ingen data eller handel möjlig just nu.';
  return '';
}

// ── New-signal badge ──────────────────────────────────────────────────────────

export function NewSignalBadge({ symbol }) {
  const alerts = useAlerts();
  if (!alerts || !alerts.isNewSignal(symbol)) return null;
  return <span className="new-signal-badge">NY SIGNAL</span>;
}

// ── Badges ────────────────────────────────────────────────────────────────────

const STATE_META = {
  HIGH_QUALITY_NARROW:      { label: 'BÄSTA NARROW', cls: 'badge-yellow', icon: '⚡' },
  MEDIUM_NARROW:            { label: 'OKEJ NARROW',  cls: 'badge-yellow', icon: '◎' },
  REGULAR_TREND:            { label: 'TREND',         cls: 'badge-blue',   icon: '→' },
  WIDE_AVOID:               { label: 'FÖR LÅNGT',     cls: 'badge-purple', icon: '⚠️' },
  THREE_FINGER_SPREAD_AVOID:{ label: 'JAGA EJ',       cls: 'badge-purple', icon: '⚠️' },
  BREAKOUT_ALREADY_OCCURRED:{ label: 'REDAN BRUTET',  cls: 'badge-orange', icon: '🚀' },
  NO_TRADE:                 { label: 'INGEN TRADE',   cls: 'badge-gray',   icon: '○' },
};

const SIGNAL_META = {
  LONG_WATCH:          { cls: 'badge-green',  label: '🟢 LONG VAKA' },
  LONG_TRIGGERED:      { cls: 'badge-green',  label: '🟢 LONG TRIG' },
  SHORT_WATCH:         { cls: 'badge-red',    label: '🔴 SHORT VAKA' },
  SHORT_TRIGGERED:     { cls: 'badge-red',    label: '🔴 SHORT TRIG' },
  WIDE_REVERSAL_WATCH: { cls: 'badge-orange', label: 'REVERSAL' },
  WAIT:                { cls: 'badge-yellow', label: '🟡 VÄNTA' },
  WAIT_PULLBACK:       { cls: 'badge-yellow', label: '🟡 VÄNTA PB' },
  NO_TRADE:            { cls: 'badge-gray',   label: '○ INGEN TRADE' },
};

export function StateBadge({ state }) {
  const m = STATE_META[state] || { label: state, cls: 'badge-gray', icon: '?' };
  return <span className={`badge ${m.cls}`}>{m.icon} {m.label}</span>;
}

export function SignalBadge({ signal }) {
  const m = SIGNAL_META[signal] || { cls: 'badge-gray', label: signal };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

// ── Confidence bar ────────────────────────────────────────────────────────────

export function ConfBar({ value }) {
  const pct = value ?? 0;
  let color = '#57637e';
  if (pct >= 75) color = '#22c55e';
  else if (pct >= 50) color = '#f5c518';
  else if (pct >= 25) color = '#3b82f6';
  return (
    <div className="conf-wrap">
      <div className="conf-bar-bg">
        <div className="conf-bar" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="conf-text">{pct}%</span>
    </div>
  );
}

// ── Best Setup Card (legacy, kept for compatibility) ──────────────────────────

export function BestCard({ r, rank }) {
  const [copied, setCopied] = useState('');
  function handleCopy(type) {
    copyText(type === 'alert' ? alertText(r) : claudePrompt(r));
    setCopied(type);
    setTimeout(() => setCopied(''), 1500);
  }

  const forklaring = svForklaring(r);

  return (
    <div className={`best-card state-${r.state}`}>
      <div className="best-card-header">
        <div>
          {rank != null && (
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>#{rank} BÄSTA SETUP</div>
          )}
          <div className="best-symbol">
            {r.symbol}
            <NewSignalBadge symbol={r.symbol} />
          </div>
          <div style={{ marginTop: 4 }}><StateBadge state={r.state} /></div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {fmtPrice(r.price)}
          <div style={{ marginTop: 4 }}><DisplaySignalBadge result={r} /></div>
        </div>
      </div>
      <div className="best-v2-scores">
        <div className="best-v2-score-item">
          <span className="best-v2-score-label">Basbetyg</span>
          <NarrowScoreBadge score={r.narrowScore} />
        </div>
        <div className="best-v2-score-item">
          <span className="best-v2-score-label">Tradebetyg</span>
          <TradeScoreBadge score={r.tradeScore} />
        </div>
        <div className="best-v2-score-item">
          <span className="best-v2-score-label">Typ</span>
          <NarrowTypeBadge narrowType={r.narrowType} />
        </div>
      </div>
      <div className="best-stats">
        <div>SMA20: <span>{r.sma20 ?? '–'}</span></div>
        <div>SMA200: <span>{r.sma200 ?? '–'}</span></div>
        <div>Gap%: <span>{r.smaGapPct != null ? r.smaGapPct.toFixed(2) + '%' : '–'}</span></div>
        <div>RSI: <span>{r.rsi14 ?? '–'}</span></div>
        <div>ATR: <span>{r.atr14 ?? '–'}</span></div>
        <div>Var: <span>{r.positionLabelSv ?? (r.position != null ? (r.position >= 0 ? '+' + r.position : r.position) : '–')}</span></div>
        <div>Long ↑: <span style={{ color: 'var(--green)' }}>{r.longTrigger ?? '–'}</span></div>
        <div>Short ↓: <span style={{ color: 'var(--red)' }}>{r.shortTrigger ?? '–'}</span></div>
        <div>Inv. Long: <span>{r.invalidationLong ?? '–'}</span></div>
        <div>Inv. Short: <span>{r.invalidationShort ?? '–'}</span></div>
        <div>Mål Long: <span>{r.target1Long ?? '–'}</span></div>
        <div>Mål Short: <span>{r.target1Short ?? '–'}</span></div>
      </div>
      <ConfBar value={r.confidence} />
      {forklaring && (
        <div className="best-forklaring">{forklaring}</div>
      )}
      {r.reasonSv && r.reasonSv.length > 0 && (
        <ul className="best-reasons">
          {r.reasonSv.map((txt, i) => <li key={i}>{txt}</li>)}
        </ul>
      )}
      <div className="best-actions">
        <a className="btn btn-tv" href={tvLink(r.symbol)} target="_blank" rel="noopener noreferrer">
          📈 TradingView
        </a>
        <button className="btn btn-copy" onClick={() => handleCopy('alert')}>
          {copied === 'alert' ? '✓ Kopierat' : '📋 Alert'}
        </button>
        <button className="btn btn-copy" onClick={() => handleCopy('claude')}>
          {copied === 'claude' ? '✓ Kopierat' : '🤖 Claude'}
        </button>
      </div>
    </div>
  );
}

// ── Specialized badges ────────────────────────────────────────────────────────

export function TfsBadge({ tfs }) {
  if (!tfs || !tfs.active) return <span className="val-null">–</span>;
  const label = tfs.strength === 'super_wide' ? 'VÄLDIGT LÅNGT' : 'LÅNGT';
  return (
    <span className="badge badge-purple" title="Priset är för långt från SMA20 och SMA20 långt från SMA200 — jaga inte">
      {tfs.direction === 'bullish' ? '▲' : '▼'} {label}
    </span>
  );
}

export function ElephantBadge({ eb }) {
  if (!eb || !eb.active) return <span className="val-null">–</span>;
  const cls = eb.direction === 'bullish' ? 'badge-elephant-bull' : 'badge-elephant-bear';
  const dir = eb.direction === 'bullish' ? '▲ Uppåt' : '▼ Nedåt';
  return (
    <span className={`badge ${cls}`} title="Ovanligt stor candle jämfört med senaste 20 candles">
      🐘 {dir} {eb.rangeMultiple}x
    </span>
  );
}

export function ScoreBadge({ score, label }) {
  if (score == null) return <span className="val-null">–</span>;
  const svLabel = label === 'Strong' ? 'Stark' : label === 'Watch' ? 'Bevaka' : label === 'Weak' ? 'Svag' : 'Undvik';
  const cls = label === 'Strong' ? 'score-strong' : label === 'Watch' ? 'score-watch' : label === 'Weak' ? 'score-weak' : 'score-avoid';
  return <span className={`score-badge ${cls}`}>{score} <span className="score-label">{svLabel}</span></span>;
}

export function NarrowScoreBadge({ score }) {
  if (score == null) return <span className="val-null">–</span>;
  const cls = score >= 80 ? 'score-strong' : score >= 60 ? 'score-watch' : score >= 30 ? 'score-weak' : 'score-avoid';
  return <span className={`score-badge ${cls}`} title="Basbetyg — hur bra narrow state-zonen är (0–100)">{score}</span>;
}

export function TradeScoreBadge({ score }) {
  if (score == null) return <span className="val-null">–</span>;
  const cls = score >= 60 ? 'score-strong' : score >= 35 ? 'score-watch' : score >= 15 ? 'score-weak' : 'score-avoid';
  return <span className={`score-badge ${cls}`} title="Tradebetyg — om det finns bra entry just nu (0–100)">{score}</span>;
}

export function NarrowTypeBadge({ narrowType }) {
  if (!narrowType || narrowType === 'none') return <span className="val-null">–</span>;
  if (narrowType === 'coil_flat')  return <span className="badge badge-yellow" title="Coil/Flat — båda SMAs är flacka, klassisk fjäder-setup">Coil</span>;
  if (narrowType === 'attack_200') return <span className="badge badge-blue"   title="Attack 200 — SMA20 rör sig mot SMA200, möjlig kollision">A200</span>;
  return <span className="val-null">–</span>;
}

export function EventBadge({ eventType }) {
  if (!eventType || eventType === 'NO_TRADE') return <span className="val-null">–</span>;
  const map = {
    NARROW_WAIT:                'badge-yellow',
    BULLISH_ELEPHANT_BREAKOUT:  'badge-green',
    BEARISH_ELEPHANT_BREAKDOWN: 'badge-red',
    BULLISH_COLOR_CHANGE:       'badge-green',
    BEARISH_COLOR_CHANGE:       'badge-red',
    REGULAR_PULLBACK:           'badge-blue',
    THREE_FINGER_SPREAD_AVOID:  'badge-purple',
    WIDE_REVERSAL_WATCH:        'badge-orange',
    BREAKOUT_ALREADY_OCCURRED:  'badge-orange',
  };
  const short = {
    NARROW_WAIT:                '🟡 Vänta breakout',
    BULLISH_ELEPHANT_BREAKOUT:  '🟢 Grön candle',
    BEARISH_ELEPHANT_BREAKDOWN: '🔴 Röd candle',
    BULLISH_COLOR_CHANGE:       '🟢 Färgbyte upp',
    BEARISH_COLOR_CHANGE:       '🔴 Färgbyte ned',
    REGULAR_PULLBACK:           '→ Trend',
    THREE_FINGER_SPREAD_AVOID:  '⚠️ Jaga ej',
    WIDE_REVERSAL_WATCH:        'Reversal',
    BREAKOUT_ALREADY_OCCURRED:  '🚀 Redan brutet',
  };
  return (
    <span className={`badge ${map[eventType] || 'badge-gray'}`} title={svEventType(eventType)}>
      {short[eventType] || eventType}
    </span>
  );
}

export function ColorChangeBadge({ cc }) {
  if (!cc || !cc.active) return <span className="val-null">–</span>;
  const cls = cc.direction === 'bullish' ? 'badge-green' : 'badge-red';
  const label = cc.direction === 'bullish' ? '↑ Färgbyte upp' : '↓ Färgbyte ned';
  return <span className={`badge ${cls}`} title="Candle-färgbyte i narrow-zon">{label}</span>;
}

// ── Symbol Table (legacy) ─────────────────────────────────────────────────────

function SymbolRow({ r }) {
  const [copied, setCopied] = useState('');
  function handleCopy(type) {
    copyText(type === 'alert' ? alertText(r) : claudePrompt(r));
    setCopied(type);
    setTimeout(() => setCopied(''), 1500);
  }

  const forklaring = svForklaring(r);

  return (
    <tr>
      <td>
        <span className="sym">{r.symbol}</span>
        <NewSignalBadge symbol={r.symbol} />
      </td>
      <td>{fmtPrice(r.price)}</td>
      <td><StateBadge state={r.state} /></td>
      <td title={r.positionCode ?? ''}>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{r.positionLabelSv ?? fmtPos(r.position)}</span>
      </td>
      <td><DisplaySignalBadge result={r} /></td>
      <td><EventBadge eventType={r.eventType} /></td>
      <td><TfsBadge tfs={r.threeFingerSpread} /></td>
      <td><ElephantBadge eb={r.elephantBar} /></td>
      <td><NarrowTypeBadge narrowType={r.narrowType} /></td>
      <td><NarrowScoreBadge score={r.narrowScore} /></td>
      <td><TradeScoreBadge score={r.tradeScore} /></td>
      <td className="mono">{fmt(r.sma20)}</td>
      <td className="mono">{fmt(r.sma200)}</td>
      <td className="mono">
        {r.smaGapPct != null
          ? <span className="val-ok">{r.smaGapPct.toFixed(2)}%</span>
          : <span className="val-null">–</span>}
      </td>
      <td className="mono">{fmt(r.rsi14, 1)}</td>
      <td className="mono">{fmt(r.atr14, 3)}</td>
      <td className="mono">
        {r.longTrigger != null
          ? <span style={{ color: 'var(--green)' }}>{r.longTrigger}</span>
          : <span className="val-null">–</span>}
      </td>
      <td className="mono">
        {r.shortTrigger != null
          ? <span style={{ color: 'var(--red)' }}>{r.shortTrigger}</span>
          : <span className="val-null">–</span>}
      </td>
      <td><ConfBar value={r.confidence} /></td>
      <td className="note-cell" title={r.reasonSv ? r.reasonSv.join(' | ') : forklaring}>{forklaring || (r.note || '')}</td>
      <td>
        <div className="actions-cell">
          <a className="btn btn-tv" href={tvLink(r.symbol)} target="_blank" rel="noopener noreferrer">TV</a>
          <button className="btn btn-copy" onClick={() => handleCopy('alert')} title="Kopiera alert">
            {copied === 'alert' ? '✓' : '📋'}
          </button>
          <button className="btn btn-copy" onClick={() => handleCopy('claude')} title="Kopiera Claude-prompt">
            {copied === 'claude' ? '✓' : '🤖'}
          </button>
        </div>
      </td>
    </tr>
  );
}

export function SymbolTable({ rows }) {
  if (!rows || rows.length === 0) {
    return <div className="empty">Inga symboler i denna kategori.</div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Pris</th>
            <th>Läge</th>
            <th>Position</th>
            <th>Signal</th>
            <th>Händelse</th>
            <th title="För långt ifrån — jaga inte entry">För långt</th>
            <th title="Ovanligt stor candle jämfört med senaste 20">Stor candle</th>
            <th title="Narrow-typ: Coil/Flat eller Attack 200">Typ</th>
            <th title="Basbetyg — hur bra narrow state-zonen är (0–100)">Basbetyg</th>
            <th title="Tradebetyg — om det finns bra entry just nu (0–100)">Tradebetyg</th>
            <th>SMA20</th><th>SMA200</th><th>SMA Gap%</th><th>RSI</th>
            <th title="ATR visar hur långt priset är från linjerna jämfört med normal rörelse.">ATR</th>
            <th>Long ↑</th><th>Short ↓</th>
            <th>Säkerhet</th>
            <th>Vad betyder det?</th>
            <th>Länk</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => <SymbolRow key={r.symbol} r={r} />)}
        </tbody>
      </table>
    </div>
  );
}

// ── Active Signals (legacy) ───────────────────────────────────────────────────

function ActiveSignalRow({ r }) {
  const [copied, setCopied] = useState('');
  return (
    <tr>
      <td>
        <span className="sym">{r.symbol}</span>
        <NewSignalBadge symbol={r.symbol} />
      </td>
      <td>{fmtPrice(r.price)}</td>
      <td><DisplaySignalBadge result={r} /></td>
      <td><StateBadge state={r.state} /></td>
      <td><EventBadge eventType={r.eventType} /></td>
      <td><ScoreBadge score={r.signalScore} label={r.scoreLabel} /></td>
      <td className="mono">{r.longTrigger != null ? <span style={{ color: 'var(--green)' }}>{r.longTrigger}</span> : <span className="val-null">–</span>}</td>
      <td className="mono">{r.shortTrigger != null ? <span style={{ color: 'var(--red)' }}>{r.shortTrigger}</span> : <span className="val-null">–</span>}</td>
      <td>
        <div className="actions-cell">
          <a className="btn btn-tv" href={tvLink(r.symbol)} target="_blank" rel="noopener noreferrer">TV</a>
          <button className="btn btn-copy" onClick={() => { copyText(claudePrompt(r)); setCopied('y'); setTimeout(() => setCopied(''), 1500); }} title="Kopiera Claude-prompt">
            {copied ? '✓' : '🤖'}
          </button>
        </div>
      </td>
    </tr>
  );
}

export function ActiveSignals({ results }) {
  const active = results.filter((r) =>
    ['LONG_TRIGGERED', 'SHORT_TRIGGERED', 'LONG_WATCH', 'SHORT_WATCH', 'WIDE_REVERSAL_WATCH'].includes(r.signal) &&
    !['WIDE_AVOID', 'THREE_FINGER_SPREAD_AVOID'].includes(r.state) &&
    !(r.threeFingerSpread?.active)
  );
  if (active.length === 0) return <div className="empty">Inga aktiva signaler just nu.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Symbol</th><th>Pris</th><th>Signal</th><th>Läge</th>
            <th>Händelse</th><th>Betyg</th><th>Long ↑</th><th>Short ↓</th><th>Länk</th>
          </tr>
        </thead>
        <tbody>{active.map((r) => <ActiveSignalRow key={r.symbol} r={r} />)}</tbody>
      </table>
    </div>
  );
}

// ── Elephant Bars (legacy) ────────────────────────────────────────────────────

export function ElephantSection({ results }) {
  const elephants = results.filter((r) => r.elephantBar?.active);
  if (elephants.length === 0) return <div className="empty">Inga stora kraftiga candles detekterade.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Symbol</th><th>Pris</th><th>Riktning</th>
            <th>Storlek (x medel)</th><th>Kropp %</th><th>Stängning</th>
            <th>Signal</th><th>Länk</th>
          </tr>
        </thead>
        <tbody>
          {elephants.map((r) => {
            const eb = r.elephantBar;
            return (
              <tr key={r.symbol} className={eb.direction === 'bullish' ? 'row-elephant-bull' : 'row-elephant-bear'}>
                <td><span className="sym">{r.symbol}</span></td>
                <td>{fmtPrice(r.price)}</td>
                <td><ElephantBadge eb={eb} /></td>
                <td className="mono"><span className="val-ok">{eb.rangeMultiple}x</span></td>
                <td className="mono"><span className="val-ok">{eb.bodyPercent != null ? (eb.bodyPercent * 100).toFixed(0) + '%' : '–'}</span></td>
                <td><span className="badge badge-gray">{eb.closeQuality}</span></td>
                <td><SignalBadge signal={r.signal} /></td>
                <td><a className="btn btn-tv" href={tvLink(r.symbol)} target="_blank" rel="noopener noreferrer">TV</a></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── 3 Finger Spread (legacy) ──────────────────────────────────────────────────

export function ThreeFingerSection({ results }) {
  const spread = results.filter((r) => r.threeFingerSpread?.active);
  if (spread.length === 0) return <div className="empty">Inga symboler för långt ifrån just nu.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Symbol</th><th>Pris</th><th>Riktning</th><th>Hur långt ifrån</th>
            <th>Avstånd från SMA20</th><th>Avstånd SMA20→SMA200</th><th>Vad betyder det?</th>
          </tr>
        </thead>
        <tbody>
          {spread.map((r) => {
            const tfs = r.threeFingerSpread;
            return (
              <tr key={r.symbol} className="row-tfs">
                <td><span className="sym">{r.symbol}</span></td>
                <td>{fmtPrice(r.price)}</td>
                <td><span className="badge badge-purple">{svRiktning(tfs.direction)}</span></td>
                <td><span className={`badge ${tfs.strength === 'super_wide' ? 'badge-red' : 'badge-purple'}`}>{svStyrka(tfs.strength)}</span></td>
                <td className="mono"><span className="val-ok">{tfs.priceToSma20Atr}x ATR</span></td>
                <td className="mono"><span className="val-ok">{tfs.sma20ToSma200Atr}x ATR</span></td>
                <td className="note-cell" style={{ color: 'var(--purple)' }}>{svForklaring(r)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── QQQ Status Panel (legacy) ─────────────────────────────────────────────────

export function QQQStatus({ data }) {
  if (!data) return null;
  return (
    <div className="qqq-status">
      <div className="qqq-status-item">
        <span className="qqq-label">Symbol</span>
        <span className="qqq-val">{data.symbol}</span>
      </div>
      <div className="qqq-status-item">
        <span className="qqq-label">Pris</span>
        <span className="qqq-val mono">{data.price != null ? `$${Number(data.price).toFixed(2)}` : '–'}</span>
      </div>
      <div className="qqq-status-item">
        <span className="qqq-label">Läge</span>
        <StateBadge state={data.state} />
      </div>
      <div className="qqq-status-item">
        <span className="qqq-label">Signal</span>
        <SignalBadge signal={data.signal} />
      </div>
      <div className="qqq-status-item">
        <span className="qqq-label">Long ↑</span>
        <span className="qqq-val mono green">{data.longTrigger ?? '–'}</span>
      </div>
      <div className="qqq-status-item">
        <span className="qqq-label">Short ↓</span>
        <span className="qqq-val mono red">{data.shortTrigger ?? '–'}</span>
      </div>
      <div className="qqq-status-item">
        <span className="qqq-label">RSI</span>
        <span className="qqq-val mono">{data.rsi14 != null ? Number(data.rsi14).toFixed(1) : '–'}</span>
      </div>
      <div className="qqq-status-item">
        <span className="qqq-label">ATR</span>
        <span className="qqq-val mono">{data.atr14 != null ? Number(data.atr14).toFixed(3) : '–'}</span>
      </div>
    </div>
  );
}

// ── Page Status Bar (legacy) ──────────────────────────────────────────────────

export function PageStatusBar({ health, data, lastFetch, onRefresh }) {
  const alpacaOk = health?.alpacaConfigured ?? false;
  const scanning = data?.scanning ?? false;
  return (
    <div className="status-bar">
      <span>
        <span className={`dot ${alpacaOk ? 'dot-green' : 'dot-red'}`} />
        Alpaca: {alpacaOk ? 'OK' : 'FEL'}
      </span>
      <span>
        <span className={`dot ${scanning ? 'dot-yellow' : 'dot-green'}`} />
        {scanning ? <><span className="spinner" /> Skannar…</> : 'Klar'}
      </span>
      <span>Senast scan: {fmtTime(data?.lastScan)}</span>
      <span>Uppdaterad: {fmtTime(lastFetch?.toISOString())}</span>
      <span style={{ color: 'var(--muted)' }}>Källa: {health?.feed || 'iex'}</span>
      <button className="btn" onClick={onRefresh} style={{ fontSize: 11 }}>↻ Uppdatera</button>
    </div>
  );
}

// ── Breakout Section (legacy) ─────────────────────────────────────────────────

export function BreakoutSection({ results }) {
  const breakouts = results.filter((r) => r.breakoutAlreadyOccurred);
  if (breakouts.length === 0) return null;
  return (
    <div className="section">
      <div className="section-title">🚀 Utbrottet har redan hänt ({breakouts.length})</div>
      <div className="section-desc" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, padding: '0 4px' }}>
        De här kan ha varit bra tidigare, men priset har redan lämnat zonen. Vänta på pullback och ny setup.
      </div>
      <SymbolTable rows={breakouts} />
    </div>
  );
}

// ── Guide Box (legacy) ────────────────────────────────────────────────────────

export function GuideBox() {
  const [open, setOpen] = useState(false);
  return (
    <div className="guide-box">
      <button className="guide-toggle" onClick={() => setOpen((o) => !o)}>
        💡 Så läser du sidan {open ? '▲' : '▼'}
      </button>
      {open && (
        <ul className="guide-list">
          <li><strong>⚡ Narrow state</strong> = priset är ihoptryckt nära SMA20 och SMA200. Bra läge att vänta på breakout.</li>
          <li><strong>🟡 Vänta</strong> = ingen trade ännu. Håll koll och vänta på signal.</li>
          <li><strong>⚠️ För långt ifrån</strong> = priset har redan sprungit iväg. Jaga inte — vänta på bättre läge.</li>
          <li><strong>🐘 Stor kraftig candle</strong> = ovanligt stor candle som kan visa starkt momentum.</li>
          <li><strong>📊 Basbetyg</strong> = hur bra narrow state-zonen är (0–100).</li>
          <li><strong>📊 Tradebetyg</strong> = om det finns ett bra entryläge just nu (0–100).</li>
          <li><strong>Coil</strong> = båda SMAs är flacka — klassisk fjäder-setup. <strong>A200</strong> = SMA20 rör sig mot SMA200.</li>
          <li><strong>🚀 Redan brutet</strong> = utbrottet har redan hänt. Jaga inte priset.</li>
          <li><strong>🟢 Long</strong> = möjlig köpsignal. <strong>🔴 Short</strong> = möjlig säljsignal.</li>
        </ul>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW PREMIUM COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── ScoreMeter ────────────────────────────────────────────────────────────────

export function ScoreMeter({ score }) {
  const pct = Math.min(100, Math.max(0, score ?? 0));
  let color, tag;
  if (pct >= 60) { color = 'var(--green)'; tag = 'Starkt'; }
  else if (pct >= 35) { color = 'var(--yellow)'; tag = 'Bevaka'; }
  else if (pct >= 15) { color = 'var(--blue)'; tag = 'Svagt'; }
  else { color = 'var(--muted)'; tag = 'Undvik'; }
  return (
    <div className="score-meter">
      <div className="score-meter-track">
        <div className="score-meter-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="score-meter-num" style={{ color }}>{pct}</span>
      <span className="score-meter-tag">{tag}</span>
    </div>
  );
}

// ── HealthChips ───────────────────────────────────────────────────────────────

function Chip({ label, value, mode }) {
  const cls = mode === 'good' ? 'chip-good' : mode === 'bad' ? 'chip-bad' : mode === 'warn' ? 'chip-warn' : '';
  return (
    <div className={`health-chip ${cls}`}>
      <span className="chip-label">{label}</span>
      <span className="chip-value">{value}</span>
    </div>
  );
}

export function HealthChips({ r }) {
  const mdir = r.marketDirection;
  const trendMode = mdir === 'bullish' ? 'good' : mdir === 'bearish' ? 'bad' : '';
  const trendVal  = mdir === 'bullish' ? '↑ Uppåt' : mdir === 'bearish' ? '↓ Nedåt' : '→ Neutral';

  const ptz = r.priceToZoneAtr;
  const posVal  = ptz == null ? '–' : ptz <= 0.5 ? 'I zonen' : ptz <= 1.0 ? 'Nära' : ptz <= 2.0 ? 'Långt' : 'Väldigt långt';
  const posMode = ptz == null ? '' : ptz <= 0.5 ? 'good' : ptz > 2.0 ? 'bad' : 'warn';

  const tfs = r.threeFingerSpread?.active;
  const riskBad = tfs || r.state === 'WIDE_AVOID' || r.state === 'THREE_FINGER_SPREAD_AVOID';
  const riskVal = riskBad ? 'Hög' : 'Låg';

  const sig = r.signal;
  const timingGood = sig === 'LONG_TRIGGERED' || sig === 'SHORT_TRIGGERED';
  const timingWarn = sig === 'LONG_WATCH' || sig === 'SHORT_WATCH';
  const timingVal  = timingGood ? 'Nu' : timingWarn ? 'Snart' : 'Vänta';

  return (
    <div className="health-chips">
      <Chip label="Trend"    value={trendVal}  mode={trendMode} />
      <Chip label="Position" value={posVal}    mode={posMode} />
      <Chip label="Risk"     value={riskVal}   mode={riskBad ? 'bad' : 'good'} />
      <Chip label="Timing"   value={timingVal} mode={timingGood ? 'good' : timingWarn ? 'warn' : ''} />
    </div>
  );
}

// ── WhyBox ────────────────────────────────────────────────────────────────────

export function WhyBox({ r }) {
  const expl = r?.scoreExplanationSv;
  if (!expl || expl.length === 0) return null;
  return (
    <div className="why-box">
      <div className="why-box-title">💡 Varför säger systemet så?</div>
      <ul className="why-list">
        {expl.map((e, i) => <li key={i}>{e}</li>)}
      </ul>
    </div>
  );
}

// ── MarketRegimeBadge ─────────────────────────────────────────────────────────

export function MarketRegimeBadge({ regime, score }) {
  if (!regime || regime === 'UNKNOWN') return null;
  const map = {
    BULLISH:   { icon: '📈', label: 'Marknaden är stark' },
    BEARISH:   { icon: '📉', label: 'Marknaden är svag' },
    CHOPPY:    { icon: '↔️', label: 'Marknaden är stökig' },
    HIGH_RISK: { icon: '⚠️', label: 'Marknaden har hög risk' },
  };
  const m = map[regime] || { icon: '?', label: regime };
  const tooltip = score != null ? `Marknadsbetyg: ${score} av 100` : undefined;
  return (
    <span className={`regime-badge regime-${regime}`} title={tooltip}>
      {m.icon} {m.label}
    </span>
  );
}

// ── SummaryStrip ──────────────────────────────────────────────────────────────

function isAvoidResult(r) {
  return ['WIDE_AVOID', 'THREE_FINGER_SPREAD_AVOID', 'NO_TRADE', 'BREAKOUT_ALREADY_OCCURRED'].includes(r.state)
    || r.threeFingerSpread?.active || r.breakoutAlreadyOccurred || r.autoFilter?.blocked;
}

export function SummaryStrip({ results }) {
  const best  = results.filter(r => !isAvoidResult(r) && (r.tradeScore ?? 0) >= 60).length;
  const near  = results.filter(r => !isAvoidResult(r) && (r.tradeScore ?? 0) >= 30 && (r.tradeScore ?? 0) < 60).length;
  const wait  = results.filter(r => !isAvoidResult(r) && (r.tradeScore ?? 0) < 30).length;
  const avoid = results.filter(isAvoidResult).length;
  return (
    <div className="summary-strip">
      <div className="sum-card sum-green">
        <div className="sum-card-icon">⚡</div>
        <div className="sum-card-count">{best}</div>
        <div className="sum-card-label">Bästa läget</div>
      </div>
      <div className="sum-card sum-yellow">
        <div className="sum-card-icon">🎯</div>
        <div className="sum-card-count">{near}</div>
        <div className="sum-card-label">Nära setup</div>
      </div>
      <div className="sum-card sum-blue">
        <div className="sum-card-icon">⏳</div>
        <div className="sum-card-count">{wait}</div>
        <div className="sum-card-label">Väntar</div>
      </div>
      <div className="sum-card sum-muted">
        <div className="sum-card-icon">⛔</div>
        <div className="sum-card-count">{avoid}</div>
        <div className="sum-card-label">Undvik</div>
      </div>
    </div>
  );
}

// ── SymbolCard ────────────────────────────────────────────────────────────────

export function SymbolCard({ r, tvLinkFn }) {
  const [open, setOpen] = useState(false);
  const desc = svForklaring(r) || r.actionSv || '';
  const link = tvLinkFn ? tvLinkFn(r.symbol) : tvLink(r.symbol);
  const isBlocked = r.autoFilter?.blocked;
  const confLabel = r.confidence?.label;
  const before = r.tradeScoreBeforeConfidence;
  const after  = r.tradeScore;

  return (
    <div className={`symbol-card${isBlocked ? ' symbol-card-blocked' : ''}`}>
      {isBlocked && <AutoFilterBanner autoFilter={r.autoFilter} />}
      <div className="symbol-card-top">
        <div className="symbol-card-left">
          <div className="symbol-card-badges">
            <span className="sym-name">{r.symbol}</span>
            {confLabel && <ConfidenceLabelBadge label={confLabel} />}
            <NewSignalBadge symbol={r.symbol} />
          </div>
          <DisplaySignalBadge result={r} />
        </div>
        <div className="symbol-card-right">
          <div className="symbol-card-price">{r.price != null ? `$${Number(r.price).toFixed(2)}` : '–'}</div>
          <MarketRegimeBadge regime={r.marketRegime} score={r.marketScore} />
        </div>
      </div>
      <ScoreMeter score={after} />
      {before != null && before !== after && (
        <div className="conf-score-delta">
          Före historik: <strong>{before}</strong> → Efter filter: <strong>{after}</strong>
        </div>
      )}
      {desc && <div className="symbol-card-desc">{desc}</div>}
      <div className="symbol-card-footer">
        <HealthChips r={r} />
        <div className="symbol-card-actions">
          <a className="btn btn-tv" href={link} target="_blank" rel="noopener noreferrer">📈 TradingView</a>
          <button className="btn" onClick={() => setOpen(o => !o)} style={{ fontSize: 11 }}>
            {open ? 'Mindre ▲' : 'Mer ▼'}
          </button>
        </div>
      </div>
      {open && (
        <div className="symbol-card-detail">
          <WhyBox r={r} />
          <ConfidencePanel r={r} />
          <AdaptiveEdgePanel r={r} />
          <SetupDNAPanel r={r} />
          <div className="symbol-card-stats">
            {r.sma20    != null && <div className="stat-row">SMA20  <span>{Number(r.sma20).toFixed(2)}</span></div>}
            {r.sma200   != null && <div className="stat-row">SMA200 <span>{Number(r.sma200).toFixed(2)}</span></div>}
            {r.rsi14    != null && <div className="stat-row">RSI    <span>{Number(r.rsi14).toFixed(1)}</span></div>}
            {r.atr14    != null && <div className="stat-row">ATR    <span>{Number(r.atr14).toFixed(3)}</span></div>}
            {r.longTrigger  != null && <div className="stat-row">Om priset går över <span className="s-green">{r.longTrigger}</span></div>}
            {r.shortTrigger != null && <div className="stat-row">Om priset går under <span className="s-red">{r.shortTrigger}</span></div>}
            {r.narrowScore  != null && <div className="stat-row">Basbetyg <span>{r.narrowScore}</span></div>}
            {r.narrowType && r.narrowType !== 'none' && <div className="stat-row">Typ <span>{r.narrowType === 'coil_flat' ? 'Coil/Flat' : 'Attack 200'}</span></div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── SymbolCardList ────────────────────────────────────────────────────────────

export function SymbolCardList({ rows, tvLinkFn }) {
  if (!rows || rows.length === 0) return (
    <div className="no-data-banner">
      <strong>Inga symboler</strong>
      Inga symboler i den här kategorin just nu.
    </div>
  );
  return (
    <div className="symbol-cards">
      {rows.map(r => <SymbolCard key={r.symbol} r={r} tvLinkFn={tvLinkFn} />)}
    </div>
  );
}

// ── SectionHeader ─────────────────────────────────────────────────────────────

export function SectionHeader({ icon, title, count, desc }) {
  return (
    <div className="sec-head">
      <div className="sec-title">
        {icon && <span>{icon}</span>}
        <span>{title}</span>
        {count != null && <span className="sec-count">{count}</span>}
      </div>
      {desc && <div className="sec-desc">{desc}</div>}
    </div>
  );
}

// ── PageStatusBarV2 ───────────────────────────────────────────────────────────

export function PageStatusBarV2({ health, data, lastFetch, onRefresh, liveLabel }) {
  const alpacaOk = health?.alpacaConfigured ?? true;
  const scanning = data?.scanning ?? false;
  return (
    <div className="status-bar-v2">
      <span className={`status-pill ${alpacaOk ? 's-ok' : ''}`}>
        <span className="dot" />
        {alpacaOk ? 'Ansluten' : 'Fel'}
      </span>
      <span className={`status-pill ${scanning ? 's-scan' : 's-ok'}`}>
        {scanning
          ? <><span className="spinner" style={{ width: 10, height: 10 }} /> Skannar</>
          : <><span className="dot" />Klar</>}
      </span>
      {data?.lastScan && (
        <span className="status-pill">⏱ {fmtTime(data.lastScan)}</span>
      )}
      {liveLabel && (
        <span className="status-pill" style={{ color: 'var(--orange)' }}>🔄 {liveLabel}</span>
      )}
      <button className="btn" onClick={onRefresh} style={{ fontSize: 11, padding: '3px 10px' }}>↻ Uppdatera</button>
    </div>
  );
}

// ── GuideBoxV2 ────────────────────────────────────────────────────────────────

export function GuideBoxV2() {
  const [open, setOpen] = useState(false);
  const items = [
    { icon: '⚡', title: 'Bästa läge (60+)', desc: 'Betyg 60+. Priset är ihoptryckt och systemet ser en tydlig signal.' },
    { icon: '🟢', title: 'Möjlig uppgång', desc: 'Systemet ser potential för uppgång. Bevaka om priset bryter triggen.' },
    { icon: '🔴', title: 'Möjlig nedgång', desc: 'Systemet ser potential för nedgång. Bevaka om priset bryter triggen.' },
    { icon: '🟠', title: 'Svag signal', desc: 'Det finns en riktning men bekräftelsen saknas. Vänta på bättre setup.' },
    { icon: '⚠️', title: 'Jaga inte', desc: 'Priset har redan sprungit iväg. Det är för sent att gå in nu.' },
    { icon: '📊', title: 'Betyg 0–100', desc: 'Hur starkt läget är. Grön = 60+, Gul = 30–60, Röd = under 30.' },
    { icon: '📈', title: 'Marknadsläge', desc: 'Visar om den bredare marknaden stödjer eller motarbetar signalen.' },
    { icon: '⏳', title: 'Vänta', desc: 'Ingen tydlig signal just nu. Håll koll och kom tillbaka.' },
  ];
  return (
    <div className="guide-v2">
      <button className="guide-v2-toggle" onClick={() => setOpen(o => !o)}>
        <span className="guide-v2-toggle-left">💡 <span>Hur läser jag sidan?</span></span>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{open ? '▲ Dölj' : '▼ Visa'}</span>
      </button>
      {open && (
        <div className="guide-v2-body">
          {items.map((item, i) => (
            <div key={i} className="guide-item">
              <div className="guide-item-icon">{item.icon}</div>
              <div className="guide-item-title">{item.title}</div>
              <div className="guide-item-desc">{item.desc}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── HeroSignalCard ────────────────────────────────────────────────────────────

export function HeroSignalCard({ r, tvLinkFn }) {
  if (!r || r.autoFilter?.blocked) return null;

  const link     = tvLinkFn ? tvLinkFn(r.symbol) : tvLink(r.symbol);
  const ds       = getDisplaySignal(r);
  const isLong   = ds === 'LONG_TRIG'  || ds === 'LONG_VAKA'  || ds === 'SVAG_LONG';
  const isShort  = ds === 'SHORT_TRIG' || ds === 'SHORT_VAKA' || ds === 'SVAG_SHORT';
  const variant  = isLong ? 'hs-long' : isShort ? 'hs-short' : 'hs-neutral';

  const confLabel = r.confidence?.label;
  const before    = r.tradeScoreBeforeConfidence;
  const after     = r.tradeScore;
  const desc      = r.actionSv || svForklaring(r) || '';
  const whyItems  = (r.scoreExplanationSv || []).slice(0, 3);

  return (
    <div className={`hero-sig-wrap ${variant}`}>
      <div className="hero-sig-glow" />
      <div className="hero-sig">

        {/* Header */}
        <div className="hero-sig-head">
          <div>
            <div className="hero-sig-tag">⚡ Bästa signal just nu</div>
            <div className="hero-sig-symbol">
              {r.symbol}
              <NewSignalBadge symbol={r.symbol} />
            </div>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginTop:10 }}>
              {confLabel && <ConfidenceLabelBadge label={confLabel} />}
              <DisplaySignalBadge result={r} />
              <MarketRegimeBadge regime={r.marketRegimeV2 || r.marketRegime} />
            </div>
          </div>
          <div className="hero-sig-price">
            {r.price != null ? `$${Number(r.price).toFixed(2)}` : '–'}
          </div>
        </div>

        {/* Score ring + meta */}
        <div className="hero-sig-body">
          <div className="hero-sig-ring-wrap">
            <div className="hero-sig-ring">
              <div className="hero-sig-score">{after}</div>
              <div className="hero-sig-score-sub">poäng</div>
            </div>
          </div>
          <div className="hero-sig-meta">
            {before != null && before !== after && (
              <div className="conf-score-delta">
                Före historik: <strong>{before}</strong> → Efter filter: <strong>{after}</strong>
              </div>
            )}
            <div className="hero-sig-callout">Motorn gillar detta läge bäst just nu</div>
            {desc && <div className="hero-sig-desc">{desc}</div>}
          </div>
        </div>

        {/* Why bullets */}
        {whyItems.length > 0 && (
          <div className="hero-sig-why">
            {whyItems.map((e, i) => <div key={i} className="hero-sig-why-item">· {e}</div>)}
          </div>
        )}

        {/* Triggers */}
        {(r.longTrigger != null || r.shortTrigger != null) && (
          <div className="hero-sig-triggers">
            {r.longTrigger != null && (
              <div className="hero-sig-trigger hero-sig-t-long">
                <span className="hero-sig-trigger-label">Om priset går över</span>
                <span className="hero-sig-trigger-val">${r.longTrigger}</span>
              </div>
            )}
            {r.shortTrigger != null && (
              <div className="hero-sig-trigger hero-sig-t-short">
                <span className="hero-sig-trigger-label">Om priset går under</span>
                <span className="hero-sig-trigger-val">${r.shortTrigger}</span>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="hero-sig-footer">
          <a className="btn btn-tv" href={link} target="_blank" rel="noopener noreferrer">📈 TradingView</a>
        </div>

      </div>
    </div>
  );
}

// ── ConfidenceLabelBadge ──────────────────────────────────────────────────────

export function ConfidenceLabelBadge({ label }) {
  if (!label) return null;
  const cls = {
    'Mycket stark': 'clf-best',
    'Stark':        'clf-strong',
    'Bevaka':       'clf-watch',
    'Svag':         'clf-weak',
    'Blockerad':    'clf-blocked',
  }[label] || 'clf-weak';
  return <span className={`conf-label ${cls}`}>{label}</span>;
}

// ── AutoFilterBanner ──────────────────────────────────────────────────────────

export function AutoFilterBanner({ autoFilter }) {
  if (!autoFilter?.blocked) return null;
  return (
    <div className="af-banner">
      <span className="af-banner-icon">⚠</span>
      <div>
        <div className="af-banner-title">Motorn blockerar detta läge</div>
        {autoFilter.reasonSv && <div className="af-banner-reason">{autoFilter.reasonSv}</div>}
      </div>
    </div>
  );
}

// ── SetupDNAPanel ─────────────────────────────────────────────────────────────

const REGIME_SHORT = {
  BULLISH_TREND:  'Upptrend',   BEARISH_TREND:   'Nedtrend',
  TREND_DAY_UP:   'Trenddag ↑', TREND_DAY_DOWN:  'Trenddag ↓',
  CHOPPY:         'Stökig',     RANGE_DAY:       'Sidleds',
  HIGH_VOLATILITY:'Hög vol.',   PANIC:           'Panik',
  UNKNOWN:        'Okänd',
};

function fmtMovePct(v) {
  if (v == null) return '–';
  const pct = (v * 100).toFixed(2);
  return v >= 0 ? `+${pct}%` : `${pct}%`;
}

function fmtWinRate(v) {
  if (v == null) return '–';
  return `${Math.round(v * 100)}%`;
}

export function SetupDNAPanel({ r }) {
  const [showMatches, setShowMatches] = React.useState(false);
  const dna = r?.setupDNA;
  if (!dna || !dna.enabled) return null;

  const {
    similarityScore, matchedSetups, winRate,
    avgMove, avgFailMove, strongestFactors = [], weakestFactors = [],
    historicalBias, summarySv, topMatches = [], adjustment,
  } = dna;

  let adjText, adjCls;
  if (adjustment > 0) {
    adjText = `Setup DNA höjer betyget med ${adjustment} poäng`;
    adjCls = 'dna-adj-pos';
  } else if (adjustment < 0) {
    adjText = `Setup DNA sänker betyget med ${Math.abs(adjustment)} poäng`;
    adjCls = 'dna-adj-neg';
  } else {
    adjText = 'Setup DNA påverkar inte betyget just nu';
    adjCls = 'dna-adj-neutral';
  }

  const biasIcon  = historicalBias === 'bullish' ? '↑' : historicalBias === 'bearish' ? '↓' : '→';
  const biasCls   = historicalBias === 'bullish' ? 'dna-bias-bull' : historicalBias === 'bearish' ? 'dna-bias-bear' : 'dna-bias-neutral';
  const biasLabel = historicalBias === 'bullish' ? 'Bullish historik' : historicalBias === 'bearish' ? 'Bearish historik' : 'Neutral historik';

  const winRatePct = winRate != null ? Math.round(winRate * 100) : null;
  const winRateColor = winRatePct == null ? '' : winRatePct >= 60 ? 'dna-stat-green' : winRatePct >= 50 ? 'dna-stat-yellow' : 'dna-stat-red';

  return (
    <div className="dna-panel">
      {/* Header */}
      <div className="dna-panel-header">
        <span className="dna-panel-title">🧬 Setup DNA</span>
        <div className="dna-panel-meta">
          <span className="dna-badge-sim" title="Genomsnittlig likhet hos matchande setups">
            Sim {similarityScore}
          </span>
          <span className="dna-badge-count">{matchedSetups} setups</span>
        </div>
      </div>

      {/* Stats row */}
      <div className="dna-stats">
        <div className="dna-stat">
          <span className="dna-stat-label">Träffsäkerhet</span>
          <span className={`dna-stat-val ${winRateColor}`}>{fmtWinRate(winRate)}</span>
        </div>
        <div className="dna-stat">
          <span className="dna-stat-label">Avg vinst</span>
          <span className="dna-stat-val dna-stat-green">{fmtMovePct(avgMove)}</span>
        </div>
        <div className="dna-stat">
          <span className="dna-stat-label">Avg förlust</span>
          <span className="dna-stat-val dna-stat-red">{fmtMovePct(avgFailMove)}</span>
        </div>
        <div className={`dna-stat dna-bias ${biasCls}`}>
          <span className="dna-stat-label">Historik</span>
          <span className="dna-stat-val">{biasIcon} {biasLabel}</span>
        </div>
      </div>

      {/* Adjustment */}
      <div className={`dna-adj ${adjCls}`}>{adjText}</div>

      {/* Factors */}
      {(strongestFactors.length > 0 || weakestFactors.length > 0) && (
        <div className="dna-factors">
          {strongestFactors.length > 0 && (
            <div className="dna-factor-group">
              <div className="dna-factor-title dna-factor-title-pos">✅ Starka matchningar</div>
              <div className="dna-chips">
                {strongestFactors.map((f, i) => (
                  <span key={i} className="dna-chip dna-chip-pos">{f}</span>
                ))}
              </div>
            </div>
          )}
          {weakestFactors.length > 0 && (
            <div className="dna-factor-group">
              <div className="dna-factor-title dna-factor-title-weak">◎ Svaga matchningar</div>
              <div className="dna-chips">
                {weakestFactors.map((f, i) => (
                  <span key={i} className="dna-chip dna-chip-weak">{f}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Top matches toggle */}
      {topMatches.length > 0 && (
        <div className="dna-matches-section">
          <button
            className="dna-matches-toggle"
            onClick={() => setShowMatches(s => !s)}
          >
            <span>📋 Liknande historiska setups ({topMatches.length})</span>
            <span className="dna-matches-chevron">{showMatches ? '▲' : '▼'}</span>
          </button>
          {showMatches && (
            <div className="dna-matches-list">
              {topMatches.slice(0, 8).map((m, i) => (
                <div key={i} className={`dna-match-row ${m.outcome ? 'dna-match-win' : 'dna-match-loss'}`}>
                  <span className="dna-match-outcome">{m.outcome ? '✓' : '✗'}</span>
                  <span className="dna-match-sym">{m.symbol}</span>
                  <span className="dna-match-date">{m.date}</span>
                  <span className="dna-match-sim">{m.similarity}%</span>
                  <span className={`dna-match-move ${m.movePct > 0 ? 'dna-stat-green' : m.movePct < 0 ? 'dna-stat-red' : ''}`}>
                    {fmtMovePct(m.movePct)}
                  </span>
                  <span className="dna-match-regime">{REGIME_SHORT[m.marketRegime] || m.marketRegime || '–'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Summary */}
      {summarySv && <div className="dna-summary">{summarySv}</div>}
    </div>
  );
}

// ── AdaptiveEdgePanel ─────────────────────────────────────────────────────────

const FACTOR_LABEL_SV = {
  symbol:                  'Symbolen har fungerat bra',
  eventType:               'Signaltypen har fungerat bra',
  scoreRange:              'Betygsnivån passar historiken',
  marketRegime:            'Marknadsläget påverkar',
  hour:                    'Tiden på dagen påverkar',
  relVolBucket:            'Volymen påverkar',
  priceToZoneBucket:       'Avståndet till zonen påverkar',
  threeFingerSpread:       'Three Finger Spread aktiv',
  breakoutAlreadyOccurred: 'Rörelsen har redan börjat',
};

function factorLabel(f) {
  return FACTOR_LABEL_SV[f.factor] || f.factor;
}

function aeConfidenceSv(level) {
  if (level === 'high')   return 'Hög historik';
  if (level === 'medium') return 'Medel historik';
  return 'Låg historik';
}

export function AdaptiveEdgePanel({ r }) {
  const ae = r?.adaptiveEdge;
  if (!ae || !ae.enabled) return null;

  const { confidence, edgeScore, adjustment, positiveFactors = [], negativeFactors = [], summarySv, sampleSize } = ae;
  const hasFactors = positiveFactors.length > 0 || negativeFactors.length > 0;

  let adjText, adjCls;
  if (adjustment > 0) {
    adjText = `Historiken höjer betyget med ${adjustment} poäng`;
    adjCls = 'ae-adj-pos';
  } else if (adjustment < 0) {
    adjText = `Historiken sänker betyget med ${Math.abs(adjustment)} poäng`;
    adjCls = 'ae-adj-neg';
  } else {
    adjText = 'Historiken ändrar inte betyget just nu';
    adjCls = 'ae-adj-neutral';
  }

  return (
    <div className="ae-panel">
      <div className="ae-panel-header">
        <span className="ae-panel-title">🧠 Adaptiv historik</span>
        <div className="ae-panel-meta">
          <span className={`ae-conf-badge ae-conf-${confidence}`}>{aeConfidenceSv(confidence)}</span>
          {edgeScore != null && (
            <span className="ae-edge-score" title={`Edge-styrka: ${edgeScore} av 100`}>
              Edge {edgeScore}
            </span>
          )}
          {sampleSize != null && (
            <span className="ae-samples">{sampleSize.toLocaleString('sv-SE')} signaler</span>
          )}
        </div>
      </div>

      <div className={`ae-adjustment ${adjCls}`}>{adjText}</div>

      {hasFactors && (
        <div className="ae-factors-wrap">
          {positiveFactors.length > 0 && (
            <div className="ae-factor-group">
              <div className="ae-factor-title ae-factor-title-pos">✅ Detta hjälper signalen</div>
              <div className="ae-chips">
                {positiveFactors.map((f, i) => (
                  <span key={i} className="ae-chip ae-chip-pos" title={f.labelSv}>
                    {factorLabel(f)}
                  </span>
                ))}
              </div>
            </div>
          )}
          {negativeFactors.length > 0 && (
            <div className="ae-factor-group">
              <div className="ae-factor-title ae-factor-title-neg">⚠️ Detta drar ned signalen</div>
              <div className="ae-chips">
                {negativeFactors.map((f, i) => (
                  <span key={i} className="ae-chip ae-chip-neg" title={f.labelSv}>
                    {factorLabel(f)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {summarySv && <div className="ae-summary">{summarySv}</div>}
    </div>
  );
}

// ── ConfidencePanel ───────────────────────────────────────────────────────────

export function ConfidencePanel({ r }) {
  const conf = r?.confidence;
  if (!conf) return null;
  const { baseTradeScore, finalTradeScore, adjustment, boosters = [], blockers = [] } = conf;
  if (boosters.length === 0 && blockers.length === 0 && adjustment === 0) return null;
  return (
    <div className="conf-panel">
      <div className="conf-panel-score">
        Före historik: <strong>{baseTradeScore}</strong> → Efter filter: <strong>{finalTradeScore}</strong>
        {adjustment !== 0 && (
          <span className={`conf-adj ${adjustment > 0 ? 'conf-adj-pos' : 'conf-adj-neg'}`}>
            {adjustment > 0 ? '+' : ''}{adjustment}
          </span>
        )}
      </div>
      {boosters.length > 0 && (
        <div className="conf-rows">
          {boosters.map((b, i) => (
            <div key={i} className="conf-row conf-row-boost">
              <span className="conf-row-dot">+{b.amount}</span>
              <span>{b.labelSv}</span>
            </div>
          ))}
        </div>
      )}
      {blockers.length > 0 && (
        <div className="conf-rows">
          {blockers.map((b, i) => (
            <div key={i} className="conf-row conf-row-block">
              <span className="conf-row-dot">{b.hardCap != null ? `cap ${b.hardCap}` : b.amount}</span>
              <span>{b.labelSv}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── BestCardV2 ────────────────────────────────────────────────────────────────

function bcDesc(r) {
  const score = r.tradeScore ?? 0;
  const ds = getDisplaySignal(r);
  const isLong  = ds === 'LONG_TRIG'  || ds === 'LONG_VAKA'  || ds === 'SVAG_LONG';
  const isShort = ds === 'SHORT_TRIG' || ds === 'SHORT_VAKA' || ds === 'SVAG_SHORT';
  if (score >= 60 && isLong)  return 'Det här är ett av de bättre lägena just nu. Systemet ser större chans för uppgång.';
  if (score >= 60 && isShort) return 'Det här är ett av de bättre lägena just nu. Systemet ser större chans för nedgång.';
  if (score >= 60)            return 'Det här är ett av de bättre lägena just nu.';
  if (isLong)                 return 'Systemet ser större chans för uppgång än nedgång just nu.';
  if (isShort)                return 'Systemet ser större chans för nedgång än uppgång just nu.';
  return 'Intressant, men vänta på bättre bekräftelse.';
}

export function BestCardV2({ r, rank, tvLinkFn }) {
  const [copied, setCopied] = useState('');
  function handleCopy(type) {
    copyText(type === 'alert' ? alertText(r) : claudePrompt(r));
    setCopied(type);
    setTimeout(() => setCopied(''), 1500);
  }
  const link = tvLinkFn ? tvLinkFn(r.symbol) : tvLink(r.symbol);
  const desc = bcDesc(r);
  const confLabel = r.confidence?.label;
  const before = r.tradeScoreBeforeConfidence;
  const after  = r.tradeScore;

  const ds = getDisplaySignal(r);
  const bcCls = ds === 'LONG_TRIG' || ds === 'LONG_VAKA' ? 'bc-green'
    : ds === 'SHORT_TRIG' || ds === 'SHORT_VAKA' ? 'bc-blue'
    : ds === 'JAGA_INTE' ? 'bc-orange'
    : 'bc-yellow';

  return (
    <div className={`best-card-v2 ${bcCls}`}>
      {rank != null && <div className="bc-rank">#{rank} bästa läge just nu</div>}
      <div className="bc-head">
        <div>
          <div className="bc-symbol" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {r.symbol}
            <NewSignalBadge symbol={r.symbol} />
            {confLabel && <ConfidenceLabelBadge label={confLabel} />}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <DisplaySignalBadge result={r} />
            <MarketRegimeBadge regime={r.marketRegime} score={r.marketScore} />
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="bc-price">${r.price != null ? Number(r.price).toFixed(2) : '–'}</div>
          <div style={{ marginTop: 6 }}><NarrowTypeBadge narrowType={r.narrowType} /></div>
        </div>
      </div>

      <ScoreMeter score={after} />
      {before != null && before !== after && (
        <div className="conf-score-delta" style={{ marginTop: 4 }}>
          Före historik: <strong>{before}</strong> → Efter filter: <strong>{after}</strong>
        </div>
      )}

      {desc && <div className="bc-action">{desc}</div>}

      <HealthChips r={r} />

      {(r.longTrigger != null || r.shortTrigger != null) && (
        <div className="bc-triggers">
          {r.longTrigger != null && (
            <div className="bc-trigger bc-trigger-long">
              <span className="bc-trigger-label">Om priset går över</span>
              <span className="bc-trigger-val">${r.longTrigger}</span>
              <span className="bc-trigger-hint">Uppgång kan starta härifrån</span>
            </div>
          )}
          {r.shortTrigger != null && (
            <div className="bc-trigger bc-trigger-short">
              <span className="bc-trigger-label">Om priset går under</span>
              <span className="bc-trigger-val">${r.shortTrigger}</span>
              <span className="bc-trigger-hint">Nedgång kan fortsätta härifrån</span>
            </div>
          )}
        </div>
      )}

      <WhyBox r={r} />
      <ConfidencePanel r={r} />
      <AdaptiveEdgePanel r={r} />
      <SetupDNAPanel r={r} />

      <div className="bc-actions">
        <a className="btn btn-tv" href={link} target="_blank" rel="noopener noreferrer">📈 TradingView</a>
        <button className="btn btn-copy" onClick={() => handleCopy('alert')}>{copied === 'alert' ? '✓ Kopierat' : '📋 Alert'}</button>
        <button className="btn btn-copy" onClick={() => handleCopy('claude')}>{copied === 'claude' ? '✓ Kopierat' : '🤖 Claude'}</button>
      </div>
    </div>
  );
}

// ── QQQPremiumCard ────────────────────────────────────────────────────────────

export function QQQPremiumCard({ data }) {
  if (!data) return null;
  return (
    <div className="qqq-premium">
      <div className="qqq-prem-head">
        <div>
          <div className="qqq-prem-sym">QQQ <span className="qqq-proxy-tag">NASDAQ-100 PROXY</span></div>
          <div className="qqq-prem-sub">Invesco QQQ ETF · proxy för NDX / NASDAQ-100 · Alpaca IEX stödjer ej direktindexdata</div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <DisplaySignalBadge result={data} />
            <MarketRegimeBadge regime={data.marketRegime} score={data.marketScore} />
          </div>
        </div>
        <div
          className="qqq-prem-price"
          style={{ color: data.price > (data.sma20 || 0) ? 'var(--green)' : 'var(--red)' }}
        >
          ${data.price != null ? Number(data.price).toFixed(2) : '–'}
        </div>
      </div>
      <ScoreMeter score={data.tradeScore} />
      <div className="qqq-prem-grid">
        <div className="qqq-prem-stat">
          <div className="qqq-prem-stat-label">SMA20</div>
          <div className="qqq-prem-stat-val">{data.sma20 != null ? Number(data.sma20).toFixed(2) : '–'}</div>
        </div>
        <div className="qqq-prem-stat">
          <div className="qqq-prem-stat-label">SMA200</div>
          <div className="qqq-prem-stat-val">{data.sma200 != null ? Number(data.sma200).toFixed(2) : '–'}</div>
        </div>
        <div className="qqq-prem-stat">
          <div className="qqq-prem-stat-label">RSI</div>
          <div
            className="qqq-prem-stat-val"
            style={{ color: data.rsi14 > 55 ? 'var(--green)' : data.rsi14 < 45 ? 'var(--red)' : 'var(--text)' }}
          >
            {data.rsi14 != null ? Number(data.rsi14).toFixed(1) : '–'}
          </div>
        </div>
        <div className="qqq-prem-stat">
          <div className="qqq-prem-stat-label">ATR (normal rörelse)</div>
          <div className="qqq-prem-stat-val">{data.atr14 != null ? Number(data.atr14).toFixed(2) : '–'}</div>
        </div>
        {data.longTrigger != null && (
          <div className="qqq-prem-stat" style={{ borderColor: 'var(--green-border)', background: 'var(--green-dim)' }}>
            <div className="qqq-prem-stat-label" style={{ color: 'var(--green)' }}>Om priset går över</div>
            <div className="qqq-prem-stat-val" style={{ color: 'var(--green)' }}>${data.longTrigger}</div>
          </div>
        )}
        {data.shortTrigger != null && (
          <div className="qqq-prem-stat" style={{ borderColor: 'var(--red-border)', background: 'var(--red-dim)' }}>
            <div className="qqq-prem-stat-label" style={{ color: 'var(--red)' }}>Om priset går under</div>
            <div className="qqq-prem-stat-val" style={{ color: 'var(--red)' }}>${data.shortTrigger}</div>
          </div>
        )}
      </div>
      {data.marketReasonSv && data.marketReasonSv.length > 0 && (
        <div className="qqq-prem-market">
          <div className="qqq-prem-market-title">Marknadsläge just nu</div>
          <ul className="qqq-prem-market-reasons">
            {data.marketReasonSv.slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
