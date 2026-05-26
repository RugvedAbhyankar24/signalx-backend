import express from 'express';
import { fetchGapData, fetchGapDataFromYahoo, fetchOHLCV, fetchMarketMovers, fastMarketScan, resolveNSESymbol } from '../services/marketData.js';
import {
  detectVolumeSpike,
  calculateIntradayVWAP,
  supportResistance,
  estimateATRPercent,
  selectIntradaySessionCandles,
  getEMAStack,
  calculateMACD,
  calculateBollingerBands,
  getPreviousDayLevels,
  getVolumeTrend,
  calculateADX,
  calculateSupertrend,
  calculateOBV,
  calculateVWAPBands,
  detectCandlePattern
} from '../services/technicalIndicators.js';
import { computeRSI } from '../services/rsiCalculator.js';
import { evaluateIntraday, calculateIntradayEntryPrice } from '../services/positionEvaluator.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { getEventRiskProfile } from '../services/eventRiskService.js';
import { fetchMicrostructureSnapshot } from '../services/microstructureService.js';
import { fetchMarketActivityProfile } from '../services/marketActivityService.js';
import { buildProfessionalGate } from '../services/professionalDeskService.js';

const router = express.Router();
const compliance = {
  jurisdiction: 'IN',
  advisoryOnly: true,
  recommendationType: 'educational-screening',
  riskDisclosure: 'Do not treat this as investment advice. Validate with your own risk checks and a SEBI-registered advisor before any trade.',
};
const IST_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});
const NSE_HOLIDAYS = new Set(
  String(process.env.NSE_HOLIDAYS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
const intradayStartLimiter = createRateLimiter({
  windowMs: Number(process.env.INTRADAY_START_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.INTRADAY_START_RATE_LIMIT_MAX || 6),
  keyFn: (req) => `${req.ip}:intraday:start`,
  message: 'Too many intraday start requests.'
});
const intradayScanLimiter = createRateLimiter({
  windowMs: Number(process.env.INTRADAY_SCAN_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.INTRADAY_SCAN_RATE_LIMIT_MAX || 12),
  keyFn: (req) => `${req.ip}:intraday:scan`,
  message: 'Too many intraday scan requests.'
});

// 🗄️ Background scan cache
let intradayCache = {
  status: 'idle',
  results: [],
  updatedAt: null,
  error: null
};

// 🚀 Background worker with concurrency control
async function mapWithConcurrency(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(item => {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Symbol processing timeout')), 20000)
        );
        return Promise.race([
          fn(item),
          timeoutPromise
        ]).catch(err => ({ error: err.message, item }));
      })
    );
    results.push(...batchResults);
  }
  return results;
}

function isFiniteOHLC(candle) {
  const open = Number(candle?.open);
  const high = Number(candle?.high);
  const low = Number(candle?.low);
  const close = Number(candle?.close);
  return (
    Number.isFinite(open) &&
    Number.isFinite(high) &&
    Number.isFinite(low) &&
    Number.isFinite(close) &&
    high >= low
  );
}

function selectCandlesForTechnicals(candles, minCount = 20) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const tradable = candles.filter(c => {
    const volume = Number(c?.volume);
    return isFiniteOHLC(c) && Number.isFinite(volume) && volume > 0;
  });
  if (tradable.length >= minCount) return tradable;

  const priced = candles.filter(isFiniteOHLC);
  return priced.length ? priced : [];
}

