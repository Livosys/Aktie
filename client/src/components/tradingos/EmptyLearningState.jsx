import React from 'react';

export default function EmptyLearningState({ title = 'Ingen data ännu', description = 'Systemet behöver mer underlag innan det kan säga något tydligt.' }) {
  return (
    <div className="tr-empty-state">
      <div className="tr-empty-orb" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
    </div>
  );
}
