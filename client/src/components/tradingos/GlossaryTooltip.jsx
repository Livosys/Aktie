import React from 'react';

export default function GlossaryTooltip({ term, help, className = '' }) {
  return (
    <button
      type="button"
      className={`tr-glossary-term ${className}`.trim()}
      title={help}
      aria-label={`${term}: ${help}`}
    >
      <span>{term}</span>
      <span className="tr-glossary-icon">?</span>
    </button>
  );
}
