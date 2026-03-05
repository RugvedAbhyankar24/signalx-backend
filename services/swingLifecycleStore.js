import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'swingLifecycle.json');

function getISTDateString(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(now);
}

function isWeekend(dateString) {
  const date = new Date(`${dateString}T00:00:00+05:30`);
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function countTradingDaysInclusive(startDate, endDate) {
  if (!startDate || !endDate) return 1;
  let cursor = new Date(`${startDate}T00:00:00+05:30`);
  const end = new Date(`${endDate}T00:00:00+05:30`);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(end.getTime())) return 1;
  if (cursor > end) return 1;

  let count = 0;
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Math.max(count, 1);
}

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function deriveSetupStatus(stock, record, tradeDate) {
  const qualityScore = toFinite(stock?.qualityScore) ?? 0;
  const actionableCode = String(stock?.actionableEntryQuality?.code || '');
  const swingLabel = String(stock?.swingView?.label || '');
  const currentPrice = toFinite(stock?.currentPrice);
  const target1 = toFinite(stock?.target1);
  const target2 = toFinite(stock?.target2);
  const firstSeenDate = record?.firstSeenDate || tradeDate;
  const tradingDaysActive = countTradingDaysInclusive(firstSeenDate, tradeDate);
  const isHighConviction =
    swingLabel === 'High-Quality Swing Setup' ||
    swingLabel === 'Breakout Swing Setup' ||
    swingLabel === 'Support-Based Swing Attempt';
  const isEmerging =
    swingLabel === 'Potential Swing – Needs Confirmation' ||
    swingLabel === 'Consolidation Watch';

  if (target2 != null && currentPrice != null && currentPrice >= target2 * 0.985) {
    return {
      code: 'near_target',
      label: 'Near Target',
      reason: 'Most of the expected swing move has already played out.'
    };
  }

  if (target1 != null && currentPrice != null && currentPrice >= target1 * 0.985) {
    return {
      code: 'near_target',
      label: 'Near Target',
      reason: 'Price is close to the primary swing objective.'
    };
  }

  if (actionableCode === 'avoid_chasing') {
    return {
      code: 'extended_wait_pullback',
      label: 'Extended - Wait for Pullback',
      reason: 'Setup remains valid, but price is extended beyond efficient swing entry.'
    };
  }

  if (actionableCode === 'wait_pullback') {
    return {
      code: 'active_setup',
      label: 'Active Setup',
      reason: 'Setup is active, but better execution may come on a pullback.'
    };
  }

  if (tradingDaysActive === 1) {
    if (isEmerging) {
      return {
        code: 'emerging_setup',
        label: 'Emerging Setup',
        reason: 'Positive swing structure is emerging, but confirmation is still developing.'
      };
    }

    return {
      code: 'fresh_setup',
      label: 'Fresh Setup',
      reason: isHighConviction && qualityScore >= 80
        ? 'High-conviction setup newly triggered today.'
        : 'New swing setup triggered today.'
    };
  }

  if (tradingDaysActive >= 5) {
    return {
      code: 'mature_setup',
      label: 'Mature Setup',
      reason: 'Setup has remained valid across multiple sessions.'
    };
  }

  return {
    code: 'active_setup',
    label: 'Active Setup',
    reason: 'Setup remains valid and can continue across sessions.'
  };
}

async function ensureStore() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await readFile(STORE_PATH, 'utf8');
  } catch {
    await writeFile(
      STORE_PATH,
      JSON.stringify({ lastUpdatedDate: null, symbols: {} }, null, 2),
      'utf8'
    );
  }
}

async function readStore() {
  await ensureStore();
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastUpdatedDate: parsed?.lastUpdatedDate || null,
      symbols: parsed?.symbols && typeof parsed.symbols === 'object' ? parsed.symbols : {}
    };
  } catch {
    return { lastUpdatedDate: null, symbols: {} };
  }
}

async function writeStore(store) {
  await ensureStore();
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

export async function applySwingLifecycle(stocks) {
  const tradeDate = getISTDateString();
  const store = await readStore();
  const nextSymbols = { ...store.symbols };

  const enrichedStocks = (Array.isArray(stocks) ? stocks : []).map((stock) => {
    const symbol = String(stock?.symbol || '').trim().toUpperCase();
    if (!symbol) return stock;

    const previous = nextSymbols[symbol] || null;
    const firstSeenDate =
      previous?.firstSeenDate && previous.firstSeenDate <= tradeDate
        ? previous.firstSeenDate
        : tradeDate;
    const timesSeen = previous?.lastSeenDate === tradeDate
      ? (previous?.timesSeen ?? 1)
      : (previous?.timesSeen ?? 0) + 1;
    const tradingDaysActive = countTradingDaysInclusive(firstSeenDate, tradeDate);
    const setupStatus = deriveSetupStatus(stock, { ...previous, firstSeenDate }, tradeDate);

    const lifecycle = {
      firstSeenDate,
      lastSeenDate: tradeDate,
      tradingDaysActive,
      timesSeen,
      setupStatus,
      isReappearing: firstSeenDate !== tradeDate,
      lifecycleReason: setupStatus.reason
    };

    nextSymbols[symbol] = {
      symbol,
      companyName: stock?.companyName || previous?.companyName || symbol,
      firstSeenDate,
      lastSeenDate: tradeDate,
      timesSeen,
      tradingDaysActive,
      lastSeenPrice: toFinite(stock?.currentPrice),
      lastSeenQualityScore: toFinite(stock?.qualityScore),
      lastActionableCode: String(stock?.actionableEntryQuality?.code || ''),
      lastSetupStatus: setupStatus.code
    };

    return {
      ...stock,
      swingLifecycle: lifecycle
    };
  });

  if (!isWeekend(tradeDate)) {
    store.lastUpdatedDate = tradeDate;
    store.symbols = nextSymbols;
    await writeStore(store);
  }

  return {
    tradeDate,
    stocks: enrichedStocks
  };
}
