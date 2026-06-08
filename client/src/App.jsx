import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
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
import SupervisorBrainPage from './pages/SupervisorBrainPage.jsx';
import NarrowStateLabPage from './pages/NarrowStateLabPage.jsx';

function RedirectWithSearch({ to }) {
  const { search } = useLocation();
  const joiner = to.includes('?') ? '&' : '';
  const suffix = search ? `${joiner}${search.slice(1)}` : '';
  return <Navigate to={`${to}${suffix}`} replace />;
}

export default function App() {
  return (
    <AlertProvider>
      <AppShell>
        <HeroToastContainer />
        <Routes>
          {/* Trading OS v2 */}
          <Route path="/"             element={<Navigate to="/supervisor" replace />} />
          <Route path="/supervisor/*" element={<SupervisorBrainPage />} />
          <Route path="/narrow"       element={<NarrowStateLabPage />} />
          <Route path="/narrow-state" element={<Navigate to="/narrow" replace />} />
          <Route path="/oversikt"     element={<Navigate to="/supervisor" replace />} />
          <Route path="/live"         element={<SignalpulsPage />} />
          <Route path="/lab"          element={<TradingLabPage />} />
          <Route path="/insikter"     element={<ResultatPage />} />
          <Route path="/system"       element={<SystemPage />} />
          <Route path="/daytrading"   element={<DaytradingPage />} />

          {/* Legacy primary routes */}
          <Route path="/signalpuls"  element={<RedirectWithSearch to="/live" />} />
          <Route path="/trading-lab" element={<RedirectWithSearch to="/lab" />} />
          <Route path="/resultat"    element={<RedirectWithSearch to="/insikter" />} />
          <Route path="/sakerhet"    element={<Navigate to="/system?tab=safety" replace />} />

          {/* Alerts */}
          <Route path="/alerts"      element={<Navigate to="/system?tab=logs" replace />} />

          {/* Legacy premium pages */}
          <Route path="/scanner"     element={<Navigate to="/live?filter=all" replace />} />
          <Route path="/signaler"    element={<Navigate to="/live?filter=all" replace />} />

          {/* Alias routes */}
          <Route path="/intelligence"  element={<Navigate to="/lab?tab=adaptive" replace />} />
          <Route path="/intelligens"   element={<Navigate to="/lab?tab=adaptive" replace />} />
          <Route path="/health"        element={<Navigate to="/system?tab=health" replace />} />
          <Route path="/halsa"         element={<Navigate to="/system?tab=health" replace />} />
          <Route path="/history"       element={<Navigate to="/insikter?tab=memory" replace />} />
          <Route path="/data-center"   element={<Navigate to="/insikter?tab=data-center" replace />} />
          <Route path="/larm"          element={<Navigate to="/system?tab=logs" replace />} />

          {/* Legacy routes — unchanged */}
          <Route path="/aktier"            element={<Navigate to="/live?filter=stocks" replace />} />
          <Route path="/nasdaq"            element={<Navigate to="/live?filter=nasdaq" replace />} />
          <Route path="/krypto"            element={<Navigate to="/live?filter=crypto" replace />} />
          <Route path="/historik"          element={<Navigate to="/insikter?tab=memory" replace />} />
          <Route path="/datacenter"        element={<Navigate to="/insikter?tab=data-center" replace />} />
          <Route path="/replay"            element={<Navigate to="/lab?tab=replay" replace />} />
          <Route path="/machine"           element={<Navigate to="/lab?tab=ai_agent" replace />} />
          <Route path="/missed-breakouts"  element={<Navigate to="/lab?tab=candidates" replace />} />
          <Route path="/micro-move"        element={<Navigate to="/lab?tab=adaptive" replace />} />
          <Route path="/wave"              element={<Navigate to="/lab?tab=adaptive" replace />} />
          <Route path="/review-chart"      element={<RedirectWithSearch to="/lab?tab=review" />} />
          <Route path="/system-health"     element={<Navigate to="/system?tab=health" replace />} />
          <Route path="/quality"           element={<Navigate to="/insikter?tab=ai" replace />} />
          <Route path="/paper-trading"     element={<Navigate to="/insikter?tab=paper" replace />} />
          <Route path="/risk-engine"       element={<Navigate to="/system?tab=safety" replace />} />
          <Route path="/exit-engine"       element={<Navigate to="/lab?tab=exits" replace />} />
          {/* Legacy alias: canonical safety lives at /system?tab=safety */}
          <Route path="/execution-safety"  element={<Navigate to="/system?tab=safety" replace />} />
          <Route path="/strategy-lab"      element={<Navigate to="/lab?tab=strategier" replace />} />
          <Route path="/strategilabb"      element={<Navigate to="/lab?tab=strategier" replace />} />
          <Route path="/setup-performance" element={<Navigate to="/insikter?tab=setups" replace />} />
          <Route path="/setup-resultat"    element={<Navigate to="/insikter?tab=setups" replace />} />
          <Route path="/safety"            element={<Navigate to="/system?tab=safety" replace />} />
          <Route path="/risk"              element={<Navigate to="/system?tab=safety" replace />} />
          <Route path="/exit"              element={<Navigate to="/lab?tab=exits" replace />} />
        </Routes>
      </AppShell>
      <MobileBottomNav />
      <AiCopilot />
    </AlertProvider>
  );
}
