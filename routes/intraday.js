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
