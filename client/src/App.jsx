import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './layout/AppShell.jsx';
import MobileBottomNav from './MobileBottomNav.jsx';
import AiCopilot from './components/AiCopilot.jsx';
import { AlertProvider, HeroToastContainer } from './alertContext.jsx';

// New primary pages
import SignalpulsPage   from './pages/SignalpulsPage.jsx';
import TradingLabPage   from './pages/TradingLabPage.jsx';
import ResultatPage     from './pages/ResultatPage.jsx';
import SystemPage       from './pages/SystemPage.jsx';
import DaytradingPage   from './pages/DaytradingPage.jsx';
import PaperTradingPage from './pages/PaperTradingPage.jsx';
import SupervisorBrainPage from './pages/SupervisorBrainPage.jsx';
import NarrowStateLabPage from './pages/NarrowStateLabPage.jsx';

export default function App() {
  return (
    <AlertProvider>
      <AppShell>
        <HeroToastContainer />
        <Routes>
          <Route path="/" element={<Navigate to="/supervisor" replace />} />
          <Route path="/paper-trading" element={<PaperTradingPage />} />
          <Route path="/daytrading" element={<DaytradingPage />} />
          <Route path="/supervisor" element={<SupervisorBrainPage />} />
          <Route path="/narrow" element={<NarrowStateLabPage />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="/lab" element={<TradingLabPage />} />
          <Route path="/live" element={<SignalpulsPage />} />
          <Route path="/insikter" element={<ResultatPage />} />
        </Routes>
      </AppShell>
      <MobileBottomNav />
      <AiCopilot />
    </AlertProvider>
  );
}
