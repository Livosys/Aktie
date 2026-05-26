import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './layout/AppShell.jsx';
import MobileBottomNav from './MobileBottomNav.jsx';
import AiCopilot from './components/AiCopilot.jsx';
import LivePage from './pages/LivePage.jsx';
import AlertsPage from './pages/AlertsPage.jsx';
import { AlertProvider, HeroToastContainer } from './alertContext.jsx';

// Eagerly loaded critical pages
import ScannerPage  from './pages/ScannerPage.jsx';
import SignalerPage from './pages/SignalerPage.jsx';

import StocksPage          from './pages/StocksPage.jsx';
import NasdaqPage          from './pages/NasdaqPage.jsx';
import CryptoPage          from './pages/CryptoPage.jsx';
import HistoryPage         from './pages/HistoryPage.jsx';
import ReplayPage          from './pages/ReplayPage.jsx';
import MachinePage         from './pages/MachinePage.jsx';
import MissedBreakoutsPage from './pages/MissedBreakoutsPage.jsx';
import MicroMovePage       from './pages/MicroMovePage.jsx';
import WavePage            from './pages/WavePage.jsx';
import ReviewChartPage     from './pages/ReviewChartPage.jsx';
import SystemHealthPage    from './pages/SystemHealthPage.jsx';
import QualityPage         from './pages/QualityPage.jsx';
import PaperTradingPage    from './pages/PaperTradingPage.jsx';
import RiskEnginePage      from './pages/RiskEnginePage.jsx';
import ExitEnginePage      from './pages/ExitEnginePage.jsx';

export default function App() {
  return (
    <AlertProvider>
      <AppShell>
        <HeroToastContainer />
        <Routes>
            {/* Default → Live */}
            <Route path="/"              element={<Navigate to="/live" replace />} />
            <Route path="/live"          element={<LivePage />} />

            {/* New premium pages */}
            <Route path="/scanner"       element={<ScannerPage />} />
            <Route path="/signaler"      element={<SignalerPage />} />

            {/* Alias routes */}
            <Route path="/intelligence"  element={<Navigate to="/machine" replace />} />
            <Route path="/intelligens"   element={<Navigate to="/machine" replace />} />
            <Route path="/health"        element={<Navigate to="/system-health" replace />} />
            <Route path="/halsa"         element={<Navigate to="/system-health" replace />} />
            <Route path="/history"       element={<Navigate to="/historik" replace />} />
            <Route path="/larm"          element={<Navigate to="/alerts" replace />} />

            {/* Alerts */}
            <Route path="/alerts"        element={<AlertsPage />} />

            {/* Original routes — unchanged */}
            <Route path="/aktier"            element={<StocksPage />} />
            <Route path="/nasdaq"            element={<NasdaqPage />} />
            <Route path="/krypto"            element={<CryptoPage />} />
            <Route path="/historik"          element={<HistoryPage />} />
            <Route path="/replay"            element={<ReplayPage />} />
            <Route path="/machine"           element={<MachinePage />} />
            <Route path="/missed-breakouts"  element={<MissedBreakoutsPage />} />
            <Route path="/micro-move"        element={<MicroMovePage />} />
            <Route path="/wave"              element={<WavePage />} />
            <Route path="/review-chart"      element={<ReviewChartPage />} />
            <Route path="/system-health"     element={<SystemHealthPage />} />
            <Route path="/quality"           element={<QualityPage />} />
            <Route path="/paper-trading"     element={<PaperTradingPage />} />
            <Route path="/risk-engine"       element={<RiskEnginePage />} />
            <Route path="/exit-engine"       element={<ExitEnginePage />} />
        </Routes>
      </AppShell>
      <MobileBottomNav />
      <AiCopilot />
    </AlertProvider>
  );
}
