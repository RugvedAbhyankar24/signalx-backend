import express from 'express';
import { fetchGapData, fetchOHLCV } from '../services/marketData.js';
import {
  detectVolumeSpike,
  calculateVWAP,
  calculateSwingVWAP,
  supportResistance,
  detectBreakout,
  estimateATRPercent
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
          const volumeData = detectVolumeSpike(technicalCandles);
          const vwap = calculateVWAP(technicalCandles);
          const swingVwap = calculateSwingVWAP(technicalCandles, 5);
          const { support, resistance } = supportResistance(technicalCandles);
          const volatilityPct = estimateATRPercent(technicalCandles, 14);

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
          const intradayDirection = intradayView?.tradeDirection === 'short' || intradayView?.sentiment === 'negative'
            ? 'short'
            : 'long'

          const intradayEntryPlan = calculateIntradayEntryPrice({
            price: gapData.currentPrice,
            vwap,
            support,
            resistance,
            rsi,
            candleColor,
            gapOpenPct: gapData.gapOpenPct,
            volumeSpike: volumeData.volumeSpike,
            volatilityPct: null,
            direction: intradayDirection
          });

    /* =====================
   SWING & LONG TERM
===================== */
const swingView = evaluateSwing({
  rsi,
  gapOpenPct: gapData.gapOpenPct,
  gapNowPct: gapData.gapNowPct,
  volumeSpike: volumeData.volumeSpike,
  price: gapData.currentPrice,
  swingVWAP: swingVwap,
  support,
  resistance
})

const swingEntryPlan = calculateSwingEntryPrice({
  price: gapData.currentPrice,
  marketCap: gapData.marketCap,
  swingVWAP: swingVwap,
  support,
  resistance,
  rsi,
  candleColor,
  gapOpenPct: gapData.gapOpenPct,
  gapNowPct: gapData.gapNowPct,
  volumeSpike: volumeData.volumeSpike,
  volatilityPct
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

          const newsItems = (news || []).slice(0, 5).map(n => ({
            headline: n.headline,
            url: n.url,
            source: n.source,
            datetime: n.datetime,
            keywords: n.keywords
          }));
          const intradayOpportunity = marketState.isOpen &&
            ['positive', 'negative'].includes(intradayView?.sentiment) &&
            !['scalp_only', 'rr_weak'].includes(intradayEntryPlan?.entryType) &&
            Number.parseFloat(intradayEntryPlan?.riskReward) >= 1
            ? {
                qualifies: true,
                direction: intradayEntryPlan.direction || intradayDirection,
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

            rsi,
            rsiCategory,
            rsiBias,
            candleColor,

            volume: volumeData,
            vwap,
            swingVwap,
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
              rsi,
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
