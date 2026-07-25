import React from 'react';
import { EMPTY_VALUE } from '../../utils/tradingFormatters.js';
import { ALL_FILTER } from './StrategyDashboardUtils.js';

const controlStyle = {
  display: 'grid',
  gap: 5,
  minWidth: 0,
};

const labelStyle = {
  color: 'var(--muted)',
  fontSize: 11,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: 0,
};

const inputStyle = {
  width: '100%',
  minWidth: 0,
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--surface)',
  color: 'var(--text)',
  padding: '8px 10px',
  fontSize: 13,
  outline: 'none',
};

function SelectControl({
  label,
  value,
  options = [],
  onChange,
  disabled = false,
}) {
  return (
    <label style={controlStyle}>
      <span style={labelStyle}>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        style={{
          ...inputStyle,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <option value={ALL_FILTER}>All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export const StrategyFilters = React.memo(function StrategyFilters({
  filters,
  options,
  onChange,
  onReset,
  resultCount,
  totalCount,
}) {
  const update = (key, value) => onChange({ ...filters, [key]: value });
  return (
    <section style={{
      border: '1px solid var(--border)',
      borderRadius: 8,
      background: 'var(--surface)',
      padding: 14,
      display: 'grid',
      gap: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <div style={labelStyle}>Strategy Filters</div>
          <div style={{ color: 'var(--text)', fontSize: 18, fontWeight: 900, marginTop: 3 }}>
            {resultCount} / {totalCount}
          </div>
        </div>
        <button
          type="button"
          onClick={onReset}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--surface-2)',
            color: 'var(--text)',
            padding: '7px 10px',
            fontSize: 12,
            fontWeight: 800,
            cursor: 'pointer',
          }}
        >
          Reset
        </button>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: 10,
      }}>
        <label style={{ ...controlStyle, gridColumn: 'span 2' }}>
          <span style={labelStyle}>Search</span>
          <input
            value={filters.query}
            onChange={(event) => update('query', event.target.value)}
            placeholder="strategyId or strategyName"
            style={inputStyle}
          />
        </label>
        <SelectControl label="Family" value={filters.family} options={options.family} onChange={(value) => update('family', value)} disabled={!options.family.length} />
        <SelectControl label="Runtime" value={filters.runtimeState} options={options.runtimeState} onChange={(value) => update('runtimeState', value)} disabled={!options.runtimeState.length} />
        <SelectControl label="Approval" value={filters.approvalState} options={options.approvalState} onChange={(value) => update('approvalState', value)} disabled={!options.approvalState.length} />
        <SelectControl label="Risk" value={filters.riskState} options={options.riskState} onChange={(value) => update('riskState', value)} disabled={!options.riskState.length} />
        <SelectControl label="Signal" value={filters.signal} options={options.signal} onChange={(value) => update('signal', value)} disabled={!options.signal.length} />
        <SelectControl label="Market Regime" value={filters.marketRegime} options={options.marketRegime} onChange={(value) => update('marketRegime', value)} disabled={!options.marketRegime.length} />
        <SelectControl
          label="Current Candidate"
          value={filters.currentCandidate}
          onChange={(value) => update('currentCandidate', value)}
          disabled={!options.hasCurrentCandidate}
          options={[
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]}
        />
        <SelectControl
          label="Blocked"
          value={filters.blocked}
          onChange={(value) => update('blocked', value)}
          disabled={!options.hasBlocked}
          options={[
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]}
        />
      </div>
      {!totalCount ? (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>{EMPTY_VALUE}</div>
      ) : null}
    </section>
  );
});