// 📊 Deep scan single symbol
// backgroundMode=true → Yahoo-only path (no NSE mutex calls at all) + skip the
// 3 NSE-dependent enrichment services.  Makes background scans fast regardless
// of NSE availability.  buildProfessionalGate handles null inputs gracefully.
async function deepScanSymbol(symbol, { backgroundMode = false } = {}) {
  try {
    const scanSymbol = extractSymbol(symbol);
    if (!scanSymbol) return { symbol: String(symbol ?? ''), error: 'Invalid NSE symbol' };
    symbol = scanSymbol;

    const normalized = normalizeIndian(symbol);
    if (isLikelyInvalidSymbol(symbol)) {
      return { symbol, error: 'Invalid NSE symbol' };
    }

    // backgroundMode: skip resolveNSESymbol (NSE mutex call) + use Yahoo-only
    // gap fetch so the background scan never touches the NSE serialised lock.
    // Also use daily candles (not 5m) so evaluation is meaningful even when the
    // market is closed — 5m session candles are empty outside trading hours and
    // cause everything to evaluate as "Range-Bound – Wait".
    const resolvedSymbol = backgroundMode ? normalized : await resolveNSESymbol(symbol);
    const gapData = backgroundMode
      ? await fetchGapDataFromYahoo(normalized)
      : await fetchGapData(resolvedSymbol);

    // backgroundMode: fetch daily candles (same window as swing) so indicators
    // have enough data regardless of whether the market is currently open.
    const candles = backgroundMode
      ? await fetchOHLCV(normalized, Math.max(60, 14 + 20))
      : await fetchOHLCV(normalized, Math.max(60, 14 + 20), { interval: '5m', range: '5d' });

    const technicalCandles = selectCandlesForTechnicals(candles, 20);

    // backgroundMode: all daily candles act as the "session" — no intraday
    // session filtering needed.  Live mode: filter to today's 5m session.
    const intradaySessionCandles = backgroundMode
      ? technicalCandles
      : selectIntradaySessionCandles(technicalCandles);

    const intradayRsiCandles = intradaySessionCandles.length >= 15 ? intradaySessionCandles : technicalCandles;
    const closes = intradayRsiCandles.map(c => c.close);
    const lastCandle = intradaySessionCandles[intradaySessionCandles.length - 1] || technicalCandles[technicalCandles.length - 1] || candles[candles.length - 1];
    const rsi = computeRSI(closes, 14);

    const volumeData   = detectVolumeSpike(intradaySessionCandles);
    const vwap         = calculateIntradayVWAP(intradaySessionCandles);
    const { support, resistance } = supportResistance(intradaySessionCandles);
    const volatilityPct = estimateATRPercent(intradaySessionCandles, 14);
    const emaStack       = getEMAStack(technicalCandles);
    const macd           = calculateMACD(technicalCandles.map(c => c.close));
    const bollingerBands = calculateBollingerBands(intradaySessionCandles);
    const prevDayLevels  = getPreviousDayLevels(technicalCandles);
    const volumeTrend    = getVolumeTrend(intradaySessionCandles);
    const adx            = calculateADX(intradaySessionCandles);
    const supertrend     = calculateSupertrend(intradaySessionCandles);
    const obvData        = calculateOBV(intradaySessionCandles);
    const vwapBands      = calculateVWAPBands(intradaySessionCandles);
    const candlePattern  = detectCandlePattern(intradaySessionCandles);

    const candleColor = lastCandle
      ? (lastCandle.close > lastCandle.open ? 'green' : lastCandle.close < lastCandle.open ? 'red' : 'neutral')
      : 'neutral';

    const intradayView = evaluateIntraday({
      rsi, gapOpenPct: gapData.gapOpenPct, gapNowPct: gapData.gapNowPct,
      volumeSpike: volumeData.volumeSpike, price: gapData.currentPrice,
      vwap, support, resistance, candleColor, marketCap: gapData.marketCap,
      emaStack, adx, supertrend, candlePattern, obvData, vwapBands
    });
    const intradayDirection = inferIntradayBiasDirection(intradayView) || 'long'

    const entryPriceData = calculateIntradayEntryPrice({
      price: gapData.currentPrice, vwap, support, resistance, rsi,
      candleColor, gapOpenPct: gapData.gapOpenPct, volumeSpike: volumeData.volumeSpike,
      volatilityPct,
      direction: intradayDirection
    });
    // backgroundMode: skip the 3 NSE-dependent enrichment services entirely
    const [eventRisk, microstructure, marketActivity] = backgroundMode
      ? [null, null, null]
      : await Promise.all([
          getEventRiskProfile(symbol),
          fetchMicrostructureSnapshot(symbol),
          fetchMarketActivityProfile(symbol, { biasDirection: intradayDirection }),
        ]);
    const professionalGate = buildProfessionalGate({
      mode: 'intraday',
      signalView: intradayView,
      eventRisk,
      microstructure,
      marketActivity,
    });
    const executionMeta = buildIntradayExecutionMeta({
      marketState: { isOpen: true, reason: 'market_open' },
      intradayView,
      entryPriceData,
      fallbackDirection: intradayDirection,
      professionalGate,
    });

    return {
      symbol, normalizedSymbol: normalized, companyName: gapData.companyName || symbol,
      gapOpenPct: gapData.gapOpenPct, gapNowPct: gapData.gapNowPct,
      prevClose: gapData.prevClose, open: gapData.open, currentPrice: gapData.currentPrice,
      marketCap: gapData.marketCap, priceSource: gapData.priceSource, rsi, candleColor,
      volume: volumeData, vwap, support, resistance,
      volatilityPct: Number.isFinite(volatilityPct) ? Number(volatilityPct.toFixed(2)) : null,

      // ── EMA Regime (trend context) ────────────────────────────────────────
      emaTrend:      emaStack?.regime ?? 'unknown',
      ema20:         emaStack?.ema20   ?? null,
      ema50:         emaStack?.ema50   ?? null,
      bullishStack:  emaStack?.bullishStack  ?? null,
      bearishStack:  emaStack?.bearishStack  ?? null,

      // ── MACD (momentum confirmation) ──────────────────────────────────────
      macd: {
        value:       macd?.macd        ?? null,
        signal:      macd?.signal      ?? null,
        histogram:   macd?.histogram   ?? null,
        bullish:     macd?.bullish     ?? null,
        bullishCross: macd?.bullishCross ?? null,
        histExpanding: macd?.histExpanding ?? null,
      },

      // ── Bollinger Bands (volatility / squeeze) ────────────────────────────
      bollingerBands: {
        upper:     bollingerBands?.upper      ?? null,
        middle:    bollingerBands?.middle     ?? null,
        lower:     bollingerBands?.lower      ?? null,
        squeeze:   bollingerBands?.squeeze    ?? null,
        percentB:  bollingerBands?.percentB   ?? null,
        bandwidth: bollingerBands?.bandwidth  ?? null,
      },

      // ── Previous Day Levels (S/R anchors) ────────────────────────────────
      pdh: prevDayLevels?.pdh ?? null,
      pdl: prevDayLevels?.pdl ?? null,
      pdc: prevDayLevels?.pdc ?? null,

      // ── Volume Trend (momentum conviction) ───────────────────────────────
      volumeTrend: volumeTrend?.trend ?? 'unknown',

      // ── ADX (trend strength) ──────────────────────────────────────────────
      adx: {
        value:       adx?.adx       ?? null,
        plusDI:      adx?.plusDI    ?? null,
        minusDI:     adx?.minusDI   ?? null,
        trending:    adx?.trending  ?? null,
        strongTrend: adx?.strongTrend ?? null,
        direction:   adx?.direction ?? null,
      },

      // ── Supertrend ────────────────────────────────────────────────────────
      supertrend: {
        trend:          supertrend?.trend          ?? null,
        supertrendLine: supertrend?.supertrendLine ?? null,
        crossUp:        supertrend?.crossUp        ?? null,
        crossDown:      supertrend?.crossDown      ?? null,
        distancePct:    supertrend?.distancePct    ?? null,
      },

      // ── OBV (volume divergence) ───────────────────────────────────────────
      obv: {
        value:      obvData?.obv        ?? null,
        rising:     obvData?.rising     ?? null,
        divergence: obvData?.divergence ?? 'none',
      },

      // ── VWAP Bands (±1σ / ±2σ) ───────────────────────────────────────────
      vwapBands: {
        sd1Upper:  vwapBands?.sd1Upper  ?? null,
        sd1Lower:  vwapBands?.sd1Lower  ?? null,
        sd2Upper:  vwapBands?.sd2Upper  ?? null,
        sd2Lower:  vwapBands?.sd2Lower  ?? null,
        aboveSD2:  vwapBands?.aboveSD2  ?? null,
        belowSD2:  vwapBands?.belowSD2  ?? null,
      },

      // ── Candlestick Pattern ───────────────────────────────────────────────
      candlePattern: {
        pattern:   candlePattern?.pattern   ?? 'none',
        direction: candlePattern?.direction ?? 'neutral',
        strength:  candlePattern?.strength  ?? 'none',
      },

      resolvedSymbol, intradayView,
      eventRisk, microstructure, marketActivity, professionalGate,
      finalSentiment: intradayView.sentiment,
      direction: executionMeta.executionDirection || executionMeta.biasDirection,
      biasDirection: executionMeta.biasDirection,
      executionDirection: executionMeta.executionDirection,
      blockerReason: executionMeta.blockerReason,
      setupPhase: intradayView?.setupPhase || 'ready',

      entryPrice: entryPriceData.entryPrice, stopLoss: entryPriceData.stopLoss,
      target1: entryPriceData.target1, target2: entryPriceData.target2,
      entryReason: entryPriceData.entryReason, entryType: entryPriceData.entryType,
      actionableEntryQuality: entryPriceData.actionableEntryQuality,
      riskReward: entryPriceData.riskReward,
      riskRewardAfterCosts: entryPriceData.riskRewardAfterCosts,
      riskRewardGross: entryPriceData.riskRewardGross,
      estimatedRoundTripCostPerShare: entryPriceData.estimatedRoundTripCostPerShare,
      estimatedRoundTripCostPct: entryPriceData.estimatedRoundTripCostPct,

      // ── Position Sizing (₹1L model) ───────────────────────────────────────
      suggestedQty:           entryPriceData.suggestedQty           ?? null,
      suggestedPositionValue: entryPriceData.suggestedPositionValue ?? null,
      capitalUtilizationPct:  entryPriceData.capitalUtilizationPct  ?? null,
    };
  } catch (e) {
    return { symbol, error: e.message || 'Failed to process symbol' };
  }
}

