import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const PICK_HISTORY_FILE = path.join(DATA_DIR, 'intradayPickEntries.json');

const IST_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function parseIST(dateObj) {
  const parts = IST_PARTS_FORMATTER.formatToParts(dateObj);
  const pick = (type) => parts.find(p => p.type === type)?.value || '';
  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    time: `${pick('hour')}:${pick('minute')}`
  };
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeString(value) {
  const text = String(value || '').trim();
  return text || null;
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await ensureDir();
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function sanitizePickEntries({ positiveStocks, meta }) {
  const now = new Date();
  const ist = parseIST(now);
  const marketState = meta?.marketState || {};
  const istDate = marketState.istDate || ist.date;
  const istTime = marketState.istTime || ist.time;
  const scanId = `intraday-scan-${Date.now()}`;

  const entries = (Array.isArray(positiveStocks) ? positiveStocks : [])
    .map((stock, index) => {
      const symbol = normalizeString(stock?.symbol);
      const entryPrice = toFiniteNumber(stock?.entryPrice);
      if (!symbol || entryPrice == null || entryPrice <= 0) return null;

      return {
        id: `${scanId}-${index}-${symbol}`,
        scanId,
        createdAt: now.toISOString(),
        istDate,
        istTime,
        scanType: normalizeString(meta?.scanType) || 'two-stage-institutional',
        marketStateReason: normalizeString(marketState?.reason) || 'market_open',
        symbol,
        normalizedSymbol: normalizeString(stock?.normalizedSymbol),
        resolvedSymbol: normalizeString(stock?.resolvedSymbol),
        companyName: normalizeString(stock?.companyName),
        entryPrice,
        entryType: normalizeString(stock?.entryType),
        entryReason: normalizeString(stock?.entryReason)
      };
    })
    .filter(Boolean);

  return { scanId, entries };
}

export async function saveIntradayPickEntries({ positiveStocks, totalScanned = 0, meta = {} }) {
  const marketState = meta?.marketState || {};
  if (marketState.isOpen !== true) {
    return {
      savedCount: 0,
      totalScanned: Number(totalScanned) || 0,
      skipped: true,
      reason: 'market_closed'
    };
  }

  const { scanId, entries } = sanitizePickEntries({ positiveStocks, meta });
  if (!entries.length) {
    return {
      scanId,
      savedCount: 0,
      totalScanned: Number(totalScanned) || 0,
      skipped: false
    };
  }

  const history = await readJson(PICK_HISTORY_FILE, { version: 1, entries: [] });
  const existing = Array.isArray(history.entries) ? history.entries : [];
  history.entries = [...entries, ...existing].slice(0, 10000);
  await writeJson(PICK_HISTORY_FILE, history);

  return {
    scanId,
    savedCount: entries.length,
    totalScanned: Number(totalScanned) || 0,
    skipped: false
  };
}

export async function listIntradayPickEntries({ date, limit = 200 } = {}) {
  const normalizedLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  const normalizedDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  const history = await readJson(PICK_HISTORY_FILE, { version: 1, entries: [] });
  let entries = Array.isArray(history.entries) ? history.entries : [];
  if (normalizedDate) entries = entries.filter(e => e?.istDate === normalizedDate);
  return entries.slice(0, normalizedLimit);
}
