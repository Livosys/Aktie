import React, { useMemo } from 'react';
import { useUnifiedConfig } from '../hooks/useUnifiedConfig.js';

function ageText(iso) {
  if (!iso) return '–';
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '–';
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec} sek`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  return `${Math.round(min / 60)} h`;
}

function componentByName(health, name) {
  return (health?.components || []).find((c) => c.name === name);
}

function StatusPill({ state = 'unknown', label, value }) {
  return (
    <span className={`premium-status-pill premium-status-${state}`}>
      <span className="premium-status-dot" />
      <span>{label}</span>
      {value && <strong>{value}</strong>}
    </span>
  );
}

export function useSystemStatus() {
  const unified = useUnifiedConfig('health');
  return {
    health: unified.global.systemHealth,
    scan: unified.global.scannerStatus,
    loading: unified.meta.loading && !unified.global.systemHealth,
    refresh: () => unified.refresh('health'),
  };
}

export default function SystemStatusStrip({ status }) {
  const health = status?.health;
  const scan = status?.scan;

  const computed = useMemo(() => {
    const stockScanner = componentByName(health, 'Stock scanner');
    const cryptoScanner = componentByName(health, 'Crypto scanner');
    const learning = (health?.components || []).find((c) => /learning|inlär/i.test(`${c.name} ${c.area}`));
    const backendOk = !!health?.ok;
    const scannerOk = [stockScanner, cryptoScanner].some((c) => c?.status === 'ON');
    const dataOk = [stockScanner, cryptoScanner].some((c) => c?.details?.feedStatus?.status === 'ON');
    const learningOk = learning ? learning.status !== 'OFF' : true;
    const lastScan = scan?.lastScan || stockScanner?.lastUpdated || cryptoScanner?.lastUpdated || health?.generatedAt;

    return {
      backendOk,
      scannerOk,
      dataOk,
      learningOk,
      lastScan,
      overall: health?.overallStatus || 'UNKNOWN',
    };
  }, [health, scan]);

  return (
    <div className="premium-status-strip" aria-label="Systemstatus">
      <StatusPill state={computed.backendOk ? 'ok' : 'bad'} label="Backend ansluten" />
      <StatusPill state={computed.scannerOk ? 'ok' : 'warn'} label="Scanner aktiv" />
      <StatusPill state={computed.dataOk ? 'ok' : 'warn'} label="Data aktiv" />
      <StatusPill state={computed.learningOk ? 'ok' : 'warn'} label="Inlärning aktiv" />
      <StatusPill state={computed.overall === 'CRITICAL' ? 'bad' : computed.overall === 'WARNING' ? 'warn' : 'ok'} label="Systemet kör" />
      <StatusPill state="info" label="Senaste scan" value={ageText(computed.lastScan)} />
    </div>
  );
}