// 🔥 Background scan worker
async function startIntradayBackgroundScan() {
  if (intradayCache.status === 'running') return;

  console.log('🚀 Starting background intraday scan...');
  intradayCache.status = 'running';
  intradayCache.error = null;

  try {
    const fast50 = await fastMarketScan();
    // fastMarketScan already filters Nifty 500 down to the top movers by
    // composite score (default cap 50). Background mode is Yahoo-only so each
    // symbol is fast (~2 network calls). Scan all returned symbols.
    const symbols = fast50;
    console.log(`📊 Background scanning ${symbols.length} symbols from Nifty 500 (fast mode)...`);

    const results = await mapWithConcurrency(
      symbols,
      5, // Higher concurrency is safe — fewer calls per symbol now
      async (stock) => deepScanSymbol(stock?.symbol ?? stock, { backgroundMode: true })
    );

    const errored = results.filter(r => r.error);
    if (errored.length) console.warn(`⚠️  Intraday scan: ${errored.length}/${results.length} symbols errored`);

    // Background cache: keep all positive-sentiment stocks. "watch_setup" /
    // "trigger building" setups are valid candidate stocks — the UI can layer
    // on additional qualification when the market is live.  Only drop hard
    // errors and non-actionable entry types (scalp_only / invalid).
    const positiveResults = results.filter(r =>
      !r.error &&
      r.intradayView?.sentiment === 'positive' &&
      r.entryType !== 'scalp_only' &&
      r.entryType !== 'invalid'
    );
    const negativeResults = results.filter(r =>
      !r.error &&
      r.intradayView?.sentiment === 'negative' &&
      (r.executionDirection === 'short' || r.direction === 'short' || r.intradayView?.executionDirection === 'short') &&
      r.entryType !== 'scalp_only' &&
      r.entryType !== 'invalid'
    );
    intradayCache.results = [...positiveResults, ...negativeResults];

    intradayCache.status = 'done';
    intradayCache.updatedAt = Date.now();
    console.log(`✅ Background scan completed: ${positiveResults.length} long + ${negativeResults.length} short setups`);
  } catch (error) {
    console.error('❌ Background scan error:', error);
    intradayCache.status = 'error';
    intradayCache.error = error.message;
  }
}

