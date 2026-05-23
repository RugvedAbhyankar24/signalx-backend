import express from 'express';
import { fetchGapData, fetchOHLCV } from '../services/marketData.js';
import {
  detectVolumeSpike,
  calculateIntradayVWAP,
  calculateSwingVWAP,
  supportResistance,
  detectBreakout,
  estimateATRPercent,
  selectIntradaySessionCandles
} from '../services/technicalIndicators.js';

import { computeRSI, categorizeRSI } from '../services/rsiCalculator.js';
import { fetchCompanyNews, classifySentiment } from '../services/newsService.js';
import { resolveNSESymbol } from '../services/marketData.js'
import {
  evaluateSwing,
  evaluateLongTerm,
  evaluateIntraday,
  calculateIntradayEntryPrice,
  calculateSwingEntryPrice
} from '../services/positionEvaluator.js'
import { fetchFundamentals } from '../services/marketData.js'
import { createRateLimiter } from '../middleware/rateLimit.js';

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
  const longTermPositive = longTerm?.sentiment === 'positive'
  const longTermNegative = longTerm?.sentiment === 'negative'
  const intradayPositive = intraday?.sentiment === 'positive'
  const intradayNegative = intraday?.sentiment === 'negative'
  const swingPositive = swing?.sentiment === 'positive'
  const swingNegative = swing?.sentiment === 'negative'

  if (longTermPositive && (intradayPositive || swingPositive) && gapContext !== 'NEGATIVE_GAP') {
    return {
      label: 'Multi-Horizon Long',
      sentiment: 'positive',
      reason: 'Long-term quality is aligned with tactical strength',
      icon: '✅'
    };
  }

  if (longTermNegative && (intradayPositive || swingPositive)) {
    return {
      label: 'Tactical Only',
      sentiment: 'neutral',
      reason: 'Short-term setup exists, but long-term underwriting is weak',
      icon: 'ℹ️'
    };
  }

  if (swingNegative && gapContext !== 'NO_GAP') {
    return {
      label: 'Gap Risk - Avoid',
      sentiment: 'negative',
      reason: 'Gap risk overrides tactical momentum',
      icon: '❌'
    };
  }

  if (intradayPositive && gapContext !== 'NEGATIVE_GAP') {
    return {
      label: 'Tradeable',
      sentiment: 'positive',
      reason: 'Intraday momentum aligned with session context',
      icon: '✅'
    };
  }

  if (swingPositive && !intradayNegative) {
    return {
      label: 'Swing Build-Up',
      sentiment: 'positive',
      reason: 'Swing structure is constructive even without strong intraday confirmation',
      icon: '✅'
    };
  }

  if (longTermPositive) {
    return {
      label: 'Long-Term Watchlist',
      sentiment: 'neutral',
      reason: 'Business quality is strong, but tactical timing is not yet aligned',
      icon: 'ℹ️'
    };
  }

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
const fullScanLimiter = createRateLimiter({
  windowMs: Number(process.env.FULL_SCAN_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.FULL_SCAN_RATE_LIMIT_MAX || 10),
  keyFn: (req) => `${req.ip}:full:scan`,
  message: 'Too many full scan requests.'
});
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

function inferIntradayBiasDirection(view) {
  if (view?.biasDirection === 'short' || view?.tradeDirection === 'short') return 'short';
  if (view?.biasDirection === 'long' || view?.tradeDirection === 'long') return 'long';
  if (view?.sentiment === 'negative') return 'short';
  if (view?.sentiment === 'positive') return 'long';
  return null;
}

function buildIntradayExecutionMeta({ marketState, intradayView, entryPlan, fallbackDirection }) {
  const biasDirection = inferIntradayBiasDirection(intradayView) || fallbackDirection || 'long';
  const riskReward = Number.parseFloat(entryPlan?.riskReward);
  const hasValidRr = Number.isFinite(riskReward) && riskReward >= 1;
  const entryType = entryPlan?.entryType || 'invalid';
  const isWatchPhase = intradayView?.setupPhase === 'watch';
  const qualifies =
    marketState?.isOpen &&
    ['positive', 'negative'].includes(intradayView?.sentiment) &&
    !isWatchPhase &&
    !['scalp_only', 'rr_weak', 'invalid'].includes(entryType) &&
    hasValidRr;

  let blockerReason = null;
  if (!marketState?.isOpen) blockerReason = marketState?.reason || 'market_closed';
  else if (isWatchPhase) blockerReason = intradayView?.blockerReason || 'watch_setup';
  else if (entryType === 'scalp_only') blockerReason = 'scalp_only';
  else if (entryType === 'rr_weak') blockerReason = 'rr_weak';
  else if (entryType === 'invalid') blockerReason = 'invalid_entry_plan';
  else if (!hasValidRr) blockerReason = 'rr_below_threshold';
  else if (!['positive', 'negative'].includes(intradayView?.sentiment)) blockerReason = intradayView?.blockerReason || 'no_trade_signal';

  return {
    biasDirection,
    executionDirection: qualifies
      ? (entryPlan?.direction || intradayView?.executionDirection || biasDirection)
      : null,
    qualifies,
    blockerReason: qualifies ? null : (blockerReason || intradayView?.blockerReason || null)
  };
}

