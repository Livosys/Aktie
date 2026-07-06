import React from 'react';
import { Link } from 'react-router-dom';

const ADMIN_LINKS = [
  {
    to: '/supervisor',
    icon: '🧭',
    title: 'Trading OS',
    text: 'Översikt, systemstatus och huvudvy för Trading OS.',
  },
  {
    to: '/paper-trading',
    icon: '🧾',
    title: 'Paper Trading',
    text: 'Intern paper trading, testflöden och simulerade trades.',
  },
  {
    to: '/lab',
    icon: '🧪',
    title: 'Lärdomar',
    text: 'Se vad systemet lärt sig och vilka signaler som återkommer.',
  },
  {
    to: '/insikter',
    icon: '📊',
    title: 'Historik',
    text: 'Granska tidigare trades, signaler och systemhändelser.',
  },
  {
    to: '/system',
    icon: '🛡️',
    title: 'Teknik',
    text: 'Teknisk status, dataflöden och systemdiagnos.',
  },
];

export default function AdminPage() {
  return (
    <main className="admin-page">
      <section className="admin-hero">
        <div className="admin-kicker">Trading OS</div>
        <h1>Admin</h1>
        <p>Samlad plats för administrativa vyer, historik och tekniska kontrollsidor.</p>
      </section>

      <section className="admin-grid" aria-label="Adminlänkar">
        {ADMIN_LINKS.map((item) => (
          <Link key={item.to} to={item.to} className="admin-card">
            <span className="admin-card-icon">{item.icon}</span>
            <span className="admin-card-body">
              <strong>{item.title}</strong>
              <span>{item.text}</span>
            </span>
          </Link>
        ))}
      </section>
    </main>
  );
}