// 📡 POST /scan/intraday/start - Start background scan
router.post('/start', intradayStartLimiter, async (req, res) => {
  const marketState = getIndianMarketState();
  // forceRunWhenClosed defaults to true so the frontend always gets results
  // (useful outside market hours for reviewing setups; the scan will return
  //  empty or stale data which the UI handles gracefully)
  const forceRunWhenClosed = parseBooleanFlag(req.body?.forceRunWhenClosed, true);
  if (!marketState.isOpen && !forceRunWhenClosed) {
    return res.json({
      status: 'market_closed',
      marketState,
      compliance
    });
  }

  startIntradayBackgroundScan(); // fire & forget
  res.json({ status: 'scan_started', marketState, compliance });
});

// 📡 GET /scan/intraday/status - Get cached results
router.get('/status', (req, res) => {
  const allResults = intradayCache.results || [];
  const positiveStocks = allResults.filter(r => r.intradayView?.sentiment === 'positive');
  const negativeStocks = allResults.filter(r => r.intradayView?.sentiment === 'negative');
  res.json({
    ...intradayCache,
    positiveStocks,
    negativeStocks,
    compliance
  });
});

function normalizeIndian(symbol) {
  if (!symbol) return symbol;
  const s = String(symbol).trim().toUpperCase();
  if (s.endsWith('.NS') || s.endsWith('.BO')) return s;
  return `${s}.NS`;
}

function isLikelyInvalidSymbol(symbol) {
  return symbol.includes(' ') || symbol.length < 2;
}

function extractSymbol(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.symbol === 'string') return input.symbol;
  return '';
}

function sanitizeRSIPeriod(input, fallback = 14) {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return fallback;
  const asInt = Math.round(parsed);
  if (asInt < 2) return 2;
  if (asInt > 50) return 50;
  return asInt;
}

function parseBooleanFlag(input, fallback = false) {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'string') {
    const val = input.trim().toLowerCase();
    if (val === 'true') return true;
    if (val === 'false') return false;
  }
  return fallback;
}

function inferIntradayBiasDirection(view) {
  if (view?.biasDirection === 'short' || view?.tradeDirection === 'short') return 'short';
  if (view?.biasDirection === 'long' || view?.tradeDirection === 'long') return 'long';
  if (view?.sentiment === 'negative') return 'short';
  if (view?.sentiment === 'positive') return 'long';
  return null;
}

