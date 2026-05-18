import React, {
  createContext, useContext, useState, useRef, useCallback, useEffect,
} from 'react';

const AlertContext = createContext(null);

const ACTIVE_SIGNALS = new Set([
  'LONG_TRIGGERED', 'SHORT_TRIGGERED', 'LONG_WATCH', 'SHORT_WATCH', 'WIDE_REVERSAL_WATCH',
]);
const COOLDOWN_MS        = 5 * 60 * 1000; // 5 min cooldown for signal beep
const HERO_COOLDOWN_MS   = 60_000;         // 60 s cooldown for hero toast
const NEW_BADGE_MS       = 10_000;         // "NY SIGNAL" badge duration
const CONF_NOTIF_THRESH  = 75;
const HERO_SCORE_THRESH  = 60;
const TOAST_TTL_MS       = 8_000;          // toast auto-dismiss

// ── Audio helpers ─────────────────────────────────────────────────────────────

function playBeep(audioCtx) {
  try {
    const t = audioCtx.currentTime;
    for (const [freq, start, dur] of [[660, t, 0.12], [880, t + 0.13, 0.2]]) {
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.25, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.start(start); osc.stop(start + dur);
    }
  } catch (_) {}
}

function playHeroBeep(audioCtx) {
  try {
    const t = audioCtx.currentTime;
    // Three-tone ascending arpeggio — slightly more impactful than normal beep
    for (const [freq, start, dur] of [[523, t, 0.1], [659, t + 0.11, 0.1], [880, t + 0.22, 0.28]]) {
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.3, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.start(start); osc.stop(start + dur);
    }
  } catch (_) {}
}

function fireNotification(r) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const dir = r.signal?.includes('LONG') ? 'LONG' : r.signal?.includes('SHORT') ? 'SHORT' : 'SIGNAL';
  try {
    new Notification(`${dir}: ${r.symbol}`, {
      body: `Signal: ${r.signal} | Timeframe: 2M`,
      tag: `scanner-${r.symbol}`,
      renotify: true,
    });
  } catch (_) {}
}

