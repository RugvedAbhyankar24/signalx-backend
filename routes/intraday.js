import express from 'express';
import { fetchGapData, fetchOHLCV, fetchMarketMovers, fastMarketScan, resolveNSESymbol } from '../services/marketData.js';
import {
  detectVolumeSpike,
  calculateIntradayVWAP,
  supportResistance,
  estimateATRPercent
} from '../services/technicalIndicators.js';
import { computeRSI } from '../services/rsiCalculator.js';
import { evaluateIntraday, calculateIntradayEntryPrice } from '../services/positionEvaluator.js';
import {
  saveIntradaySignalSnapshot,
  listIntradaySignalSnapshots,
  listIntradayBacktestRuns,
  runIntradayBacktest
} from '../services/intradayBacktestService.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

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
const intradayBacktestLimiter = createRateLimiter({
  windowMs: Number(process.env.INTRADAY_BACKTEST_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.INTRADAY_BACKTEST_RATE_LIMIT_MAX || 20),
  keyFn: (req) => `${req.ip}:intraday:backtest`,
  message: 'Too many intraday backtest requests.'
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
      batch.map(item => fn(item).catch(err => ({ error: err.message, item })))
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
async function deepScanSymbol(symbol) {
  try {
    const scanSymbol = extractSymbol(symbol);
    if (!scanSymbol) return { symbol: String(symbol ?? ''), error: 'Invalid NSE symbol' };
    symbol = scanSymbol;

    const normalized = normalizeIndian(symbol);
    if (isLikelyInvalidSymbol(symbol)) {
      return { symbol, error: 'Invalid NSE symbol' };
    }

    const resolvedSymbol = await resolveNSESymbol(symbol);
    const gapData = await fetchGapData(resolvedSymbol);
    const candles = await fetchOHLCV(
      resolvedSymbol,
      Math.max(60, 14 + 20),
      { interval: '5m', range: '5d' }
    );
    const technicalCandles = selectCandlesForTechnicals(candles, 20);
    const closes = technicalCandles.map(c => c.close);
    const lastCandle = technicalCandles[technicalCandles.length - 1] || candles[candles.length - 1];
    const rsi = computeRSI(closes, 14);
    
    const volumeData = detectVolumeSpike(technicalCandles);
    const vwap = calculateIntradayVWAP(technicalCandles);
    const { support, resistance } = supportResistance(technicalCandles);
    const volatilityPct = estimateATRPercent(technicalCandles, 14);
    
    const candleColor = lastCandle
      ? (lastCandle.close > lastCandle.open ? 'green' : lastCandle.close < lastCandle.open ? 'red' : 'neutral')
      : 'neutral';

    const intradayView = evaluateIntraday({
      rsi, gapOpenPct: gapData.gapOpenPct, gapNowPct: gapData.gapNowPct,
      volumeSpike: volumeData.volumeSpike, price: gapData.currentPrice,
      vwap, support, resistance, candleColor, marketCap: gapData.marketCap
    });

    const entryPriceData = calculateIntradayEntryPrice({
      price: gapData.currentPrice, vwap, support, resistance, rsi,
      candleColor, gapOpenPct: gapData.gapOpenPct, volumeSpike: volumeData.volumeSpike,
      volatilityPct
    });

    return {
      symbol, normalizedSymbol: normalized, companyName: gapData.companyName || symbol,
      gapOpenPct: gapData.gapOpenPct, gapNowPct: gapData.gapNowPct,
      prevClose: gapData.prevClose, open: gapData.open, currentPrice: gapData.currentPrice,
      marketCap: gapData.marketCap, priceSource: gapData.priceSource, rsi, candleColor,
      volume: volumeData, vwap, support, resistance,
      volatilityPct: Number.isFinite(volatilityPct) ? Number(volatilityPct.toFixed(2)) : null,
      resolvedSymbol, intradayView,
      finalSentiment: intradayView.sentiment,
      entryPrice: entryPriceData.entryPrice, stopLoss: entryPriceData.stopLoss,
      target1: entryPriceData.target1, target2: entryPriceData.target2,
      entryReason: entryPriceData.entryReason, entryType: entryPriceData.entryType,
      riskReward: entryPriceData.riskReward,
      riskRewardAfterCosts: entryPriceData.riskRewardAfterCosts,
      riskRewardGross: entryPriceData.riskRewardGross,
      estimatedRoundTripCostPerShare: entryPriceData.estimatedRoundTripCostPerShare,
      estimatedRoundTripCostPct: entryPriceData.estimatedRoundTripCostPct
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
    const fast50 = await fastMarketScan(); // Get top 50 stocks
    console.log(`📊 Background scanning ${fast50.length} symbols...`);

    const results = await mapWithConcurrency(
      fast50.slice(0, 50),
      3, // Process 3 symbols at a time
      async (stock) => deepScanSymbol(stock?.symbol ?? stock)
    );

    intradayCache.results = results.filter(r => 
      !r.error && r.intradayView?.sentiment === 'positive' &&
      r.entryType !== 'scalp_only' &&
      r.entryType !== 'rr_weak' &&
      parseFloat(r.riskReward) >= 1.0
    );

    try {
      await saveIntradaySignalSnapshot({
        positiveStocks: intradayCache.results,
        totalScanned: results.length,
        positiveCount: intradayCache.results.length,
        rawPayload: {
          positiveStocks: intradayCache.results,
          totalScanned: results.length,
          positiveCount: intradayCache.results.length,
          compliance
        },
        meta: {
          scanType: 'two-stage-institutional',
          institutionalFiltering: true,
          marketState: getIndianMarketState()
        }
      });
    } catch (persistErr) {
      console.error('Failed to save intraday background snapshot:', persistErr.message || persistErr);
    }

    intradayCache.status = 'done';
    intradayCache.updatedAt = Date.now();
    console.log(`✅ Background scan completed: ${intradayCache.results.length} positive stocks`);
  } catch (error) {
    console.error('❌ Background scan error:', error);
    intradayCache.status = 'error';
    intradayCache.error = error.message;
  }
}

// 📡 POST /scan/intraday/start - Start background scan
router.post('/start', intradayStartLimiter, async (req, res) => {
  const marketState = getIndianMarketState();
  const forceRunWhenClosed = parseBooleanFlag(req.body?.forceRunWhenClosed, false);
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
  res.json({
    ...intradayCache,
    compliance
  });
});

router.get('/backtest/snapshots', intradayBacktestLimiter, async (req, res) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;
    const limit = Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 50;
    const snapshots = await listIntradaySignalSnapshots({ date, limit });
    res.json({
      snapshots,
      count: snapshots.length,
      compliance
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch intraday signal snapshots' });
  }
});

router.get('/backtest/runs', intradayBacktestLimiter, async (req, res) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;
    const limit = Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 30;
    const runs = await listIntradayBacktestRuns({ date, limit });
    res.json({
      runs,
      count: runs.length,
      compliance
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch intraday backtest runs' });
  }
});

router.post('/backtest/run', intradayBacktestLimiter, async (req, res) => {
  try {
    const {
      date,
      capital,
      allocationMode = 'per_pick',
      snapshotMode = 'latest',
      snapshotId,
      requireExactSnapshot = false
    } = req.body || {};

    const run = await runIntradayBacktest({
      date,
      capital,
      allocationMode,
      snapshotMode,
      snapshotId,
      requireExactSnapshot: parseBooleanFlag(requireExactSnapshot, false)
    });

    res.json({
      backtest: run,
      compliance
    });
  } catch (error) {
    const message = error?.message || 'Failed to run intraday backtest'
    const status = /capital|snapshot|No intraday signal snapshots|No valid picks/.test(message) ? 400 : 500
    res.status(status).json({ error: message });
  }
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

function sanitizeSnapshotDateOverride(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
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
    forceRunWhenClosed = false,
    snapshotDateOverride
  } = req.body || {};
  const effectiveRSIPeriod = sanitizeRSIPeriod(rsiPeriod, 14);
  const marketState = getIndianMarketState();
  const normalizedSnapshotDateOverride = sanitizeSnapshotDateOverride(snapshotDateOverride);
  const snapshotMarketState = normalizedSnapshotDateOverride
    ? {
        ...marketState,
        istDate: normalizedSnapshotDateOverride
      }
    : marketState;

  if (!marketState.isOpen && !parseBooleanFlag(forceRunWhenClosed, false)) {
    return res.json({
      positiveStocks: [],
      totalScanned: 0,
      positiveCount: 0,
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

    const results = await Promise.all(
      symbolsToScan.map(async (symbol) => {
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
          const closes = technicalCandles.map(c => c.close);
          const lastCandle = technicalCandles[technicalCandles.length - 1] || candles[candles.length - 1];

          /* =====================
             RSI
          ====================== */
          const rsi = computeRSI(closes, effectiveRSIPeriod);

          /* =====================
             TECHNICALS
          ====================== */
          const volumeData = detectVolumeSpike(technicalCandles);
          const vwap = calculateIntradayVWAP(technicalCandles);
          const { support, resistance } = supportResistance(technicalCandles);
          const volatilityPct = estimateATRPercent(technicalCandles, 14);

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
            marketCap: gapData.marketCap
          });

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
            volatilityPct
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

            resolvedSymbol,
            intradayView,
            finalSentiment: intradayView.sentiment, // Add final sentiment decision
            
            // Entry price information
            entryPrice: entryPriceData.entryPrice,
            stopLoss: entryPriceData.stopLoss,
            target1: entryPriceData.target1,
            target2: entryPriceData.target2,
            entryReason: entryPriceData.entryReason,
            entryType: entryPriceData.entryType,
            riskReward: entryPriceData.riskReward,
            riskRewardAfterCosts: entryPriceData.riskRewardAfterCosts,
            riskRewardGross: entryPriceData.riskRewardGross,
            estimatedRoundTripCostPerShare: entryPriceData.estimatedRoundTripCostPerShare,
            estimatedRoundTripCostPct: entryPriceData.estimatedRoundTripCostPct
          };
        } catch (e) {
          return {
            symbol,
            error: e.message || 'Failed to process symbol'
          };
        }
      })
    );

    // Filter only positive intraday stocks (exclude scalp_only entries and poor RR)
    const positiveStocks = results.filter(
      stock => !stock.error && 
              stock.intradayView && 
              stock.intradayView.sentiment === 'positive' &&
              stock.entryType !== 'scalp_only' && // Exclude overextended VWAP entries
              stock.entryType !== 'rr_weak' && // Exclude weak RR setups flagged by calculator
              parseFloat(stock.riskReward) >= 1.0 // Exclude RR < 1:1
    );

    // Sort by signal strength (you can customize this logic)
    positiveStocks.sort((a, b) => {
      const aScore = a.intradayView.label === 'Strong Intraday Buy' ? 3 :
                    a.intradayView.label === 'Momentum Continuation' ? 2 :
                    a.intradayView.label === 'Breakout Candidate' ? 1 : 0;
      const bScore = b.intradayView.label === 'Strong Intraday Buy' ? 3 :
                    b.intradayView.label === 'Momentum Continuation' ? 2 :
                    b.intradayView.label === 'Breakout Candidate' ? 1 : 0;
      return bScore - aScore;
    });

    let snapshotId = null;
    try {
      const snapshot = await saveIntradaySignalSnapshot({
        positiveStocks,
        totalScanned: results.length,
        positiveCount: positiveStocks.length,
        rawPayload: {
          positiveStocks,
          totalScanned: results.length,
          positiveCount: positiveStocks.length,
          compliance,
          meta: {
            rsiPeriod: effectiveRSIPeriod,
            scanType: useTwoStageScan ? 'two-stage-institutional' : 'improved-filter',
            stage1Processed: useTwoStageScan ? symbolsToScan.length : null,
            institutionalFiltering: true,
            marketState,
            snapshotDateOverride: normalizedSnapshotDateOverride,
            snapshotDateUsed: snapshotMarketState.istDate
          }
        },
        meta: {
          rsiPeriod: effectiveRSIPeriod,
          scanType: useTwoStageScan ? 'two-stage-institutional' : 'improved-filter',
          stage1Processed: useTwoStageScan ? symbolsToScan.length : null,
          institutionalFiltering: true,
          marketState: snapshotMarketState,
          snapshotDateOverride: normalizedSnapshotDateOverride
        }
      });
      snapshotId = snapshot?.id || null;
    } catch (persistErr) {
      console.error('Failed to save intraday snapshot:', persistErr.message || persistErr);
    }

    res.json({
      positiveStocks,
      totalScanned: results.length,
      positiveCount: positiveStocks.length,
      compliance,
      meta: {
        rsiPeriod: effectiveRSIPeriod,
        scanType: useTwoStageScan ? 'two-stage-institutional' : 'improved-filter',
        stage1Processed: useTwoStageScan ? symbolsToScan.length : null,
        institutionalFiltering: true,
        marketState,
        snapshotDateOverride: normalizedSnapshotDateOverride,
        snapshotDateUsed: snapshotMarketState.istDate,
        snapshotId
      }
    });
  } catch (err) {
    console.error('intraday scan error', err);
    res.status(500).json({ error: 'Failed to scan intraday stocks' });
  }
});

export default router;
