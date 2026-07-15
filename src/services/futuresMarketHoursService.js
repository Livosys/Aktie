'use strict';

const CME_EQUITY_INDEX_TIMEZONE = 'America/Chicago';
const SESSION_NAME = 'Globex';
const DAILY_MAINTENANCE_START_MINUTES = 16 * 60;
const DAILY_MAINTENANCE_END_MINUTES = 17 * 60;
const SUNDAY_OPEN_MINUTES = 17 * 60;
const FRIDAY_CLOSE_MINUTES = 16 * 60;
const US_RTH_START_MINUTES = (8 * 60) + 30;
const US_RTH_END_MINUTES = 15 * 60;

const SESSION_IDS = Object.freeze({
  ASIA: 'asia',
  EUROPE: 'europe',
  US_PREMARKET: 'us_premarket',
  US_RTH: 'us_rth',
  US_AFTER_HOURS: 'us_after_hours',
  OVERNIGHT: 'overnight',
  MAINTENANCE_BREAK: 'maintenance_break',
  MARKET_CLOSED: 'market_closed',
});

const SESSION_LABELS = Object.freeze({
  [SESSION_IDS.ASIA]: 'Asia',
  [SESSION_IDS.EUROPE]: 'Europe',
  [SESSION_IDS.US_PREMARKET]: 'US Premarket',
  [SESSION_IDS.US_RTH]: 'US RTH',
  [SESSION_IDS.US_AFTER_HOURS]: 'US After Hours',
  [SESSION_IDS.OVERNIGHT]: 'Overnight',
  [SESSION_IDS.MAINTENANCE_BREAK]: 'Maintenance Break',
  [SESSION_IDS.MARKET_CLOSED]: 'Market Closed',
});

// Futures Paper read-only labels in the exchange timezone.
// Boundaries are start-inclusive and end-exclusive.
const OPEN_SESSION_WINDOWS = Object.freeze([
  Object.freeze({ sessionId: SESSION_IDS.ASIA, startMinutes: 0, endMinutes: 60 }),
  Object.freeze({ sessionId: SESSION_IDS.EUROPE, startMinutes: 60, endMinutes: 7 * 60 }),
  Object.freeze({ sessionId: SESSION_IDS.US_PREMARKET, startMinutes: 7 * 60, endMinutes: US_RTH_START_MINUTES }),
  Object.freeze({ sessionId: SESSION_IDS.US_RTH, startMinutes: US_RTH_START_MINUTES, endMinutes: US_RTH_END_MINUTES }),
  Object.freeze({ sessionId: SESSION_IDS.US_AFTER_HOURS, startMinutes: US_RTH_END_MINUTES, endMinutes: DAILY_MAINTENANCE_START_MINUTES }),
  Object.freeze({ sessionId: SESSION_IDS.OVERNIGHT, startMinutes: DAILY_MAINTENANCE_END_MINUTES, endMinutes: 19 * 60 }),
  Object.freeze({ sessionId: SESSION_IDS.ASIA, startMinutes: 19 * 60, endMinutes: 24 * 60 }),
]);

const SESSION_BOUNDARY_NOTE = 'Futures Paper read-only labels in America/Chicago: overnight 17:00-19:00, asia 19:00-01:00, europe 01:00-07:00, us_premarket 07:00-08:30, us_rth 08:30-15:00, us_after_hours 15:00-16:00, maintenance_break 16:00-17:00 CT.';

const WEEKDAY_INDEX = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
});

function chicagoParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CME_EQUITY_INDEX_TIMEZONE,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const weekday = get('weekday');
  const year = get('year');
  const month = get('month');
  const dayOfMonth = get('day');
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  return {
    weekday,
    day: WEEKDAY_INDEX[weekday],
    exchangeLocalDate: year && month && dayOfMonth ? `${year}-${month}-${dayOfMonth}` : null,
    exchangeLocalTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    hour,
    minute,
    minutes: hour * 60 + minute,
  };
}

function classifyOpenSession(minutes) {
  const hit = OPEN_SESSION_WINDOWS.find((window) => (
    minutes >= window.startMinutes && minutes < window.endMinutes
  ));
  const sessionId = hit ? hit.sessionId : SESSION_IDS.MARKET_CLOSED;
  return {
    sessionId,
    sessionLabel: SESSION_LABELS[sessionId] || sessionId,
  };
}