function buildIntradayExecutionMeta({ marketState, intradayView, entryPriceData, fallbackDirection, professionalGate = null }) {
  const biasDirection = inferIntradayBiasDirection(intradayView) || fallbackDirection || 'long';
  const riskReward = Number.parseFloat(entryPriceData?.riskReward);
  const hasValidRr = Number.isFinite(riskReward) && riskReward >= 1;
  const entryType = entryPriceData?.entryType || 'invalid';
  const isWatchPhase = intradayView?.setupPhase === 'watch';
  const qualifies =
    marketState?.isOpen &&
    ['positive', 'negative'].includes(intradayView?.sentiment) &&
    !isWatchPhase &&
    !professionalGate?.blocked &&
    !['scalp_only', 'rr_weak', 'invalid'].includes(entryType) &&
    hasValidRr;

  let blockerReason = null;
  if (!marketState?.isOpen) blockerReason = marketState?.reason || 'market_closed';
  else if (isWatchPhase) blockerReason = intradayView?.blockerReason || 'watch_setup';
  else if (professionalGate?.blocked) blockerReason = professionalGate.blockerReason || 'professional_gate_blocked';
  else if (entryType === 'scalp_only') blockerReason = 'scalp_only';
  else if (entryType === 'rr_weak') blockerReason = 'rr_weak';
  else if (entryType === 'invalid') blockerReason = 'invalid_entry_plan';
  else if (!hasValidRr) blockerReason = 'rr_below_threshold';
  else if (!['positive', 'negative'].includes(intradayView?.sentiment)) blockerReason = intradayView?.blockerReason || 'no_trade_signal';

  return {
    biasDirection,
    executionDirection: qualifies
      ? (entryPriceData?.direction || intradayView?.executionDirection || biasDirection)
      : null,
    qualifies,
    blockerReason: qualifies ? null : (blockerReason || intradayView?.blockerReason || null)
  };
}

