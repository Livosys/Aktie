import { useState, useEffect, useCallback } from 'react';

const REFRESH_MS = 15_000;

export function friendlyApiError(message) {
  if (!message) return 'Kunde inte hämta data just nu.';
  if (/API 401/.test(message)) return 'Du behöver logga in igen för att se datan.';
  if (/API 429/.test(message)) return 'För många uppdateringar på kort tid. Vänta en minut och försök igen.';
  if (/API 5\d\d/.test(message)) return 'Servern svarade inte som väntat. Försök igen strax.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'Kunde inte nå servern. Kontrollera anslutningen och försök igen.';
  return 'Kunde inte hämta data just nu.';
}

export function useScan(endpoint) {
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [scanRes, healthRes] = await Promise.all([
        fetch(endpoint),
        fetch('/health'),
      ]);
      if (!scanRes.ok) throw new Error(`API ${scanRes.status}`);
      const [scanData, healthData] = await Promise.all([
        scanRes.json(),
        healthRes.json(),
      ]);
      setData(scanData);
      setHealth(healthData);
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError({ message: friendlyApiError(e.message), detail: e.message });
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchAll]);

  return { data, health, loading, error, lastFetch, refresh: fetchAll };
}
