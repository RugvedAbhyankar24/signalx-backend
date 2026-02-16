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
import { resolveNSESymbol } from '../services/marketData.js'
import {
  evaluateSwing,
  evaluateLongTerm,
  evaluateIntraday
} from '../services/positionEvaluator.js'
import { fetchFundamentals } from '../services/marketData.js'

// GAP CONTEXT HELPER
function getGapContext(gapOpenPct, gapNowPct) {
  const effectiveGap = gapNowPct ?? gapOpenPct;
  
  if (effectiveGap === null || Math.abs(effectiveGap) < 0.8) {
    return 'NO_GAP';
  } else if (effectiveGap < -2.0) {
    return 'NEGATIVE_GAP';
  } else if (effectiveGap > 2.0) {
    return 'STRONG_POSITIVE_GAP';
  } else {
    return 'MODERATE_GAP';
  }
}

// CORRECT (hierarchical) SENTIMENT LOGIC
function deriveFinalSentiment({ intraday, swing, longTerm, gapOpenPct, gapNowPct }) {
  const gapContext = getGapContext(gapOpenPct, gapNowPct);

  // 1️⃣ HARD BLOCKERS
  if (swing?.sentiment === 'negative' && gapContext !== 'NO_GAP') {
    return {
      label: 'Gap Risk - Avoid',
      sentiment: 'negative',
      reason: 'Gap risk overrides intraday momentum',
      icon: '❌'
    };
  }

  // 2️⃣ INTRADAY CAN PASS ONLY IF CONTEXT ALLOWS
  if (
    intraday?.sentiment === 'positive' &&
    gapContext !== 'NEGATIVE_GAP'
  ) {
    return {
      label: 'Tradeable',
      sentiment: 'positive',
      reason: 'Intraday momentum aligned with gap context',
      icon: '✅'
    };
  }

  // 3️⃣ BREAKOUT EXCEPTION
  if (
    intraday?.label === 'Breakout Candidate' &&
    intraday?.sentiment === 'positive'
  ) {
    return {
      label: 'Breakout Trade',
      sentiment: 'positive',
      reason: 'Institutional breakout overrides gap bias',
      icon: '🚀'
    };
  }

  // 4️⃣ DEFAULT
  return {
    label: 'No Clear Signal',
    sentiment: 'neutral',
    reason: 'Mixed signals – no institutional edge',
    icon: 'ℹ️'
  };
}


const router = express.Router();
const compliance = {
  jurisdiction: 'IN',
  advisoryOnly: true,
  recommendationType: 'educational-screening',
  riskDisclosure: 'Do not treat this as investment advice. Validate with your own risk checks and a SEBI-registered advisor before any trade.',
};

function normalizeIndian(symbol) {
  if (!symbol) return symbol;
  const s = String(symbol).trim().toUpperCase();
  if (s.endsWith('.NS') || s.endsWith('.BO')) return s;
  return `${s}.NS`;
}
function isLikelyInvalidSymbol(symbol) {
  return symbol.includes(' ') || symbol.length < 2;
}

function sanitizeRSIPeriod(input, fallback = 14) {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return fallback;
  const asInt = Math.round(parsed);
  if (asInt < 2) return 2;
  if (asInt > 50) return 50;
  return asInt;
}

router.post('/', async (req, res) => {
  const { symbols = [], gapThreshold = 0.8, rsiPeriod = 14 } = req.body || {};
  const effectiveRSIPeriod = sanitizeRSIPeriod(rsiPeriod, 14);

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
            Math.max(60, effectiveRSIPeriod + 20)
          );


          const closes = candles.map(c => c.close);
          const lastCandle = candles[candles.length - 1];

          /* =====================
             RSI
          ====================== */
          const rsi = computeRSI(closes, effectiveRSIPeriod);
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
             INTRADAY ANALYSIS
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
   SWING & LONG TERM
===================== */
const swingView = evaluateSwing({
  rsi,
  gapOpenPct: gapData.gapOpenPct
})

const fundamentals = await fetchFundamentals(resolvedSymbol)

// simple analyst tone from news
const analystSentiment =
  sentiment === 'positive' ? 'positive' :
  sentiment === 'negative' ? 'negative' :
  'neutral'

const marketPosition =
  gapData.marketCap > 5e11 ? 'leader' :
  gapData.marketCap > 1e11 ? 'challenger' :
  'emerging'

const longTermView = evaluateLongTerm({
  rsi,
  marketCap: gapData.marketCap,
  fundamentals: {
    ...fundamentals,
    analystSentiment,
    marketPosition
  }
})

          /* =====================
             DECISION LOGIC (HIERARCHICAL)
          ====================== */
          const decision = deriveFinalSentiment({
            intraday: intradayView,
            swing: swingView,
            longTerm: longTermView,
            gapOpenPct: gapData.gapOpenPct,
            gapNowPct: gapData.gapNowPct
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
              datetime: n.datetime,
              keywords: n.keywords
            })),
            resolvedSymbol,
            newsSentiment: sentiment,
            finalSentiment: decision.sentiment,
            decision,

            intradayView,
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

    res.json({ results, compliance, meta: { gapThreshold, rsiPeriod: effectiveRSIPeriod } });
  } catch (err) {
    console.error('scan error', err);
    res.status(500).json({ error: 'Failed to scan symbols' });
  }
});

export default router;
