import express from 'express';
import { fetchGapData, fetchOHLCV, fetchMarketMovers, fastMarketScan } from '../services/marketData.js';
import {
  detectVolumeSpike,
  calculateVWAP,
  calculateIntradayVWAP,
  supportResistance,
  detectBreakout
} from '../services/technicalIndicators.js';
import { computeRSI } from '../services/rsiCalculator.js';
import { evaluateIntraday, calculateIntradayEntryPrice } from '../services/positionEvaluator.js';
import { resolveNSESymbol } from '../services/marketData.js';

const router = express.Router();
const compliance = {
  jurisdiction: 'IN',
  advisoryOnly: true,
  recommendationType: 'educational-screening',
  riskDisclosure: 'Do not treat this as investment advice. Validate with your own risk checks and a SEBI-registered advisor before any trade.',
};

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
    const closes = candles.map(c => c.close);
    const lastCandle = candles[candles.length - 1];
    const rsi = computeRSI(closes, 14);
    
    const volumeData = detectVolumeSpike(candles);
    const vwap = calculateIntradayVWAP(candles);
    const { support, resistance } = supportResistance(candles);
    
    const candleColor = lastCandle.close > lastCandle.open ? 'green' : 
                       lastCandle.close < lastCandle.open ? 'red' : 'neutral';

    const intradayView = evaluateIntraday({
      rsi, gapOpenPct: gapData.gapOpenPct, gapNowPct: gapData.gapNowPct,
      volumeSpike: volumeData.volumeSpike, price: gapData.currentPrice,
      vwap, support, resistance, candleColor, marketCap: gapData.marketCap
    });

    const entryPriceData = calculateIntradayEntryPrice({
      price: gapData.currentPrice, vwap, support, resistance, rsi,
      candleColor, gapOpenPct: gapData.gapOpenPct, volumeSpike: volumeData.volumeSpike
    });

    return {
      symbol, normalizedSymbol: normalized, companyName: gapData.companyName || symbol,
      gapOpenPct: gapData.gapOpenPct, gapNowPct: gapData.gapNowPct,
      prevClose: gapData.prevClose, open: gapData.open, currentPrice: gapData.currentPrice,
      marketCap: gapData.marketCap, priceSource: gapData.priceSource, rsi, candleColor,
      volume: volumeData, vwap, support, resistance, resolvedSymbol, intradayView,
      finalSentiment: intradayView.sentiment,
      entryPrice: entryPriceData.entryPrice, stopLoss: entryPriceData.stopLoss,
      target1: entryPriceData.target1, target2: entryPriceData.target2,
      entryReason: entryPriceData.entryReason, entryType: entryPriceData.entryType,
      riskReward: entryPriceData.riskReward
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
      r.entryType !== 'scalp_only' && parseFloat(r.riskReward) >= 1.0
    );

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
router.post('/start', async (req, res) => {
  startIntradayBackgroundScan(); // fire & forget
  res.json({ status: 'scan_started' });
});

// 📡 GET /scan/intraday/status - Get cached results
router.get('/status', (req, res) => {
  res.json({
    ...intradayCache,
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

router.post('/', async (req, res) => {
  const { symbols, rsiPeriod = 14, useTwoStageScan = true } = req.body || {};

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
            Math.max(60, rsiPeriod + 20),
            { interval: '5m', range: '5d' }
          );

          const closes = candles.map(c => c.close);
          const lastCandle = candles[candles.length - 1];

          /* =====================
             RSI
          ====================== */
          const rsi = computeRSI(closes, rsiPeriod);

          /* =====================
             TECHNICALS
          ====================== */
          const volumeData = detectVolumeSpike(candles);
          const vwap = calculateIntradayVWAP(candles);
          const { support, resistance } = supportResistance(candles);

          const candleColor =
            lastCandle.close > lastCandle.open
              ? 'green'
              : lastCandle.close < lastCandle.open
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
            volumeSpike: volumeData.volumeSpike
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
            riskReward: entryPriceData.riskReward
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

    res.json({ 
      positiveStocks,
      totalScanned: results.length,
      positiveCount: positiveStocks.length,
      compliance,
      meta: { 
        rsiPeriod,
        scanType: useTwoStageScan ? 'two-stage-institutional' : 'improved-filter',
        stage1Processed: useTwoStageScan ? symbolsToScan.length : null,
        institutionalFiltering: true
      }
    });
  } catch (err) {
    console.error('intraday scan error', err);
    res.status(500).json({ error: 'Failed to scan intraday stocks' });
  }
});

export default router;
