import express from 'express';
import { fetchGapData, fetchOHLCV, fetchMarketMovers, fastMarketScan } from '../services/marketData.js';
import {
  detectVolumeSpike,
  calculateVWAP,
  calculateSwingVWAP,
  supportResistance,
  detectBreakout
} from '../services/technicalIndicators.js';
import { computeRSI } from '../services/rsiCalculator.js';
import { evaluateSwing, calculateSwingEntryPrice } from '../services/positionEvaluator.js';
import { resolveNSESymbol } from '../services/marketData.js';

const router = express.Router();

function normalizeIndian(symbol) {
  if (!symbol) return symbol;
  const s = String(symbol).trim().toUpperCase();
  if (s.endsWith('.NS') || s.endsWith('.BO')) return s;
  return `${s}.NS`;
}

function isLikelyInvalidSymbol(symbol) {
  return symbol.includes(' ') || symbol.length < 2;
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
            Math.max(60, rsiPeriod + 20)
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
          const vwap = calculateVWAP(candles);
          const swingVwap = calculateSwingVWAP(candles, 5); // 5-day VWAP for swing
          const { support, resistance } = supportResistance(candles);

          const candleColor =
            lastCandle.close > lastCandle.open
              ? 'green'
              : lastCandle.close < lastCandle.open
              ? 'red'
              : 'neutral';

          /* =====================
             SWING EVALUATION
          ====================== */
          const swingView = evaluateSwing({
            rsi,
            gapOpenPct: gapData.gapOpenPct,
            volumeSpike: volumeData.volumeSpike,
            price: gapData.currentPrice,
            vwap: swingVwap, // Use swing VWAP for swing evaluation
            support,
            resistance
          });

          /* =====================
             SWING ENTRY PRICE CALCULATION
          ====================== */
          const swingEntryPriceData = calculateSwingEntryPrice({
            price: gapData.currentPrice,
            vwap: swingVwap, // Use swing VWAP for entry price calculation
            support,
            resistance,
            rsi,
            candleColor,
            gapOpenPct: gapData.gapOpenPct,
            volumeSpike: volumeData.volumeSpike
          });

          /* =====================
             CRITICAL RISK/REWARD VALIDATION
          ====================== */
          const riskRewardRatio = (swingEntryPriceData.target1 - swingEntryPriceData.entryPrice) / (swingEntryPriceData.entryPrice - swingEntryPriceData.stopLoss);
          
          if (riskRewardRatio < 1) {
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
              riskReward: riskRewardRatio.toFixed(2),
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
            vwap,
            swingVwap, // Add swing VWAP for debugging
            support,
            resistance,

            resolvedSymbol,
            swingView,

            // Swing entry price information
            entryPrice: swingEntryPriceData.entryPrice,
            stopLoss: swingEntryPriceData.stopLoss,
            target1: swingEntryPriceData.target1,
            target2: swingEntryPriceData.target2,
            entryReason: swingEntryPriceData.entryReason,
            entryType: swingEntryPriceData.entryType,
            riskReward: swingEntryPriceData.riskReward
          };
        } catch (e) {
          return {
            symbol,
            error: e.message || 'Failed to process symbol'
          };
        }
      })
    );

    // Filter only positive swing stocks that pass risk/reward validation
    const positiveSwingStocks = results.filter(
      stock => !stock.error && 
               !stock.filtered && // Exclude risk/reward filtered stocks
               stock.swingView && 
               stock.swingView.sentiment === 'positive'
    );

    // Sort by signal strength
    positiveSwingStocks.sort((a, b) => {
      const getScore = (stock) => {
        if (stock.swingView.label === 'High-Quality Swing Setup') return 4;
        if (stock.swingView.label === 'Breakout Swing Setup') return 3;
        if (stock.swingView.label === 'Potential Swing – Needs Confirmation') return 2;
        if (stock.swingView.label === 'Support-Based Swing Attempt') return 2;
        if (stock.swingView.label === 'Consolidation Watch') return 1;
        return 0;
      };
      return getScore(b) - getScore(a);
    });

    res.json({ 
      positiveSwingStocks,
      totalScanned: results.length,
      positiveCount: positiveSwingStocks.length,
      meta: { 
        rsiPeriod,
        scanType: useTwoStageScan ? 'two-stage-institutional' : 'improved-filter',
        stage1Processed: useTwoStageScan ? symbolsToScan.length : null,
        institutionalFiltering: true,
        riskRewardThreshold: '1:1 minimum'
      }
    });
  } catch (err) {
    console.error('swing scan error', err);
    res.status(500).json({ error: 'Failed to scan swing stocks' });
  }
});

export default router;
