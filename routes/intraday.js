import express from 'express';
import { fetchGapData, fetchOHLCV, fetchMarketMovers } from '../services/marketData.js';
import {
  detectVolumeSpike,
  calculateVWAP,
  supportResistance,
  detectBreakout
} from '../services/technicalIndicators.js';
import { computeRSI } from '../services/rsiCalculator.js';
import { evaluateIntraday } from '../services/positionEvaluator.js';
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
  const { symbols, rsiPeriod = 14 } = req.body || {};

  try {
    // If no symbols provided, fetch NSE500 stocks
    let symbolsToScan = symbols;
    if (!symbols || symbols.length === 0) {
      const marketMovers = await fetchMarketMovers();
      symbolsToScan = marketMovers.map(stock => stock.symbol);
    }

    if (!Array.isArray(symbolsToScan) || symbolsToScan.length === 0) {
      return res.status(400).json({ error: 'No symbols to scan' });
    }

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
            intradayView
          };
        } catch (e) {
          return {
            symbol,
            error: e.message || 'Failed to process symbol'
          };
        }
      })
    );

    // Filter only positive intraday stocks
    const positiveStocks = results.filter(
      stock => !stock.error && stock.intradayView && stock.intradayView.sentiment === 'positive'
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
      meta: { rsiPeriod }
    });
  } catch (err) {
    console.error('intraday scan error', err);
    res.status(500).json({ error: 'Failed to scan intraday stocks' });
  }
});

export default router;
