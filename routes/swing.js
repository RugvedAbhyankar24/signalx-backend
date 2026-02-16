import express from 'express';
import { fetchGapData, fetchOHLCV, fetchMarketMovers, fastMarketScan } from '../services/marketData.js';
import {
  detectVolumeSpike,
  calculateSwingVWAP,
  supportResistance,
  estimateATRPercent
} from '../services/technicalIndicators.js';
import { computeRSI } from '../services/rsiCalculator.js';
import { evaluateSwing, calculateSwingEntryPrice } from '../services/positionEvaluator.js';
import { resolveNSESymbol } from '../services/marketData.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

const router = express.Router();
const compliance = {
  jurisdiction: 'IN',
  advisoryOnly: true,
  recommendationType: 'educational-screening',
  riskDisclosure: 'Do not treat this as investment advice. Validate with your own risk checks and a SEBI-registered advisor before any trade.',
};
const swingStartLimiter = createRateLimiter({
  windowMs: Number(process.env.SWING_START_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.SWING_START_RATE_LIMIT_MAX || 6),
  keyFn: (req) => `${req.ip}:swing:start`,
  message: 'Too many swing start requests.'
});
const swingScanLimiter = createRateLimiter({
  windowMs: Number(process.env.SWING_SCAN_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.SWING_SCAN_RATE_LIMIT_MAX || 12),
  keyFn: (req) => `${req.ip}:swing:scan`,
  message: 'Too many swing scan requests.'
});

// 🗄️ Background scan cache
let swingCache = {
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

// 📊 Deep scan single symbol for swing
async function deepScanSwingSymbol(symbol) {
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
    const candles = await fetchOHLCV(resolvedSymbol, Math.max(60, 14 + 20));
    const technicalCandles = selectCandlesForTechnicals(candles, 20);
    const closes = technicalCandles.map(c => c.close);
    const lastCandle = technicalCandles[technicalCandles.length - 1] || candles[candles.length - 1];
    const rsi = computeRSI(closes, 14);
    
    const volumeData = detectVolumeSpike(technicalCandles);
    const swingVwap = calculateSwingVWAP(technicalCandles, 5);
    const { support, resistance } = supportResistance(technicalCandles);
    const volatilityPct = estimateATRPercent(technicalCandles, 14);
    
    const candleColor = lastCandle
      ? (lastCandle.close > lastCandle.open ? 'green' : lastCandle.close < lastCandle.open ? 'red' : 'neutral')
      : 'neutral';

    const swingView = evaluateSwing({
      rsi, gapOpenPct: gapData.gapOpenPct, gapNowPct: gapData.gapNowPct, volumeSpike: volumeData.volumeSpike,
      price: gapData.currentPrice, swingVWAP: swingVwap, support, resistance
    });

    const swingEntryPriceData = calculateSwingEntryPrice({
      price: gapData.currentPrice, marketCap: gapData.marketCap, swingVWAP: swingVwap, support, resistance, rsi,
      candleColor, gapOpenPct: gapData.gapOpenPct, gapNowPct: gapData.gapNowPct, volumeSpike: volumeData.volumeSpike,
      volatilityPct
    });

    return {
      symbol, normalizedSymbol: normalized, companyName: gapData.companyName || symbol,
      gapOpenPct: gapData.gapOpenPct, gapNowPct: gapData.gapNowPct,
      prevClose: gapData.prevClose, open: gapData.open, currentPrice: gapData.currentPrice,
      marketCap: gapData.marketCap, priceSource: gapData.priceSource, rsi, candleColor,
      volume: volumeData, vwap: swingVwap, swingVwap: swingVwap, support, resistance,
      volatilityPct: Number.isFinite(volatilityPct) ? Number(volatilityPct.toFixed(2)) : null,
      resolvedSymbol, swingView, finalSentiment: swingView.sentiment,
      entryPrice: swingEntryPriceData.entryPrice, stopLoss: swingEntryPriceData.stopLoss,
      target1: swingEntryPriceData.target1, target2: swingEntryPriceData.target2,
      entryReason: swingEntryPriceData.entryReason, entryType: swingEntryPriceData.entryType,
      riskReward: swingEntryPriceData.riskReward,
      riskRewardAfterCosts: swingEntryPriceData.riskRewardAfterCosts,
      riskRewardGross: swingEntryPriceData.riskRewardGross,
      estimatedRoundTripCostPerShare: swingEntryPriceData.estimatedRoundTripCostPerShare,
      estimatedRoundTripCostPct: swingEntryPriceData.estimatedRoundTripCostPct
    };
  } catch (e) {
    return { symbol, error: e.message || 'Failed to process symbol' };
  }
}

