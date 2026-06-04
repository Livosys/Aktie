import React, { useEffect } from 'react';

const HELP_CARDS = [
  { title: 'Signal', text: 'Ett tecken på att systemet hittat något intressant.' },
  { title: 'Strategi', text: 'Ett sätt som systemet testar för att se om något fungerar bättre.' },
  { title: 'Testkö', text: 'En lista med idéer som kan granskas manuellt. Inget körs automatiskt.' },
  { title: 'Visa plan', text: 'Öppnar en enkel förhandsgranskning av vad testet skulle innebära.' },
  { title: 'Historik', text: 'Visar vad systemet redan vet om strategin och vad som hänt tidigare.' },
  { title: 'Paper only', text: 'Bara testläge. Inga riktiga köp eller sälj görs.' },
];

export default function QuickHelpModal({ open, onClose }) {
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
    <div className="tr-help-shell" role="dialog" aria-modal="true" aria-label="Så fungerar Trading OS">
      <button type="button" className="tr-help-backdrop" aria-label="Stäng hjälp" onClick={onClose} />
      <aside className="tr-help-panel">
        <div className="tr-help-head">
          <div>
            <div className="tr-help-kicker">Ny här?</div>
            <h2>Så fungerar Trading OS</h2>
          </div>
          <button type="button" className="tr-help-close" onClick={onClose} aria-label="Stäng">×</button>
        </div>

        <p className="tr-help-lead">
          Systemet letar efter signaler, testar idéer i säkert testläge och hjälper dig förstå vad som verkar bra, svagt eller stoppat.
        </p>

        <div className="tr-help-grid">
          {HELP_CARDS.map((card) => (
            <article key={card.title} className="tr-help-card">
              <strong>{card.title}</strong>
              <p>{card.text}</p>
            </article>
          ))}
        </div>

        <div className="tr-help-notes">
          <div>Grön = ser bra ut</div>
          <div>Gul = behöver mer data</div>
          <div>Röd = stoppad eller kräver försiktighet</div>
        </div>

        <div className="tr-help-safe">
          Inga riktiga affärer görs automatiskt. Du bestämmer vad som ska granskas.
        </div>
      </aside>
    </div>
  );
}
