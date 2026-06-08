import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { LanguageProvider } from './i18n/LanguageContext.jsx';
import './styles.css';

const savedTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.dataset.theme = savedTheme;

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', background: '#0f172a', color: '#e2e8f0', minHeight: '100vh' }}>
          <div style={{ color: '#ef4444', fontSize: 18, fontWeight: 700, marginBottom: 12 }}>⚠ Rendering-fel</div>
          <div style={{ color: '#fbbf24', marginBottom: 8 }}>{String(this.state.error)}</div>
          <pre style={{ color: '#94a3b8', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {this.state.error?.stack}
          </pre>
          <button
            style={{ marginTop: 16, padding: '8px 16px', background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, cursor: 'pointer' }}
            onClick={() => this.setState({ error: null })}
          >
            Försök igen
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <LanguageProvider>
          <App />
        </LanguageProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>
);
