import React from 'react';

export default function BeginnerInfoCard({ icon = '•', title, description, footnote, tone = 'blue' }) {
  return (
    <article className={`tr-beginner-card tr-beginner-${tone}`}>
      <div className="tr-beginner-icon" aria-hidden="true">{icon}</div>
      <div className="tr-beginner-copy">
        <h3>{title}</h3>
        <p>{description}</p>
        {footnote ? <span>{footnote}</span> : null}
      </div>
    </article>
  );
}