function getIndianMarketState(now = new Date()) {
  const parts = IST_PARTS_FORMATTER.formatToParts(now);
  const pick = (type) => parts.find(p => p.type === type)?.value || '';

  const weekday = pick('weekday');
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const hour = Number(pick('hour'));
  const minute = Number(pick('minute'));

  const istDate = `${year}-${month}-${day}`;
  const mins = hour * 60 + minute;
  const sessionOpen = 9 * 60 + 15;
  const sessionClose = 15 * 60 + 30;
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  const isHoliday = NSE_HOLIDAYS.has(istDate);
  const isSessionTime = mins >= sessionOpen && mins <= sessionClose;
  const isOpen = !isWeekend && !isHoliday && isSessionTime;

  let reason = 'market_open';
  if (isWeekend) reason = 'weekend';
  else if (isHoliday) reason = 'configured_holiday';
  else if (!isSessionTime) reason = 'outside_trading_hours_ist';

  return {
    isOpen,
    reason,
    istDate,
    istTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

router.post('/', intradayScanLimiter, async (req, res) => {
  const {
    symbols,
    rsiPeriod = 14,
    useTwoStageScan = true,
    forceRunWhenClosed = false
  } = req.body || {};
  const effectiveRSIPeriod = sanitizeRSIPeriod(rsiPeriod, 14);
  const marketState = getIndianMarketState();

  if (!marketState.isOpen && !parseBooleanFlag(forceRunWhenClosed, false)) {
    return res.json({
      positiveStocks: [],
      negativeStocks: [],
      totalScanned: 0,
      positiveCount: 0,
      negativeCount: 0,
      compliance,
      meta: {
        rsiPeriod: effectiveRSIPeriod,
        scanType: useTwoStageScan ? 'two-stage-institutional' : 'improved-filter',
        institutionalFiltering: true,
        marketState
      }
    });
  }

  try {
    // If no symbols provided, use institutional-grade scanning
    let symbolsToScan = symbols;
    if (!symbols || symbols.length === 0) {
      if (useTwoStageScan) {
        // TWO-STAGE SCANNING (PRO LEVEL)
        // Stage 1 - Fast scan (cheap) - get 30-50 qualified stocks
        const fastScanResults = await fastMarketScan();
        console.log(`🔍 Stage 1: Fast scanned ${fastScanResults.length} stocks`);

        // Stage 2 - Deep scan (expensive) - apply full technical analysis
        console.log('🔬 Stage 2: Deep scanning with technical analysis...');
        symbolsToScan = fastScanResults.map(stock => stock.symbol);
      } else {
        // Legacy approach - use improved fetchMarketMovers
        const marketMovers = await fetchMarketMovers();
        symbolsToScan = marketMovers.map(stock => stock.symbol);
      }
    }

    if (!Array.isArray(symbolsToScan) || symbolsToScan.length === 0) {
      return res.status(400).json({ error: 'No symbols to scan' });
    }

    console.log(`📊 Processing ${symbolsToScan.length} symbols with full analysis...`);

    // Use concurrency-controlled mapping (same as background scan) so we don't
    // blast all API calls at once when symbolsToScan is large. Promise.all with
    // 30+ symbols in parallel trips rate limits on both Yahoo Finance and NSE,
    // causing cascading failures and partial results.
    const results = await mapWithConcurrency(
      symbolsToScan,
      3,
      async (symbol) => {
        try {
          const normalized = normalizeIndian(symbol);
          if (isLikelyInvalidSymbol(symbol)) {
            return {
              symbol,
              error: 'Invalid NSE symbol. Please select from suggestions.'
            };
          }

          /* =====================
             PRICE + GAP (NSE)
          ====================== */
          const resolvedSymbol = await resolveNSESymbol(symbol);
          const gapData = await fetchGapData(resolvedSymbol);

          /* =====================
             OHLCV (Yahoo)
          ====================== */
          const candles = await fetchOHLCV(
            resolvedSymbol,
            Math.max(60, effectiveRSIPeriod + 20),
            { interval: '5m', range: '5d' }
          );
          const technicalCandles = selectCandlesForTechnicals(candles, Math.max(20, effectiveRSIPeriod + 1));
          const intradaySessionCandles = selectIntradaySessionCandles(technicalCandles);
          const intradayRsiCandles = intradaySessionCandles.length >= effectiveRSIPeriod + 1 ? intradaySessionCandles : technicalCandles;
          const closes = intradayRsiCandles.map(c => c.close);
          const lastCandle = intradaySessionCandles[intradaySessionCandles.length - 1] || technicalCandles[technicalCandles.length - 1] || candles[candles.length - 1];

          /* =====================
             RSI
          ====================== */
          const rsi = computeRSI(closes, effectiveRSIPeriod);

          /* =====================
             TECHNICALS
          ====================== */
          const volumeData     = detectVolumeSpike(intradaySessionCandles);
          const vwap           = calculateIntradayVWAP(intradaySessionCandles);
          const { support, resistance } = supportResistance(intradaySessionCandles);
          const volatilityPct  = estimateATRPercent(intradaySessionCandles, 14);
          const emaStack       = getEMAStack(technicalCandles);
          const macd           = calculateMACD(technicalCandles.map(c => c.close));
          const bollingerBands = calculateBollingerBands(intradaySessionCandles);
          const prevDayLevels  = getPreviousDayLevels(technicalCandles);
          const volumeTrend    = getVolumeTrend(intradaySessionCandles);
          const adx            = calculateADX(intradaySessionCandles);
          const supertrend     = calculateSupertrend(intradaySessionCandles);
          const obvData        = calculateOBV(intradaySessionCandles);
          const vwapBands      = calculateVWAPBands(intradaySessionCandles);
          const candlePattern  = detectCandlePattern(intradaySessionCandles);

          const candleColor =
            lastCandle && lastCandle.close > lastCandle.open
              ? 'green'
              : lastCandle && lastCandle.close < lastCandle.open
              ? 'red'
              : 'neutral';

          /* =====================
             INTRADAY EVALUATION
          ====================== */
          const intradayView = evaluateIntraday({
            rsi,
            gapOpenPct: gapData.gapOpenPct,
            gapNowPct: gapData.gapNowPct,
            volumeSpike: volumeData.volumeSpike,
            price: gapData.currentPrice,
            vwap,
            support,
            resistance,
            candleColor,
            marketCap: gapData.marketCap,
            emaStack,
            adx,
            supertrend,
            candlePattern,
            obvData,
            vwapBands
          });
          const intradayDirection = inferIntradayBiasDirection(intradayView) || 'long'

          /* =====================
             ENTRY PRICE CALCULATION
          ====================== */
          const entryPriceData = calculateIntradayEntryPrice({
            price: gapData.currentPrice,
            vwap,
            support,
            resistance,
            rsi,
            candleColor,
            gapOpenPct: gapData.gapOpenPct,
            volumeSpike: volumeData.volumeSpike,
            volatilityPct,
            direction: intradayDirection
          });
          const [eventRisk, microstructure, marketActivity] = await Promise.all([
            getEventRiskProfile(symbol),
            fetchMicrostructureSnapshot(symbol),
            fetchMarketActivityProfile(symbol, { biasDirection: intradayDirection }),
          ]);
          const professionalGate = buildProfessionalGate({
            mode: 'intraday',
            signalView: intradayView,
            eventRisk,
            microstructure,
            marketActivity,
          });
          const executionMeta = buildIntradayExecutionMeta({
            marketState,
            intradayView,
            entryPriceData,
            fallbackDirection: intradayDirection,
            professionalGate,
          });

          /* =====================
             RESPONSE
          ====================== */
          return {
            symbol,
            normalizedSymbol: normalized,
            companyName: gapData.companyName || symbol,

            gapOpenPct: gapData.gapOpenPct,
            gapNowPct: gapData.gapNowPct,
            prevClose: gapData.prevClose,
            open: gapData.open,
            currentPrice: gapData.currentPrice,

            marketCap: gapData.marketCap ?? null,
            priceSource: gapData.priceSource,

            rsi,
            candleColor,

            volume: volumeData,
            vwap,
            support,
            resistance,
            volatilityPct: Number.isFinite(volatilityPct) ? Number(volatilityPct.toFixed(2)) : null,

            // ── EMA Regime (trend context) ──────────────────────────────────
            emaTrend:     emaStack?.regime      ?? 'unknown',
            ema20:        emaStack?.ema20        ?? null,
            ema50:        emaStack?.ema50        ?? null,
            bullishStack: emaStack?.bullishStack ?? null,
            bearishStack: emaStack?.bearishStack ?? null,

            // ── MACD (momentum confirmation) ────────────────────────────────
            macd: {
              value:        macd?.macd         ?? null,
              signal:       macd?.signal       ?? null,
              histogram:    macd?.histogram    ?? null,
              bullish:      macd?.bullish      ?? null,
              bullishCross: macd?.bullishCross ?? null,
              histExpanding: macd?.histExpanding ?? null,
            },

            // ── Bollinger Bands (volatility / squeeze) ──────────────────────
            bollingerBands: {
              upper:     bollingerBands?.upper     ?? null,
              middle:    bollingerBands?.middle    ?? null,
              lower:     bollingerBands?.lower     ?? null,
              squeeze:   bollingerBands?.squeeze   ?? null,
              percentB:  bollingerBands?.percentB  ?? null,
              bandwidth: bollingerBands?.bandwidth ?? null,
            },

            // ── Previous Day Levels ─────────────────────────────────────────
            pdh: prevDayLevels?.pdh ?? null,
            pdl: prevDayLevels?.pdl ?? null,
            pdc: prevDayLevels?.pdc ?? null,

            // ── Volume Trend ────────────────────────────────────────────────
            volumeTrend: volumeTrend?.trend ?? 'unknown',

            // ── ADX ─────────────────────────────────────────────────────────
            adx: {
              value:       adx?.adx       ?? null,
              plusDI:      adx?.plusDI    ?? null,
              minusDI:     adx?.minusDI   ?? null,
              trending:    adx?.trending  ?? null,
              strongTrend: adx?.strongTrend ?? null,
              direction:   adx?.direction ?? null,
            },

            // ── Supertrend ───────────────────────────────────────────────────
            supertrend: {
              trend:          supertrend?.trend          ?? null,
              supertrendLine: supertrend?.supertrendLine ?? null,
              crossUp:        supertrend?.crossUp        ?? null,
              crossDown:      supertrend?.crossDown      ?? null,
              distancePct:    supertrend?.distancePct    ?? null,
            },

            // ── OBV ──────────────────────────────────────────────────────────
            obv: {
              value:      obvData?.obv        ?? null,
              rising:     obvData?.rising     ?? null,
              divergence: obvData?.divergence ?? 'none',
            },

            // ── VWAP Bands ───────────────────────────────────────────────────
            vwapBands: {
              sd1Upper:  vwapBands?.sd1Upper  ?? null,
              sd1Lower:  vwapBands?.sd1Lower  ?? null,
              sd2Upper:  vwapBands?.sd2Upper  ?? null,
              sd2Lower:  vwapBands?.sd2Lower  ?? null,
              aboveSD2:  vwapBands?.aboveSD2  ?? null,
              belowSD2:  vwapBands?.belowSD2  ?? null,
            },

            // ── Candlestick Pattern ──────────────────────────────────────────
            candlePattern: {
              pattern:   candlePattern?.pattern   ?? 'none',
              direction: candlePattern?.direction ?? 'neutral',
              strength:  candlePattern?.strength  ?? 'none',
            },

            resolvedSymbol,
            intradayView,
            eventRisk,
            microstructure,
            marketActivity,
            professionalGate,
            finalSentiment: intradayView.sentiment,
            direction: executionMeta.executionDirection || executionMeta.biasDirection,
            biasDirection: executionMeta.biasDirection,
            executionDirection: executionMeta.executionDirection,
            blockerReason: executionMeta.blockerReason,
            setupPhase: intradayView?.setupPhase || 'ready',

            // ── Entry price information ─────────────────────────────────────
            entryPrice: entryPriceData.entryPrice,
            stopLoss: entryPriceData.stopLoss,
            target1: entryPriceData.target1,
            target2: entryPriceData.target2,
            entryReason: entryPriceData.entryReason,
            entryType: entryPriceData.entryType,
            actionableEntryQuality: entryPriceData.actionableEntryQuality,
            riskReward: entryPriceData.riskReward,
            riskRewardAfterCosts: entryPriceData.riskRewardAfterCosts,
            riskRewardGross: entryPriceData.riskRewardGross,
            estimatedRoundTripCostPerShare: entryPriceData.estimatedRoundTripCostPerShare,
            estimatedRoundTripCostPct: entryPriceData.estimatedRoundTripCostPct,

            // ── Position Sizing (₹1L model) ─────────────────────────────────
            suggestedQty:           entryPriceData.suggestedQty           ?? null,
            suggestedPositionValue: entryPriceData.suggestedPositionValue ?? null,
            capitalUtilizationPct:  entryPriceData.capitalUtilizationPct  ?? null,
          };
        } catch (e) {
          return {
            symbol,
            error: e.message || 'Failed to process symbol'
          };
        }
      }
    );

    // Filter only positive intraday stocks (exclude scalp_only entries, poor RR, and watch-phase setups)
    const positiveStocks = results.filter(
      stock => !stock.error &&
              stock.intradayView &&
              stock.intradayView.sentiment === 'positive' &&
              !stock.blockerReason &&                 // Exclude "watch" and other blocked setups
              stock.entryType !== 'scalp_only' &&     // Exclude overextended VWAP entries
              stock.entryType !== 'rr_weak' &&        // Exclude weak RR setups flagged by calculator
              parseFloat(stock.riskRewardAfterCosts ?? stock.riskReward) >= 1.0  // Use net-of-costs RR (consistent with quality scorer)
    );
    const negativeStocks = results.filter(
      stock => !stock.error &&
              stock.intradayView &&
              stock.intradayView.sentiment === 'negative' &&
              (stock.executionDirection === 'short' || stock.direction === 'short') &&
              !stock.blockerReason &&                 // Exclude pending/watch setups on the short side too
              stock.entryType !== 'scalp_only' &&
              stock.entryType !== 'rr_weak' &&
              parseFloat(stock.riskRewardAfterCosts ?? stock.riskReward) >= 1.0  // Use net-of-costs RR (consistent with quality scorer)
    );

    // Composite signal quality score — higher = stronger, cleaner setup
    function computeIntradayQualityScore(s) {
      let score = 0;
      const rr  = Number.parseFloat(s.riskRewardAfterCosts ?? s.riskReward) || 0;
      const rsi = Number.isFinite(s.rsi) ? s.rsi : null;
      const professionalGate = s?.professionalGate || {};

      // Label tier (setup quality)
      const label = s.intradayView?.label || '';
      if (label === 'Strong Intraday Buy')       score += 30;
      else if (label === 'Momentum Continuation') score += 24;
      else if (label === 'Breakout Candidate')    score += 20;
      else if (label === 'Intraday Reversal')     score += 16;

      // Risk-reward after costs (primary ranking driver)
      if (rr >= 2.5)      score += 25;
      else if (rr >= 2.0) score += 20;
      else if (rr >= 1.7) score += 16;
      else if (rr >= 1.5) score += 12;
      else if (rr >= 1.3) score += 8;
      else if (rr >= 1.0) score += 4;

      // EMA trend alignment
      if (s.emaTrend === 'bullish' && !s.bearishStack) score += 10;

      // ADX trend strength bonus
      if (s.adx?.strongTrend) score += 8;
      else if (s.adx?.trending) score += 4;

      // Supertrend fresh cross (highest conviction entry window)
      if (s.supertrend?.crossUp) score += 10;
      else if (s.supertrend?.trend === 'up') score += 4;

      // OBV divergence / conviction
      if (s.obv?.divergence === 'bullish') score += 8;
      else if (s.obv?.rising) score += 3;

      // MACD confirmation
      if (s.macd?.bullishCross)  score += 8;
      else if (s.macd?.bullish)  score += 4;
      if (s.macd?.histExpanding) score += 3;

      // RSI sweet spot (45–62 is prime intraday momentum zone)
      if (rsi !== null) {
        if (rsi >= 45 && rsi <= 62)      score += 8;
        else if (rsi >= 40 && rsi <= 68) score += 4;
        else if (rsi < 32 || rsi > 72)   score -= 5;
      }

      // Volume conviction
      if (s.volume?.volumeSpike) score += 8;
      if (s.volumeTrend === 'rising') score += 4;

      // Bollinger position (squeeze breakout = strong momentum setup)
      if (s.bollingerBands?.squeeze === false && s.bollingerBands?.percentB > 0.7) score += 5;

      // PDH breakout (price above previous day high = genuine breakout)
      if (s.pdh && s.currentPrice > s.pdh) score += 6;

      score -= Math.max(0, Number(professionalGate.scorePenalty) || 0);

      return score;
    }
    positiveStocks.sort((a, b) => computeIntradayQualityScore(b) - computeIntradayQualityScore(a));

    res.json({
      positiveStocks,
      negativeStocks,
      totalScanned: results.length,
      positiveCount: positiveStocks.length,
      negativeCount: negativeStocks.length,
      compliance,
      meta: {
        rsiPeriod: effectiveRSIPeriod,
        scanType: useTwoStageScan ? 'two-stage-institutional' : 'improved-filter',
        stage1Processed: useTwoStageScan ? symbolsToScan.length : null,
        institutionalFiltering: true,
        marketState
      }
    });
  } catch (err) {
    console.error('intraday scan error', err);
    res.status(500).json({ error: 'Failed to scan intraday stocks' });
  }
});

export { startIntradayBackgroundScan };
export default router;
