import fetch from 'node-fetch';
import { fetchNSE } from './marketData.js';

const RBI_MPC_PUBLICATION_URL =
  process.env.RBI_MPC_PUBLICATION_URL || 'https://www.rbi.org.in/scripts/PublicationsView.aspx?id=23139';
const RBI_MPC_FALLBACK_SCHEDULE = [
  { eventDate: '2026-04-06', endDate: '2026-04-08' },
  { eventDate: '2026-06-03', endDate: '2026-06-05' },
  { eventDate: '2026-08-03', endDate: '2026-08-05' },
  { eventDate: '2026-10-05', endDate: '2026-10-07' },
  { eventDate: '2026-12-02', endDate: '2026-12-04' },
  { eventDate: '2027-02-03', endDate: '2027-02-05' },
];

const MONTH_INDEX = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNSEDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const m = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const month = MONTH_INDEX[m[2].toLowerCase()];
  if (month == null) return null;
  const dt = new Date(Date.UTC(Number(m[3]), month, Number(m[1])));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function formatNSEApiDate(date) {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function daysUntil(eventDate, now = new Date()) {
  const start = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const end = Date.UTC(
    eventDate.getUTCFullYear(),
    eventDate.getUTCMonth(),
    eventDate.getUTCDate()
  );
  return Math.round((end - start) / (1000 * 60 * 60 * 24));
}

function parseISODate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dedupeByKey(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key || map.has(key)) continue;
    map.set(key, item);
  }
  return [...map.values()];
}

export async function fetchCompanyStructuredEvents(symbol, options = {}) {
  const normalized = String(symbol || '').trim().toUpperCase().replace(/\.(NS|BO)$/i, '');
  if (!normalized) return [];

  const now = new Date();
  const futureTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 90));
  const fromDate = options.fromDate || formatNSEApiDate(now);
  const toDate = options.toDate || formatNSEApiDate(futureTo);

  const [eventCalendar, boardMeetings] = await Promise.all([
    fetchNSE(`/event-calendar?symbol=${encodeURIComponent(normalized)}&from_date=${fromDate}&to_date=${toDate}`)
      .catch(() => []),
    fetchNSE(`/corporate-board-meetings?index=equities&symbol=${encodeURIComponent(normalized)}`)
      .catch(() => []),
  ]);

  const companyEvents = [];

  for (const row of Array.isArray(eventCalendar) ? eventCalendar : []) {
    const eventDate = parseNSEDate(row?.date);
    if (!eventDate) continue;
    companyEvents.push({
      source: 'NSE event calendar',
      symbol: row?.symbol || normalized,
      companyName: row?.company || null,
      eventType: String(row?.purpose || 'Corporate Event'),
      details: escapeHtml(row?.bm_desc || ''),
      eventDate: toISODate(eventDate),
      daysUntil: daysUntil(eventDate, now),
      structured: true,
    });
  }

  for (const row of Array.isArray(boardMeetings) ? boardMeetings : []) {
    const eventDate = parseNSEDate(row?.bm_date);
    if (!eventDate) continue;
    const dte = daysUntil(eventDate, now);
    if (dte < -3 || dte > 120) continue;
    companyEvents.push({
      source: 'NSE board meetings',
      symbol: row?.bm_symbol || normalized,
      companyName: row?.sm_name || null,
      eventType: String(row?.bm_purpose || 'Board Meeting'),
      details: escapeHtml(row?.bm_desc || ''),
      eventDate: toISODate(eventDate),
      announcedAt: row?.bm_timestamp || null,
      attachment: row?.attachment || null,
      daysUntil: dte,
      structured: true,
    });
  }

  return dedupeByKey(companyEvents, (item) =>
    `${item.symbol}|${item.eventDate}|${item.eventType}|${item.details.slice(0, 80)}`
  )
    .sort((a, b) => a.daysUntil - b.daysUntil)
    .slice(0, Number.isFinite(options.limit) ? options.limit : 25);
}