// 🔥 Background scan worker for swing
async function startSwingBackgroundScan() {
  if (swingCache.status === 'running') return;

  console.log('🚀 Starting background swing scan...');
  swingCache.status = 'running';
  swingCache.error = null;

  try {
    const fast50 = await fastMarketScan(); // Get top 50 stocks
    console.log(`📊 Background scanning ${fast50.length} symbols for swing...`);

    const results = await mapWithConcurrency(
      fast50.slice(0, 50),
      3, // Process 3 symbols at a time
      async (stock) => deepScanSwingSymbol(stock?.symbol ?? stock)
    );

    const quality = buildQualitySwingList(results);
    swingCache.results = quality.stocks;

    swingCache.status = 'done';
    swingCache.updatedAt = Date.now();
    console.log(`✅ Background swing scan completed: ${swingCache.results.length} quality stocks`);
  } catch (error) {
    console.error('❌ Background swing scan error:', error);
    swingCache.status = 'error';
    swingCache.error = error.message;
  }
}

// 📡 POST /scan/swing/start - Start background scan
router.post('/start', swingStartLimiter, async (req, res) => {
  startSwingBackgroundScan(); // fire & forget
  res.json({ status: 'scan_started' });
});

// 📡 GET /scan/swing/status - Get cached results
router.get('/status', (req, res) => {
  res.json({
    ...swingCache,
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

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function computeSwingQualityScore(stock) {
  const rr = toFinite(stock?.riskRewardAfterCosts ?? stock?.riskReward) ?? 0;
  const rsi = toFinite(stock?.rsi);
  const gapNow = toFinite(stock?.gapNowPct);
  const volPct = toFinite(stock?.volatilityPct);
  const price = toFinite(stock?.currentPrice);
  const swingVwap = toFinite(stock?.swingVwap ?? stock?.vwap);
  const aboveStructure = price != null && swingVwap != null && price >= swingVwap;
  const entryType = String(stock?.entryType || '');
  const label = String(stock?.swingView?.label || '');
  const volumeSpike = Boolean(stock?.volume?.volumeSpike);

  let score = 0;

  if (label === 'High-Quality Swing Setup') score += 30;
  else if (label === 'Breakout Swing Setup') score += 26;
  else if (label === 'Support-Based Swing Attempt') score += 22;
  else if (label === 'Potential Swing – Needs Confirmation') score += 18;
  else if (label === 'Consolidation Watch') score += 15;

  if (entryType === 'swing_vwap') score += 15;
  else if (entryType === 'swing_breakout') score += 13;
  else if (entryType === 'swing_support') score += 12;
  else if (entryType === 'swing_consolidation') score += 8;
  else if (entryType === 'swing_momentum') score += 6;
  else if (entryType === 'swing_market') score += 2;

  if (rr >= 2.0) score += 22;
  else if (rr >= 1.7) score += 18;
  else if (rr >= 1.5) score += 14;
  else if (rr >= 1.3) score += 10;
  else if (rr >= 1.1) score += 6;
  else if (rr >= 1.0) score += 3;
  else score -= 20;

  if (volumeSpike) score += 8;
  else score += 3;
  if (aboveStructure) score += 6;

  if (rsi != null) {
    if (rsi >= 45 && rsi <= 62) score += 8;
    else if (rsi >= 40 && rsi <= 66) score += 4;
    else if (rsi < 35 || rsi > 70) score -= 5;
  }

  if (gapNow != null) {
    if (gapNow < -2.0) score -= 18;
    else if (gapNow > 7.0) score -= 5;
    else if (gapNow >= -0.5 && gapNow <= 5.5) score += 4;
  }

  if (volPct != null) {
    if (volPct > 6.2) score -= 6;
    else if (volPct >= 2.0 && volPct <= 4.8) score += 3;
  }

  return Math.round(score);
}

function deriveAdaptiveQualityThreshold(scoredCandidates) {
  if (!Array.isArray(scoredCandidates) || scoredCandidates.length === 0) return 40;
  const scores = scoredCandidates
    .map(s => toFinite(s?.qualityScore))
    .filter(v => v != null)
    .sort((a, b) => a - b);
  if (!scores.length) return 40;

  const p60 = scores[Math.floor((scores.length - 1) * 0.6)];
  const median = scores[Math.floor((scores.length - 1) * 0.5)];
  const raw = Math.round((p60 * 0.6) + (median * 0.4));
  return Math.min(Math.max(raw, 34), 56);
}

function buildQualitySwingList(results) {
  const base = results
    .filter(stock =>
      !stock.error &&
      !stock.filtered &&
      stock.swingView &&
      stock.swingView.sentiment === 'positive'
    )
    .map(stock => ({
      ...stock,
      qualityScore: computeSwingQualityScore(stock)
    }))
    .filter(stock => {
      const rr = toFinite(stock.riskRewardAfterCosts ?? stock.riskReward);
      if (rr == null || rr < 1.0) return false;
      if (stock.entryType === 'swing_market') {
        const rsi = toFinite(stock.rsi);
        const gapNow = toFinite(stock.gapNowPct);
        const volumeSpike = Boolean(stock?.volume?.volumeSpike);
        if (!volumeSpike) return false;
        if (rsi != null && (rsi < 38 || rsi > 64)) return false;
        if (gapNow != null && gapNow < -1.8) return false;
      }
      return true;
    });

  const threshold = deriveAdaptiveQualityThreshold(base);
  return {
    qualityThreshold: threshold,
    stocks: base
      .filter(stock => stock.qualityScore >= threshold)
      .sort((a, b) => {
        if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
        return (toFinite(b.riskRewardAfterCosts ?? b.riskReward) ?? 0) - (toFinite(a.riskRewardAfterCosts ?? a.riskReward) ?? 0);
      })
  };
}

router.post('/', swingScanLimiter, async (req, res) => {
  const { symbols, rsiPeriod = 14, useTwoStageScan = true } = req.body || {};
  const effectiveRSIPeriod = sanitizeRSIPeriod(rsiPeriod, 14);

  try {
    // If no symbols provided, use institutional-grade scanning
    let symbolsToScan = symbols;
    if (!symbols || symbols.length === 0) {
      if (useTwoStageScan) {
        // TWO-STAGE SCANNING (PRO LEVEL)
        
        // Stage 1 - Fast scan (cheap) - get 30-50 qualified stocks
        const fastScanResults = await fastMarketScan();
        console.log(`🔍 Swing Stage 1: Fast scanned ${fastScanResults.length} stocks`);
        
        // Stage 2 - Deep scan (expensive) - apply full technical analysis
        console.log('🔬 Swing Stage 2: Deep scanning with swing analysis...');
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

    console.log(`📈 Processing ${symbolsToScan.length} symbols for swing analysis...`);

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
            Math.max(60, effectiveRSIPeriod + 20)
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
          const swingVwap = calculateSwingVWAP(technicalCandles, 5); // 5-day VWAP for swing
          const { support, resistance } = supportResistance(technicalCandles);
          const volatilityPct = estimateATRPercent(technicalCandles, 14);

          const candleColor =
            lastCandle && lastCandle.close > lastCandle.open
              ? 'green'
              : lastCandle && lastCandle.close < lastCandle.open
              ? 'red'
              : 'neutral';

          /* =====================
             SWING EVALUATION
          ====================== */
          const swingView = evaluateSwing({
            rsi,
            gapOpenPct: gapData.gapOpenPct,
            gapNowPct: gapData.gapNowPct,
            volumeSpike: volumeData.volumeSpike,
            price: gapData.currentPrice,
            swingVWAP: swingVwap, // Explicit swing VWAP parameter
            support,
            resistance
          });

          /* =====================
             SWING ENTRY PRICE CALCULATION
          ====================== */
          const swingEntryPriceData = calculateSwingEntryPrice({
            price: gapData.currentPrice,
            marketCap: gapData.marketCap,
            swingVWAP: swingVwap, // Explicit swing VWAP parameter
            support,
            resistance,
            rsi,
            candleColor,
            gapOpenPct: gapData.gapOpenPct,
            gapNowPct: gapData.gapNowPct,
            volumeSpike: volumeData.volumeSpike,
            volatilityPct
          });

          /* =====================
             CRITICAL RISK/REWARD VALIDATION
          ====================== */
          const riskRewardRatio = Number.parseFloat(swingEntryPriceData.riskReward);
          
          if (!Number.isFinite(riskRewardRatio) || riskRewardRatio < 1) {
            // Institutional rule: Reject trades with RR < 1:1
            return {
              symbol,
              normalizedSymbol: normalized,
              companyName: gapData.companyName || symbol,
              currentPrice: gapData.currentPrice,
              swingView: {
                label: 'Weak Risk-Reward – Avoid Swing',
                sentiment: 'negative',
                reasons: ['Risk-reward below institutional threshold (1:1)']
              },
              riskReward: Number.isFinite(riskRewardRatio) ? riskRewardRatio.toFixed(2) : '0.00',
              filtered: true // Mark as filtered out
            };
          }

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
            vwap: swingVwap, // Use swing VWAP as primary VWAP for swing
            swingVwap: swingVwap, // Explicit swing VWAP for frontend
            support,
            resistance,
            volatilityPct: Number.isFinite(volatilityPct) ? Number(volatilityPct.toFixed(2)) : null,

            resolvedSymbol,
            swingView,

            // Swing entry price information
            entryPrice: swingEntryPriceData.entryPrice,
            stopLoss: swingEntryPriceData.stopLoss,
            target1: swingEntryPriceData.target1,
            target2: swingEntryPriceData.target2,
            entryReason: swingEntryPriceData.entryReason,
            entryType: swingEntryPriceData.entryType,
            riskReward: swingEntryPriceData.riskReward,
            riskRewardAfterCosts: swingEntryPriceData.riskRewardAfterCosts,
            riskRewardGross: swingEntryPriceData.riskRewardGross,
            estimatedRoundTripCostPerShare: swingEntryPriceData.estimatedRoundTripCostPerShare,
            estimatedRoundTripCostPct: swingEntryPriceData.estimatedRoundTripCostPct
          };
        } catch (e) {
          return {
            symbol,
            error: e.message || 'Failed to process symbol'
          };
        }
      })
    );

    const quality = buildQualitySwingList(results);
    const positiveSwingStocks = quality.stocks;

    res.json({ 
      positiveSwingStocks,
      totalScanned: results.length,
      positiveCount: positiveSwingStocks.length,
      compliance,
      meta: { 
        rsiPeriod: effectiveRSIPeriod,
        scanType: useTwoStageScan ? 'two-stage-institutional' : 'improved-filter',
        stage1Processed: useTwoStageScan ? symbolsToScan.length : null,
        institutionalFiltering: true,
        riskRewardThreshold: '1:1 minimum',
        qualityMode: 'balanced-adaptive',
        qualityScoreThreshold: quality.qualityThreshold
      }
    });
  } catch (err) {
    console.error('swing scan error', err);
    res.status(500).json({ error: 'Failed to scan swing stocks' });
  }
});

export default router;
