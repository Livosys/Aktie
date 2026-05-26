import { useState, useEffect, useCallback } from 'react';

const REFRESH_MS = 15_000;

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
      setError(e.message);
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
