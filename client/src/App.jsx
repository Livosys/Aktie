import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './layout/AppShell.jsx';
import MobileBottomNav from './MobileBottomNav.jsx';
import AiCopilot from './components/AiCopilot.jsx';
import { AlertProvider, HeroToastContainer } from './alertContext.jsx';

// New primary pages
import SignalpulsPage   from './pages/SignalpulsPage.jsx';
import TradingLabPage   from './pages/TradingLabPage.jsx';
import SystemPage       from './pages/SystemPage.jsx';
import PaperTradingPage from './pages/PaperTradingPage.jsx';
import InteractiveBrokersPage from './pages/InteractiveBrokersPage.jsx';

function PlaceholderPage({ title, text }) {
  return (
    <div className="page" style={{ maxWidth: 760, margin: '0 auto', padding: '40px 24px' }}>
      <div className="page-head">
        <h1>{title}</h1>
      </div>
      <div
        className="res-tab-content"
        style={{
          border: '1px solid rgba(148,163,184,0.18)',
          borderRadius: 16,
          padding: 24,
          background: 'rgba(15, 23, 42, 0.35)',
          lineHeight: 1.6,
          whiteSpace: 'pre-line',
        }}
      >
        {text}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AlertProvider>
      <AppShell>
        <HeroToastContainer />
        <Routes>
          <Route path="/" element={<Navigate to="/lab" replace />} />
          <Route path="/paper-trading" element={<PaperTradingPage />} />
          <Route path="/interactive-brokers" element={<InteractiveBrokersPage />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="/lab" element={<TradingLabPage />} />
          <Route path="/live" element={<SignalpulsPage />} />
          <Route
            path="/daytrading"
            element={(
              <PlaceholderPage
                title="Daytrading kommer snart"
                text="Den här modulen är tillfälligt avstängd medan Trading OS förenklas."
              />
            )}
          />
          <Route
            path="/narrow"
            element={(
              <PlaceholderPage
                title="Narrow Lab kommer snart"
                text="Den här vyn är under ombyggnad."
              />
            )}
          />
          <Route
            path="/supervisor"
            element={(
              <PlaceholderPage
                title="Supervisor har ersatts"
                text="Supervisor-funktioner flyttas successivt till Lab och System."
              />
            )}
          />
          <Route
            path="/insikter"
            element={(
              <PlaceholderPage
                title="Insikter kommer tillbaka"
                text="Insikter byggs om till en ny central analysvy."
              />
            )}
          />
        </Routes>
      </AppShell>
      <MobileBottomNav />
      <AiCopilot />
    </AlertProvider>
  );
}