export async function fetchRBIMpcCalendar() {
  const res = await fetch(RBI_MPC_PUBLICATION_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'en-IN,en;q=0.9',
    },
  });
  if (!res.ok) {
    throw new Error(`RBI publication unavailable (${res.status})`);
  }

  const html = await res.text();
  const text = escapeHtml(html);
  const yearMatch = text.match(/Dates of Meetings of Monetary Policy Committee for (\d{4}-\d{2})/i);
  const season = yearMatch?.[1] || null;
  const scheduleBlockMatch = text.match(
    /Dates of Meetings of Monetary Policy Committee for \d{4}-\d{2}(.*?)(?:II\.\s*Regulation|III\.\s*Debt Manager to Government|IV\.)/i
  );
  const scheduleBlock = scheduleBlockMatch?.[1] || '';

  const rangeRegex = /\d+(?:st|nd|rd|th)\s+([A-Z][a-z]+)\s+(\d{1,2})(?:-(\d{1,2}))?(?:\s+and\s+([A-Z][a-z]+)\s+(\d{1,2}))?,\s*(\d{4})/g;
  const events = [];
  let match;

  while ((match = rangeRegex.exec(scheduleBlock))) {
    const startMonthName = match[1];
    const dayStart = Number(match[2]);
    const sameMonthEndDay = match[3] ? Number(match[3]) : dayStart;
    const endMonthName = match[4] || startMonthName;
    const endDay = match[5] ? Number(match[5]) : sameMonthEndDay;
    const year = Number(match[6]);
    const startMonth = MONTH_INDEX[startMonthName.slice(0, 3).toLowerCase()];
    const endMonth = MONTH_INDEX[endMonthName.slice(0, 3).toLowerCase()];
    if (startMonth == null || endMonth == null) continue;

    const startDate = new Date(Date.UTC(year, startMonth, dayStart));
    const endDate = new Date(Date.UTC(year, endMonth, endDay));
    const lastEvent = events[events.length - 1];
    if (lastEvent && lastEvent.eventDate === toISODate(startDate)) continue;

    events.push({
      source: 'RBI MPC schedule',
      eventType: 'RBI Monetary Policy Committee',
      details: season ? `Official MPC meeting schedule for ${season}` : 'Official MPC meeting schedule',
      eventDate: toISODate(startDate),
      endDate: toISODate(endDate),
      daysUntil: daysUntil(startDate),
      structured: true,
    });
  }

  const filtered = events
    .filter((event) => event.daysUntil >= -7 && event.daysUntil <= 365)
    .sort((a, b) => a.daysUntil - b.daysUntil)
    .slice(0, 12);

  if (filtered.length > 0) return filtered;

  return RBI_MPC_FALLBACK_SCHEDULE
    .map((item) => {
      const startDate = parseISODate(item.eventDate);
      const endDate = parseISODate(item.endDate);
      if (!startDate || !endDate) return null;
      return {
        source: 'RBI MPC schedule',
        eventType: 'RBI Monetary Policy Committee',
        details: 'Fallback MPC schedule for 2026-27; override RBI_MPC_PUBLICATION_URL when RBI updates its source page',
        eventDate: item.eventDate,
        endDate: item.endDate,
        daysUntil: daysUntil(startDate),
        structured: true,
      };
    })
    .filter(Boolean)
    .filter((event) => event.daysUntil >= -7 && event.daysUntil <= 365)
    .sort((a, b) => a.daysUntil - b.daysUntil)
    .slice(0, 12);
}

export async function fetchStructuredEventCalendar(symbol, options = {}) {
  const [companyEvents, rbiEvents] = await Promise.all([
    symbol ? fetchCompanyStructuredEvents(symbol, options).catch(() => []) : Promise.resolve([]),
    fetchRBIMpcCalendar().catch(() => []),
  ]);

  return {
    symbol: symbol || null,
    companyEvents,
    macroEvents: rbiEvents,
    updatedAt: new Date().toISOString(),
  };
}

export function assessStructuredCalendarRisk({ companyEvents = [], macroEvents = [] } = {}) {
  const reasons = [];
  let score = 0;
  let blocked = false;

  const nearestCompanyEvent = companyEvents.find((event) => event.daysUntil >= 0);
  if (nearestCompanyEvent) {
    const text = `${nearestCompanyEvent.eventType} ${nearestCompanyEvent.details}`.toLowerCase();
    const isResultsLike = /(results|earnings|dividend|board meeting|fund raising|buyback|merger|acquisition|stake)/i.test(text);

    if (nearestCompanyEvent.daysUntil <= 1 && isResultsLike) {
      score += 10;
      blocked = true;
      reasons.push(`Structured company event imminent: ${nearestCompanyEvent.eventType} on ${nearestCompanyEvent.eventDate}`);
    } else if (nearestCompanyEvent.daysUntil <= 7) {
      score += 6;
      reasons.push(`Upcoming company event: ${nearestCompanyEvent.eventType} on ${nearestCompanyEvent.eventDate}`);
    }
  }

  const nearestMacroEvent = macroEvents.find((event) => event.daysUntil >= 0);
  if (nearestMacroEvent) {
    if (nearestMacroEvent.daysUntil <= 1) {
      score += 8;
      reasons.push(`RBI policy event imminent: ${nearestMacroEvent.eventDate}`);
    } else if (nearestMacroEvent.daysUntil <= 5) {
      score += 5;
      reasons.push(`RBI policy window approaching: ${nearestMacroEvent.eventDate}`);
    }
  }

  let severity = 'low';
  if (score >= 10) severity = 'high';
  else if (score >= 5) severity = 'medium';

  if (!reasons.length) reasons.push('No structured calendar events nearby');

  return {
    blocked,
    severity,
    score,
    reasons,
    nearestCompanyEvent: nearestCompanyEvent || null,
    nearestMacroEvent: nearestMacroEvent || null,
  };
}
