import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Navigation from './Navigation.jsx';
import StocksPage from './pages/StocksPage.jsx';
import NasdaqPage from './pages/NasdaqPage.jsx';
import CryptoPage from './pages/CryptoPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import ReplayPage from './pages/ReplayPage.jsx';
import MachinePage from './pages/MachinePage.jsx';
import MissedBreakoutsPage from './pages/MissedBreakoutsPage.jsx';
import { AlertProvider, HeroToastContainer } from './alertContext.jsx';

export default function App() {
  return (
    <AlertProvider>
      <Navigation />
      <HeroToastContainer />
      <div className="page-wrap">
        <Routes>
          <Route path="/" element={<Navigate to="/aktier" replace />} />
          <Route path="/aktier" element={<StocksPage />} />
          <Route path="/nasdaq" element={<NasdaqPage />} />
          <Route path="/krypto" element={<CryptoPage />} />
          <Route path="/historik" element={<HistoryPage />} />
          <Route path="/replay" element={<ReplayPage />} />
          <Route path="/machine" element={<MachinePage />} />
          <Route path="/missed-breakouts" element={<MissedBreakoutsPage />} />
        </Routes>
      </div>
      <div className="footer">
        2M Scanner v2 · Aktier · Nasdaq · Krypto · Ingen handel utförs automatiskt
      </div>
    </AlertProvider>
  );
}
