import React, { useState } from 'react';
import Sidebar from '../components/Sidebar.jsx';
import TopBar from '../components/TopBar.jsx';
import { useSystemStatus } from '../components/SystemStatusStrip.jsx';

export default function AppShell({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const status = useSystemStatus();

  return (
    <div className="premium-app-shell">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="premium-shell-body">
        <TopBar onMenu={() => setSidebarOpen((value) => !value)} status={status} />
        <main className="premium-shell-content">
          {children}
        </main>
      </div>
    </div>
  );
}