function getCmeEquityIndexFuturesSessionState(now = new Date()) {
  const serverTimestamp = new Date(now).toISOString();
  const local = chicagoParts(now);
  const day = local.day;
  const minutes = local.minutes;

  let isOpen = false;
  let closedReason = null;

  if (day === 0) {
    isOpen = minutes >= SUNDAY_OPEN_MINUTES;
    if (!isOpen) closedReason = 'weekend';
  } else if (day >= 1 && day <= 4) {
    const inMaintenance = minutes >= DAILY_MAINTENANCE_START_MINUTES
      && minutes < DAILY_MAINTENANCE_END_MINUTES;
    isOpen = !inMaintenance;
    if (inMaintenance) closedReason = 'daily_maintenance';
  } else if (day === 5) {
    isOpen = minutes < FRIDAY_CLOSE_MINUTES;
    if (!isOpen) closedReason = 'weekend';
  } else {
    isOpen = false;
    closedReason = 'weekend';
  }

  let sessionMeta;
  if (isOpen) {
    sessionMeta = classifyOpenSession(minutes);
  } else if (closedReason === 'daily_maintenance') {
    sessionMeta = {
      sessionId: SESSION_IDS.MAINTENANCE_BREAK,
      sessionLabel: SESSION_LABELS[SESSION_IDS.MAINTENANCE_BREAK],
    };
  } else {
    sessionMeta = {
      sessionId: SESSION_IDS.MARKET_CLOSED,
      sessionLabel: SESSION_LABELS[SESSION_IDS.MARKET_CLOSED],
    };
  }
  const isRth = sessionMeta.sessionId === SESSION_IDS.US_RTH;

  return {
    isOpen,
    session: SESSION_NAME,
    sessionId: sessionMeta.sessionId,
    sessionLabel: sessionMeta.sessionLabel,
    timezone: CME_EQUITY_INDEX_TIMEZONE,
    exchangeTimezone: CME_EQUITY_INDEX_TIMEZONE,
    exchangeLocalDate: local.exchangeLocalDate,
    exchangeLocalTime: local.exchangeLocalTime,
    exchangeTimestamp: local.exchangeLocalDate && local.exchangeLocalTime
      ? `${local.exchangeLocalDate}T${local.exchangeLocalTime}:00`
      : null,
    serverTimestamp,
    isRth,
    isGlobex: isOpen,
    isMarketOpen: isOpen,
    tradingWindow: 'Sunday 17:00-Friday 16:00 CT',
    maintenanceWindow: '16:00-17:00 CT',
    maintenanceWindowNote: 'Motsvarar normalt 23:00-00:00 svensk tid; UTC skiftar med amerikansk sommar/vintertid.',
    sessionBoundaryNote: SESSION_BOUNDARY_NOTE,
    closedReason,
    description: isOpen
      ? `Futures-sessionen är öppen (${sessionMeta.sessionLabel}).`
      : 'Futures-sessionen är stängd eller i underhållsfönster.',
    nextChangeHint: isOpen
      ? 'Följ sessionen och kontrollerade pauser.'
      : (closedReason === 'daily_maintenance'
        ? 'Vänta tills Globex öppnar igen 17:00 CT.'
        : 'Vänta på nästa Globex-fönster.'),
  };
}

function buildFuturesSessionMetadata(timestamp) {
  if (timestamp == null || timestamp === '') return null;
  const parsed = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  const state = getCmeEquityIndexFuturesSessionState(parsed);
  return {
    session: state.session,
    sessionId: state.sessionId,
    sessionLabel: state.sessionLabel,
    exchangeTimezone: state.exchangeTimezone,
    exchangeLocalDate: state.exchangeLocalDate,
    exchangeLocalTime: state.exchangeLocalTime,
    exchangeTimestamp: state.exchangeTimestamp,
    serverTimestamp: state.serverTimestamp,
    isRth: state.isRth,
    isGlobex: state.isGlobex,
    isMarketOpen: state.isMarketOpen,
    closedReason: state.closedReason,
  };
}

module.exports = {
  CME_EQUITY_INDEX_TIMEZONE,
  SESSION_IDS,
  SESSION_LABELS,
  OPEN_SESSION_WINDOWS,
  getCmeEquityIndexFuturesSessionState,
  buildFuturesSessionMetadata,
  _internal: {
    chicagoParts,
    classifyOpenSession,
  },
};
