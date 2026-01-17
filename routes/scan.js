import express from 'express';
import { fetchGapData, fetchOHLCV } from '../services/marketData.js';
import {
  detectVolumeSpike,
  calculateVWAP,
  supportResistance,
  detectBreakout
} from '../services/technicalIndicators.js';

import { computeRSI, categorizeRSI } from '../services/rsiCalculator.js';
import { fetchCompanyNews, classifySentiment } from '../services/newsService.js';
import { makeDecision } from '../services/decisionEngine.js';
import { resolveNSESymbol } from '../services/marketData.js'
import {
  evaluateSwing,
  evaluateLongTerm
} from '../services/positionEvaluator.js'


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
  const { symbols = [], gapThreshold = 0.8, rsiPeriod = 14 } = req.body || {};

  if (!Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ error: 'symbols array is required' });
  }

  try {
    const results = await Promise.all(
      symbols.map(async (symbol) => {
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
          const resolvedSymbol = await resolveNSESymbol(symbol)
const gapData = await fetchGapData(resolvedSymbol)

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
          const rsiCategory = categorizeRSI(rsi);

          const rsiBias =
            rsi > 50 ? 'bullish' :
            rsi < 50 ? 'bearish' :
            'neutral';

          const candleColor =
            lastCandle.close > lastCandle.open
              ? 'green'
              : lastCandle.close < lastCandle.open
              ? 'red'
              : 'neutral';

          /* =====================
             TECHNICALS
          ====================== */
          const volumeData = detectVolumeSpike(candles);
          const vwap = calculateVWAP(candles);
          const { support, resistance } = supportResistance(candles);

          const breakout =
            detectBreakout(gapData.currentPrice, resistance) ||
            (gapData.currentPrice > vwap && lastCandle.close > lastCandle.open);


          /* =====================
             NEWS SENTIMENT
          ====================== */
          const news = await fetchCompanyNews(symbol);
          const topNews = news[0] || null;

          const sentiment = topNews
            ? classifySentiment(
                `${topNews.headline} ${topNews.summary || ''}`
              )
            : 'neutral';

          /* =====================
             DECISION LOGIC
          ====================== */
          const effectiveGap = gapData.gapNowPct ?? gapData.gapOpenPct;

          const isGapped =
            effectiveGap != null &&
            Math.abs(effectiveGap) >= gapThreshold;

          const strongConfirmation =
            volumeData.volumeSpike &&
            breakout &&
            gapData.currentPrice > vwap;

          const decision = isGapped
  ? makeDecision({
      gapPct: effectiveGap,
      rsi,
      rsiCategory,
      confirmation: strongConfirmation,
      rsiBias,
      candleColor
    })
  : {
      label: 'No Gap',
      sentiment: 'neutral',
      reason: 'Gap below threshold',
      icon: 'ℹ️'
    };
    /* =====================
   SWING & LONG TERM
===================== */
const swingView = evaluateSwing({
  rsi,
  gapOpenPct: gapData.gapOpenPct
})

const longTermView = evaluateLongTerm({
  rsi,
  marketCap: gapData.marketCap
})


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
            rsiCategory,
            rsiBias,
            candleColor,

            volume: volumeData,
            vwap,
            support,
            resistance,
            breakout,

            news: topNews
              ? {
                  headline: topNews.headline,
                  summary: topNews.summary,
                  url: topNews.url,
                  source: topNews.source,
                  keywords: topNews.keywords
                }
              : null,

            newsItems: (news || []).slice(0, 5).map(n => ({
              headline: n.headline,
              url: n.url,
              source: n.source,
              keywords: n.keywords
            })),
            resolvedSymbol,
            newsSentiment: sentiment,
            finalSentiment: decision.sentiment,
            decision,

            swingView,
            longTermView
          };
        } catch (e) {
          return {
            symbol,
            error: e.message || 'Failed to process symbol'
          };
        }
      })
    );

    res.json({ results, meta: { gapThreshold, rsiPeriod } });
  } catch (err) {
    console.error('scan error', err);
    res.status(500).json({ error: 'Failed to scan symbols' });
  }
});

export default router;
