'use strict';

const { execFile } = require('child_process');
const net = require('net');
const interactiveBrokersPreviewService = require('./interactiveBrokersPreviewService');

const SAFETY = Object.freeze({
  mode: 'paper_only',
  actions_allowed: false,
  can_place_orders: false,
  live_trading_enabled: false,
  broker_enabled: false,
});

const DEFAULT_DISPLAY = ':2';
const DEFAULT_VNC_PORT = 5902;

function execFileText(command, args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeout || 1500, maxBuffer: options.maxBuffer || 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) {
        resolve('');
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function sanitizeCommand(command) {
  const value = safeString(command);
  if (!value) return null;
  if (/(password|passwd|secret|token|apikey|api_key|credential)=?\S*/i.test(value)) return null;
  if (!/(ibgateway|ib gateway|jts|tws|ibcontroller)/i.test(value)) return null;
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function parseProcessRows(psOutput) {
  return String(psOutput || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return null;
      return { pid: Number(match[1]), user: match[2], command: match[3] };
    })
    .filter(Boolean);
}

function isGatewayProcess(row) {
  const command = safeString(row?.command);
  if (!command) return false;
  if (/\b(?:Xtigervnc|vncserver|x11vnc|novnc|websockify|fluxbox|grep|rg|systemctl)\b/i.test(command)) return false;
  return /(ibgateway|ib gateway|jts|tws|ibcontroller)/i.test(command);
}

function isVncProcess(row) {
  return /(Xtigervnc|vncserver|x11vnc)/i.test(safeString(row?.command));
}

function parseListeningPorts(ssOutput) {
  const ports = new Set();
  for (const line of String(ssOutput || '').split('\n')) {
    const match = line.match(/:(\d+)\s+/);
    if (match) ports.add(Number(match[1]));
  }
  return ports;
}

function tcpPortOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    if (!host || !Number.isFinite(Number(port))) {
      resolve(false);
      return;
    }
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) { /* ignore */ }
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try { socket.connect(Number(port), host); } catch (_) { finish(false); }
  });
}

function buildNextAction({ gatewayProcessRunning, apiPortOpen, authenticated, connected, readinessStatus }) {
  if (gatewayProcessRunning && apiPortOpen && (authenticated === true || connected === true)) return 'Allt ser OK ut';
  if (!gatewayProcessRunning) return 'IB Gateway verkar inte vara startad';
  if (gatewayProcessRunning && !apiPortOpen) return 'IB Gateway kör men API svarar inte';
  if (apiPortOpen && authenticated !== true && connected !== true) return 'Manuell IBKR-login krävs';
  if (readinessStatus === 'timeout' || readinessStatus === 'error') return 'Kan inte avgöra status';
  return 'Kan inte avgöra status';
}

async function getGatewayHealth(options = {}) {
  const now = new Date().toISOString();
  const cfg = interactiveBrokersPreviewService.getConnectionConfig();
  const apiHost = safeString(options.apiHost || cfg.host || '127.0.0.1') || '127.0.0.1';
  const apiPort = Number(options.apiPort || cfg.port || 0) || null;
  const display = safeString(options.display || process.env.IB_GATEWAY_DISPLAY || process.env.DISPLAY || DEFAULT_DISPLAY) || DEFAULT_DISPLAY;
  const vncPort = Number(options.vncPort || process.env.IB_GATEWAY_VNC_PORT || DEFAULT_VNC_PORT) || DEFAULT_VNC_PORT;

  const [psOutput, ssOutput, tcpOpen] = await Promise.all([
    execFileText('/bin/ps', ['-eww', '-o', 'pid,user,args']),
    execFileText('/usr/sbin/ss', ['-ltnp']),
    tcpPortOpen(apiHost, apiPort),
  ]);

  const rows = parseProcessRows(psOutput);
  const gatewayProcess = rows.find(isGatewayProcess) || null;
  const vncByProcess = rows.some(isVncProcess);
  const listeningPorts = parseListeningPorts(ssOutput);
  const vncRunning = vncByProcess || listeningPorts.has(vncPort);

  let readiness = null;
  try {
    readiness = options.readiness || await interactiveBrokersPreviewService.getConnectionReadiness();
  } catch (err) {
    readiness = { ok: false, error: err?.message || String(err), status: 'error' };
  }

  const apiPortOpen = readiness?.gatewayReachable === true || listeningPorts.has(apiPort) || tcpOpen;
  const connected = readiness?.gatewayReachable === true && (readiness?.connected === true || readiness?.ibApiVerified === true);
  const authenticated = readiness?.sessionVerified === true || readiness?.paperAccountVerified === true;
  const gatewayProcessRunning = Boolean(gatewayProcess);
  const nextActionSv = buildNextAction({
    gatewayProcessRunning,
    apiPortOpen,
    authenticated,
    connected,
    readinessStatus: readiness?.status,
  });

  return {
    ok: true,
    gatewayProcessRunning,
    gatewayProcessCommand: sanitizeCommand(gatewayProcess?.command),
    vncRunning,
    display,
    apiHost,
    apiPort,
    apiPortOpen,
    authenticated,
    connected,
    readinessStatus: readiness?.status || 'unknown',
    readinessBlockedReason: readiness?.blockedReason || null,
    paperOnly: true,
    safety: { ...SAFETY },
    lastCheckedAt: now,
    nextActionSv,
  };
}

module.exports = {
  SAFETY,
  getGatewayHealth,
  _internal: {
    buildNextAction,
    parseListeningPorts,
    parseProcessRows,
    sanitizeCommand,
  },
};