// ── localStorage helpers ──────────────────────────────────────────────────────

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function AlertProvider({ children }) {
  // Restore sound preference from localStorage
  const [enabled,     setEnabled]     = useState(() => lsGet('sound-enabled', false));
  const [notifStatus, setNotifStatus] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  );
  const [newSignals,  setNewSignals]  = useState(new Map());
  const [heroToasts,  setHeroToasts]  = useState([]);   // [{id, symbol, score, label}]

  const enabledRef      = useRef(lsGet('sound-enabled', false));
  const audioCtxRef     = useRef(null);
  const cooldowns       = useRef(new Map());
  const heroCooldowns   = useRef(new Map());  // "source:symbol" → last hero-triggered ms
  const prevResults     = useRef(new Map());  // "source:symbol" → last signal string
  const prevHeroScores  = useRef(new Map());  // "source:symbol" → last tradeScore
  const prevHeroSymbol  = useRef(new Map());  // source → hero symbol at last tick
  const initialized     = useRef(new Set());
  const badgeTimers     = useRef(new Map());

  // Keep ref in sync + persist to localStorage
  useEffect(() => {
    enabledRef.current = enabled;
    lsSet('sound-enabled', enabled);
  }, [enabled]);

  const activate = useCallback(async () => {
    if (!audioCtxRef.current) {
      try { audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (_) {}
    }
    try {
      if (audioCtxRef.current?.state === 'suspended') await audioCtxRef.current.resume();
    } catch (_) {}

    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        const perm = await Notification.requestPermission();
        setNotifStatus(perm);
      } catch (_) {
        Notification.requestPermission((perm) => setNotifStatus(perm));
      }
    } else if (typeof Notification !== 'undefined') {
      setNotifStatus(Notification.permission);
    }
    setEnabled(true);
  }, []);

  const deactivate = useCallback(() => setEnabled(false), []);

  const dismissHeroToast = useCallback((id) => {
    setHeroToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ── processResults ───────────────────────────────────────────────────────────

  const processResults = useCallback((results, source) => {
    if (!Array.isArray(results)) return;

    const now          = Date.now();
    const isFirstFetch = !initialized.current.has(source);

    if (isFirstFetch) {
      results.forEach((r) => {
        prevResults.current.set(`${source}:${r.symbol}`, r.signal);
        prevHeroScores.current.set(`${source}:${r.symbol}`, r.tradeScore ?? 0);
      });
      // Seed hero tracking so first real tick can detect changes
      const initHero = [...results]
        .filter(r => !r.autoFilter?.blocked && (r.tradeScore ?? 0) >= HERO_SCORE_THRESH)
        .sort((a, b) => (b.tradeScore ?? 0) - (a.tradeScore ?? 0))[0];
      prevHeroSymbol.current.set(source, initHero?.symbol ?? null);
      initialized.current.add(source);
      return;
    }

    const toMark = [];

    results.forEach((r) => {
      const key        = `${source}:${r.symbol}`;
      const prevSignal = prevResults.current.get(key);
      const isActive   = ACTIVE_SIGNALS.has(r.signal);
      const wasActive  = prevSignal != null && ACTIVE_SIGNALS.has(prevSignal);
      const isNew      = isActive && (!wasActive || prevSignal !== r.signal);

      // ── Existing signal alert ───────────────────────────────────────────────
      if (isNew) {
        toMark.push(r.symbol);
        if (enabledRef.current && audioCtxRef.current) {
          const lastTriggered = cooldowns.current.get(r.symbol) ?? 0;
          if (now - lastTriggered >= COOLDOWN_MS) {
            playBeep(audioCtxRef.current);
            if ((r.confidence ?? 0) >= CONF_NOTIF_THRESH) fireNotification(r);
            cooldowns.current.set(r.symbol, now);
          }
        }
      }
      prevResults.current.set(key, r.signal);

      // ── Hero signal detection ───────────────────────────────────────────────
      const currScore  = r.tradeScore ?? 0;
      const prevScore  = prevHeroScores.current.get(key) ?? 0;
      const isBlocked  = r.autoFilter?.blocked === true;

      if (!isBlocked && currScore >= HERO_SCORE_THRESH && prevScore < HERO_SCORE_THRESH) {
        const lastHero = heroCooldowns.current.get(key) ?? 0;
        if (now - lastHero >= HERO_COOLDOWN_MS) {
          heroCooldowns.current.set(key, now);
          const toastId = now + Math.random();
          setHeroToasts((prev) => [
            ...prev.slice(-2),   // max 3 toasts
            { id: toastId, symbol: r.symbol, score: currScore, label: r.confidence?.label ?? null },
          ]);
          if (enabledRef.current && audioCtxRef.current) {
            playHeroBeep(audioCtxRef.current);
          }
        }
      }
      prevHeroScores.current.set(key, currScore);
    });

    // ── Hero symbol change detection ──────────────────────────────────────────
    // Fires when a *different* symbol becomes #1 hero (score ≥60, not blocked)
    const currentHero = [...results]
      .filter(r => !r.autoFilter?.blocked && (r.tradeScore ?? 0) >= HERO_SCORE_THRESH)
      .sort((a, b) => (b.tradeScore ?? 0) - (a.tradeScore ?? 0))[0];
    const prevHeroSym    = prevHeroSymbol.current.get(source) ?? null;
    const currentHeroSym = currentHero?.symbol ?? null;

    if (currentHeroSym && currentHeroSym !== prevHeroSym) {
      const heroKey  = `${source}:${currentHeroSym}`;
      const lastHero = heroCooldowns.current.get(heroKey) ?? 0;
      if (now - lastHero >= HERO_COOLDOWN_MS) {
        heroCooldowns.current.set(heroKey, now);
        const toastId = now + Math.random();
        setHeroToasts((prev) => [
          ...prev.slice(-2),
          { id: toastId, symbol: currentHeroSym, score: currentHero.tradeScore, label: currentHero.confidence?.label ?? null },
        ]);
        if (enabledRef.current && audioCtxRef.current) playHeroBeep(audioCtxRef.current);
      }
    }
    prevHeroSymbol.current.set(source, currentHeroSym);

    // ── NY SIGNAL badges ──────────────────────────────────────────────────────
    if (toMark.length > 0) {
      const expiry = now + NEW_BADGE_MS;
      setNewSignals((prev) => {
        const next = new Map(prev);
        toMark.forEach((sym) => {
          if (badgeTimers.current.has(sym)) clearTimeout(badgeTimers.current.get(sym));
          next.set(sym, expiry);
          const tid = setTimeout(() => {
            setNewSignals((m) => { const u = new Map(m); u.delete(sym); return u; });
            badgeTimers.current.delete(sym);
          }, NEW_BADGE_MS);
          badgeTimers.current.set(sym, tid);
        });
        return next;
      });
    }
  }, []);

  const isNewSignal = useCallback(
    (symbol) => { const exp = newSignals.get(symbol); return exp != null && Date.now() < exp; },
    [newSignals],
  );

  return (
    <AlertContext.Provider
      value={{ enabled, notifStatus, activate, deactivate, processResults, isNewSignal, heroToasts, dismissHeroToast }}
    >
      {children}
    </AlertContext.Provider>
  );
}

export function useAlerts() {
  return useContext(AlertContext);
}

// ── HeroToast ─────────────────────────────────────────────────────────────────

function HeroToast({ toast, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), TOAST_TTL_MS);
    return () => clearTimeout(t);
  }, [toast.id, onDismiss]);

  return (
    <div className="hero-toast" role="alert" aria-live="polite">
      <div className="hero-toast-icon">⚡</div>
      <div className="hero-toast-body">
        <div className="hero-toast-title">Ny stark signal</div>
        <div className="hero-toast-symbol">{toast.symbol}</div>
        {toast.score != null && (
          <div className="hero-toast-meta">
            {toast.score} poäng{toast.label ? ` · ${toast.label}` : ''}
          </div>
        )}
      </div>
      <button className="hero-toast-close" onClick={() => onDismiss(toast.id)} aria-label="Stäng">×</button>
      <div className="hero-toast-bar" style={{ animationDuration: `${TOAST_TTL_MS}ms` }} />
    </div>
  );
}

export function HeroToastContainer() {
  const ctx = useAlerts();
  if (!ctx?.heroToasts?.length) return null;
  return (
    <div className="hero-toast-wrap">
      {ctx.heroToasts.map((t) => (
        <HeroToast key={t.id} toast={t} onDismiss={ctx.dismissHeroToast} />
      ))}
    </div>
  );
}
