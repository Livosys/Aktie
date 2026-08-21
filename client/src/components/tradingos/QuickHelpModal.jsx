import React, { useEffect } from 'react';
import { FACTORY_TERM_KEYS, uiCopy, uiHelpCards } from '../../services/uiTerminologyService.js';

const HELP_CARD_KEYS = [
  FACTORY_TERM_KEYS.SIGNAL,
  FACTORY_TERM_KEYS.STRATEGY,
  FACTORY_TERM_KEYS.REPLAY_QUEUE,
  FACTORY_TERM_KEYS.SHOW_PLAN,
  FACTORY_TERM_KEYS.HISTORY,
  FACTORY_TERM_KEYS.PAPER_ONLY,
];

export default function QuickHelpModal({ open, onClose }) {
  const copy = uiCopy('quickHelp');
  const helpCards = uiHelpCards(HELP_CARD_KEYS);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape') onClose?.();
    }

    if (!open) return undefined;
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="tr-help-shell" role="dialog" aria-modal="true" aria-label={copy.ariaLabel}>
      <button type="button" className="tr-help-backdrop" aria-label={copy.closeHelp} onClick={onClose} />
      <aside className="tr-help-panel">
        <div className="tr-help-head">
          <div>
            <div className="tr-help-kicker">{copy.kicker}</div>
            <h2>{copy.title}</h2>
          </div>
          <button type="button" className="tr-help-close" onClick={onClose} aria-label={copy.closeHelp}>×</button>
        </div>

        <p className="tr-help-lead">
          {copy.lead}
        </p>

        <div className="tr-help-grid">
          {helpCards.map((card) => (
            <article key={card.title} className="tr-help-card">
              <strong>{card.title}</strong>
              <p>{card.text}</p>
            </article>
          ))}
        </div>

        <div className="tr-help-notes">
          {copy.notes.map((note) => <div key={note}>{note}</div>)}
        </div>

        <div className="tr-help-safe">
          {copy.safety}
        </div>
      </aside>
    </div>
  );
}