function getIndianMarketState(now = new Date()) {
  const parts = IST_PARTS_FORMATTER.formatToParts(now);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const weekday = map.weekday;
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  const mins = hour * 60 + minute;
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  const istDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const isHoliday = NSE_HOLIDAYS.has(istDate);
  const sessionOpen = 9 * 60 + 15;
  const sessionClose = 15 * 60 + 30;
  const isSessionTime = mins >= sessionOpen && mins <= sessionClose;
  const isOpen = !isWeekend && !isHoliday && isSessionTime;

  let reason = 'market_open';
  if (isWeekend) reason = 'weekend';
  else if (isHoliday) reason = 'holiday';
  else if (mins < sessionOpen) reason = 'pre_open_or_before_session';
  else if (mins > sessionClose) reason = 'post_market';

  return {
    isOpen,
    reason,
    istDate,
    istTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
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

router.post('/', fullScanLimiter, async (req, res) => {
  const { symbols = [], gapThreshold = 0.8, rsiPeriod = 14 } = req.body || {};
  const effectiveRSIPeriod = sanitizeRSIPeriod(rsiPeriod, 14);
  const marketState = getIndianMarketState();

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
          const [intradayCandlesRaw, swingCandlesRaw] = await Promise.all([
            fetchOHLCV(
              resolvedSymbol,
              Math.max(60, effectiveRSIPeriod + 20),
              { interval: '5m', range: '5d' }
            ),
            fetchOHLCV(
              resolvedSymbol,
              Math.max(60, effectiveRSIPeriod + 20)
            )
          ]);

          const intradayCandles = selectCandlesForTechnicals(intradayCandlesRaw, Math.max(20, effectiveRSIPeriod + 1));
          const intradaySessionCandles = selectIntradaySessionCandles(intradayCandles);
          const intradayRsiCandles = intradaySessionCandles.length >= effectiveRSIPeriod + 1 ? intradaySessionCandles : intradayCandles;
          const swingCandles = selectCandlesForTechnicals(swingCandlesRaw, Math.max(20, effectiveRSIPeriod + 1));
          const intradayCloses = intradayRsiCandles.map(c => c.close);
          const swingCloses = swingCandles.map(c => c.close);
          const intradayLastCandle = intradaySessionCandles[intradaySessionCandles.length - 1] || intradayCandles[intradayCandles.length - 1] || intradayCandlesRaw[intradayCandlesRaw.length - 1];
          const swingLastCandle = swingCandles[swingCandles.length - 1] || swingCandlesRaw[swingCandlesRaw.length - 1];

          /* =====================
             RSI
          ====================== */
          const intradayRsi = computeRSI(intradayCloses, effectiveRSIPeriod);
          const swingRsi = computeRSI(swingCloses, effectiveRSIPeriod);
          const rsiCategory = categorizeRSI(swingRsi);

          const rsiBias =
            intradayRsi > 50 ? 'bullish' :
            intradayRsi < 50 ? 'bearish' :
            'neutral';

          const candleColor =
            intradayLastCandle.close > intradayLastCandle.open
              ? 'green'
              : intradayLastCandle.close < intradayLastCandle.open
              ? 'red'
              : 'neutral';

          /* =====================
             TECHNICALS
          ====================== */
          const volumeData = detectVolumeSpike(intradaySessionCandles);
          const vwap = calculateIntradayVWAP(intradaySessionCandles);
          const swingVwap = calculateSwingVWAP(swingCandles, 5);
          const { support, resistance } = supportResistance(intradaySessionCandles);
          const volatilityPct = estimateATRPercent(intradaySessionCandles, 14);
          const { support: swingSupport, resistance: swingResistance } = supportResistance(swingCandles);
          const swingVolatilityPct = estimateATRPercent(swingCandles, 14);
          const swingVolumeData = detectVolumeSpike(swingCandles);

          const breakout =
            detectBreakout(gapData.currentPrice, resistance) ||
            (gapData.currentPrice > vwap && intradayLastCandle.close > intradayLastCandle.open);


          /* =====================
             NEWS SENTIMENT
          ====================== */
          const news = await fetchCompanyNews(symbol, {
            companyName: gapData.companyName,  // critical for entity matching
            includeMeta: false,                 // skip NSE meta call (403 on weekends)
          });
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
            rsi: intradayRsi,
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
          const intradayDirection = inferIntradayBiasDirection(intradayView) || 'long'

          const intradayEntryPlan = calculateIntradayEntryPrice({
            price: gapData.currentPrice,
            vwap,
            support,
            resistance,
            rsi: intradayRsi,
            candleColor,
            gapOpenPct: gapData.gapOpenPct,
            volumeSpike: volumeData.volumeSpike,
            volatilityPct,
            direction: intradayDirection
          });
          const intradayExecutionMeta = buildIntradayExecutionMeta({
            marketState,
            intradayView,
            entryPlan: intradayEntryPlan,
            fallbackDirection: intradayDirection
          });

    /* =====================
   SWING & LONG TERM
===================== */
const swingView = evaluateSwing({
  rsi: swingRsi,
  gapOpenPct: gapData.gapOpenPct,
  gapNowPct: gapData.gapNowPct,
  volumeSpike: swingVolumeData.volumeSpike,
  price: gapData.currentPrice,
  swingVWAP: swingVwap,
  support: swingSupport,
  resistance: swingResistance
})

const swingEntryPlan = calculateSwingEntryPrice({
  price: gapData.currentPrice,
  marketCap: gapData.marketCap,
  swingVWAP: swingVwap,
  support: swingSupport,
  resistance: swingResistance,
  rsi: swingRsi,
  candleColor: swingLastCandle && swingLastCandle.close > swingLastCandle.open
    ? 'green'
    : swingLastCandle && swingLastCandle.close < swingLastCandle.open
    ? 'red'
    : 'neutral',
  gapOpenPct: gapData.gapOpenPct,
  gapNowPct: gapData.gapNowPct,
  volumeSpike: swingVolumeData.volumeSpike,
  volatilityPct: swingVolatilityPct
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
  rsi: swingRsi,
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

          const newsItems = (news || []).slice(0, 5).map(n => ({
            headline: n.headline,
            url: n.url,
            source: n.source,
            datetime: n.datetime,
            keywords: n.keywords
          }));
          const intradayOpportunity = intradayExecutionMeta.qualifies
            ? {
                qualifies: true,
                direction: intradayExecutionMeta.executionDirection,
                biasDirection: intradayExecutionMeta.biasDirection,
                executionDirection: intradayExecutionMeta.executionDirection,
                blockerReason: null,
                entryPrice: intradayEntryPlan.entryPrice,
                stopLoss: intradayEntryPlan.stopLoss,
                target1: intradayEntryPlan.target1,
                target2: intradayEntryPlan.target2,
                entryType: intradayEntryPlan.entryType,
                entryReason: intradayEntryPlan.entryReason,
                actionableEntryQuality: intradayEntryPlan.actionableEntryQuality,
                riskReward: intradayEntryPlan.riskReward
              }
            : {
                qualifies: false,
                direction: intradayExecutionMeta.biasDirection,
                biasDirection: intradayExecutionMeta.biasDirection,
                executionDirection: null,
                blockerReason: intradayExecutionMeta.blockerReason,
                setupPhase: intradayView?.setupPhase || 'ready',
                reason: marketState.isOpen
                  ? (intradayView?.reasons?.[0] || intradayView?.label || 'No intraday edge')
                  : 'Intraday execution is only active during market hours.'
              };
          const swingOpportunity = swingView?.sentiment === 'positive'
            ? {
                qualifies: true,
                entryPrice: swingEntryPlan.entryPrice,
                stopLoss: swingEntryPlan.stopLoss,
                target1: swingEntryPlan.target1,
                target2: swingEntryPlan.target2,
                entryType: swingEntryPlan.entryType,
                entryReason: swingEntryPlan.entryReason,
                actionableEntryQuality: swingEntryPlan.actionableEntryQuality,
                riskReward: swingEntryPlan.riskReward
              }
            : {
                qualifies: false,
                reason: swingView?.reasons?.[0] || swingView?.label || 'No swing edge'
              };



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

            rsi: swingRsi,
            intradayRsi,
            rsiCategory,
            rsiBias,
            candleColor,

            volume: volumeData,
            vwap,
            swingVwap,
            support,
            resistance,
            swingSupport,
            swingResistance,
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

            newsItems,
            resolvedSymbol,
            newsSentiment: sentiment,
            finalSentiment: decision.sentiment,
            decision,

            intradayView,
            intradayOpportunity,
            swingView,
            swingOpportunity,
            longTermView,

            marketData: {
              prevClose: gapData.prevClose,
              open: gapData.open,
              currentPrice: gapData.currentPrice,
              gapOpenPct: gapData.gapOpenPct,
              gapNowPct: gapData.gapNowPct,
              marketCap: gapData.marketCap ?? null,
              priceSource: gapData.priceSource,
              resolvedSymbol
            },
            technicals: {
              rsi: swingRsi,
              intradayRsi,
              rsiCategory,
              rsiBias,
              candleColor,
              volume: volumeData,
              vwap,
              swingVwap,
              support,
              resistance,
              breakout
            },
            opportunities: {
              decision,
              intradayView,
              intradayOpportunity,
              swingView,
              swingOpportunity,
              longTermView
            },
            newsData: {
              sentiment,
              topNews: topNews
                ? {
                    headline: topNews.headline,
                    summary: topNews.summary,
                    url: topNews.url,
                    source: topNews.source,
                    keywords: topNews.keywords
                  }
                : null,
              items: newsItems
            }
          };
        } catch (e) {
          return {
            symbol,
            error: e.message || 'Failed to process symbol'
          };
        }
      })
    );

    res.json({ results, compliance, meta: { gapThreshold, rsiPeriod: effectiveRSIPeriod, marketState } });
  } catch (err) {
    console.error('scan error', err);
    res.status(500).json({ error: 'Failed to scan symbols' });
  }
});

export default router;
