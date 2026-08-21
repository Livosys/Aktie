import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { OverviewPanel, StatusBadge } from '../trading/index.js';
import { aiStoryEventText } from '../../services/aiStoryService.js';
import { uiFactorySafeText } from '../../services/uiTerminologyService.js';

const FILTERS = [
  { key: 'all', label: 'Alla' },
  { key: 'ai', label: 'AI' },
  { key: 'tests', label: 'Tester' },
  { key: 'strategies', label: 'Strategier' },
  { key: 'paper', label: 'Paper Trading' },
];

function parseTime(value) {
  if (value == null || value === '') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function formatRelativeTime(value, now = Date.now()) {
  const time = parseTime(value);
  if (time == null) return 'Tid saknas';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 30) return 'nyss';
  if (seconds < 90) return 'för 1 min sedan';
  if (seconds < 3600) return `för ${Math.round(seconds / 60)} min sedan`;
  if (seconds < 86400) return `för ${Math.round(seconds / 3600)} tim sedan`;
  return `för ${Math.round(seconds / 86400)} d sedan`;
}

export function categoryFor(item = {}) {
  const kind = String(item.kind || '').toLowerCase();
  if (['running', 'replay'].includes(kind)) return 'tests';
  if (['candidate', 'improvement', 'approved'].includes(kind)) return 'strategies';
  if (kind === 'paper') return 'paper';
  if (['historyimported', 'opportunityfound', 'learned', 'waiting', 'cannotcontinue'].includes(kind)) return 'ai';
  return 'ai';
}

function iconFor(category) {
  if (category === 'tests') return '▶';
  if (category === 'strategies') return '◇';
  if (category === 'paper') return '▣';
  return '✦';
}

function toneFor(category, tone) {
  if (tone) return tone;
  if (category === 'tests') return 'info';
  if (category === 'strategies') return 'warning';
  if (category === 'paper') return 'success';
  return 'neutral';
}

export function groupItems(items = []) {
  const grouped = new Map();
  const sorted = [...items]
    .filter((item) => item && (item.timestamp || item.time || item.createdAt))
    .sort((a, b) => (parseTime(b.timestamp || b.time || b.createdAt) || 0) - (parseTime(a.timestamp || a.time || a.createdAt) || 0));

  for (const item of sorted) {
    const category = categoryFor(item);
    const title = uiFactorySafeText(item.title || item.story || item.detail || aiStoryEventText('waiting'));
    const detail = uiFactorySafeText(item.detail || item.story || item.meta || title);
    const href = item.href || item.to || '/factory';
    const key = `${category}|${title}|${detail}|${href}`;
    const previous = grouped.get(key);
    const stamp = item.timestamp || item.time || item.createdAt || item.updatedAt || null;
    if (previous) {
      previous.count += 1;
      if ((parseTime(stamp) || 0) > (parseTime(previous.timestamp) || 0)) {
        previous.timestamp = stamp;
      }
      continue;
    }
    grouped.set(key, {
      id: item.id || key,
      category,
      title,
      detail,
      href,
      tone: toneFor(category, item.tone),
      badge: item.badge || (category === 'paper' ? 'Paper' : category === 'tests' ? 'Test' : category === 'strategies' ? 'Strategi' : 'AI'),
      icon: item.icon || iconFor(category),
      timestamp: stamp,
      count: 1,
    });
  }

  return [...grouped.values()];
}

function groupLabel(count) {
  if (count <= 1) return null;
  return `${count} liknande`;
}

export default function FactoryLiveActivityFeed({ items = [], copy }) {
  const text = copy.workflow.activityFeed;
  const [filter, setFilter] = useState('all');
  const grouped = useMemo(() => groupItems(items), [items]);
  const visible = useMemo(() => (
    filter === 'all' ? grouped : grouped.filter((item) => item.category === filter)
  ), [filter, grouped]);

  const hasItems = visible.length > 0;
  const latestLabel = hasItems ? formatRelativeTime(visible[0].timestamp) : null;
  const emptyText = aiStoryEventText('waiting');

  return (
    <section data-factory-live-activity-feed style={{ marginBottom: 'var(--s7)' }}>
      <OverviewPanel
        eyebrow={copy.readOnly}
        title={text.title}
        summary={text.subtitle}
      >
        <div className="m-seg" aria-label={text.title} style={{ marginBottom: 'var(--s4)' }}>
          {FILTERS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              aria-pressed={filter === entry.key}
              aria-label={entry.label}
              onClick={() => setFilter(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {hasItems ? (
          <>
            <div className="m-eyebrow" style={{ marginBottom: 'var(--s3)' }}>
              {latestLabel ? `Senaste händelsen ${latestLabel}` : 'Senaste händelsen'}
            </div>
            <div className="m-card">
              {visible.map((item) => (
                <Link
                  key={item.id}
                  to={item.href}
                  data-factory-live-activity-item={item.category}
                  className="m-row"
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      border: '1px solid var(--border)',
                      background: 'var(--surface-2)',
                      color: 'var(--muted)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flex: 'none',
                      fontSize: 13,
                    }}
                  >
                    {item.icon}
                  </span>
                  <span className="m-row-body">
                    <span className="m-h3" style={{ display: 'block', overflowWrap: 'anywhere' }}>{item.title}</span>
                    <p style={{ overflowWrap: 'anywhere' }}>{item.detail}</p>
                    <span className="m-eyebrow" style={{ display: 'block', marginTop: 'var(--s2)' }}>
                      {formatRelativeTime(item.timestamp)}
                      {groupLabel(item.count) ? ` · ${groupLabel(item.count)}` : ''}
                    </span>
                  </span>
                  <StatusBadge tone={item.tone} compact>{item.badge}</StatusBadge>
                </Link>
              ))}
            </div>
          </>
        ) : (
          <div className="m-empty">
            <div className="m-empty-title">{text.empty}</div>
            <div className="m-empty-body">{emptyText}</div>
          </div>
        )}
      </OverviewPanel>
    </section>
  );
}
