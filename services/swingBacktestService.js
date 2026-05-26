import { fetchOHLCV } from './marketData.js';
import {
  calculateADX,
  calculateOBV,
  calculateSupertrend,
  calculateSwingVWAP,
  detectCandlePattern,
  detectVolumeSpike,
  estimateATRPercent,
  getEMAStack,
  supportResistance,
} from './technicalIndicators.js';
import { computeRSI } from './rsiCalculator.js';
import { calculateSwingEntryPrice, evaluateSwing } from './positionEvaluator.js';

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function maxDrawdownFromEquity(equityCurve) {
  let peak = 0;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point);
    maxDrawdown = Math.max(maxDrawdown, peak - point);
  }
  return maxDrawdown;
}

function simulateSwingTrade({ futureCandles, entryPrice, stopLoss, target1, maxHoldBars }) {
  const riskPerShare = entryPrice - stopLoss;
  if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) {
    return null;
  }

  const bars = futureCandles.slice(0, maxHoldBars);
  for (let i = 0; i < bars.length; i += 1) {
    const candle = bars[i];
    const low = toNumber(candle?.low);
    const high = toNumber(candle?.high);
    if (low == null || high == null) continue;

    // Conservative assumption on daily candles: if both stop and target are touched
    // inside the same bar, assume the stop got hit first.
    if (low <= stopLoss) {
      return { outcome: 'loss', holdBars: i + 1, exitPrice: stopLoss, rMultiple: -1 };
    }
    if (high >= target1) {
      return {
        outcome: 'win',
        holdBars: i + 1,
        exitPrice: target1,
        rMultiple: (target1 - entryPrice) / riskPerShare
      };
    }
  }

  const last = bars[bars.length - 1];
  const exitPrice = toNumber(last?.close);
  if (exitPrice == null) return null;

  return {
    outcome: exitPrice >= entryPrice ? 'timeout_gain' : 'timeout_loss',
    holdBars: bars.length,
    exitPrice,
    rMultiple: (exitPrice - entryPrice) / riskPerShare
  };
}

function computeMetrics(trades) {
  const tradeCount = trades.length;
  const wins = trades.filter((trade) => trade.rMultiple > 0);
  const losses = trades.filter((trade) => trade.rMultiple <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.rMultiple, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.rMultiple, 0));
  const avgR = tradeCount ? trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / tradeCount : 0;

  let runningR = 0;
  const equityCurve = trades.map((trade) => {
    runningR += trade.rMultiple;
    return runningR;
  });

  return {
    tradeCount,
    winRate: tradeCount ? Number(((wins.length / tradeCount) * 100).toFixed(2)) : 0,
    averageR: Number(avgR.toFixed(3)),
    expectancyR: Number(avgR.toFixed(3)),
    profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : null,
    maxDrawdownR: Number(maxDrawdownFromEquity(equityCurve).toFixed(3)),
    averageHoldBars: tradeCount
      ? Number((trades.reduce((sum, trade) => sum + trade.holdBars, 0) / tradeCount).toFixed(2))
      : 0,
  };
}

export async function runSwingBacktest({
  symbol,
  years = 3,
  rsiPeriod = 14,
  warmupBars = 60,
  maxHoldBars = 15,
  thresholds = {},
}) {
  const range = `${Math.min(Math.max(Number(years) || 3, 1), 5)}y`;
  const candles = await fetchOHLCV(symbol, warmupBars + maxHoldBars + 30, { interval: '1d', range });
  const trades = [];

  for (let i = warmupBars; i < candles.length - maxHoldBars; i += 1) {
    const history = candles.slice(0, i + 1);
    const technicalCandles = history.filter((candle) =>
      [candle?.open, candle?.high, candle?.low, candle?.close, candle?.volume].every((v) => Number.isFinite(Number(v)))
    );
    if (technicalCandles.length < warmupBars) continue;

    const closes = technicalCandles.map((candle) => candle.close);
    const current = technicalCandles[technicalCandles.length - 1];
    const previous = technicalCandles[technicalCandles.length - 2];
    if (!current || !previous) continue;

    const rsi = computeRSI(closes, rsiPeriod);
    const volumeData = detectVolumeSpike(technicalCandles);
    const swingVWAP = calculateSwingVWAP(technicalCandles, 5);
    const { support, resistance } = supportResistance(technicalCandles);
    const volatilityPct = estimateATRPercent(technicalCandles, 14);
    const emaStack = getEMAStack(technicalCandles);
    const adx = calculateADX(technicalCandles);
    const supertrend = calculateSupertrend(technicalCandles);
    const obvData = calculateOBV(technicalCandles);
    const candlePattern = detectCandlePattern(technicalCandles);

    const swingView = evaluateSwing({
      rsi,
      gapOpenPct: previous.close ? ((current.open - previous.close) / previous.close) * 100 : 0,
      gapNowPct: previous.close ? ((current.close - previous.close) / previous.close) * 100 : 0,
      volumeSpike: volumeData?.volumeSpike,
      price: current.close,
      swingVWAP,
      support,
      resistance,
      emaStack,
      adx,
      supertrend,
      candlePattern,
      obvData,
      volatilityPct,
      thresholds,
    });

    if (swingView?.sentiment !== 'positive') continue;

    const entryPlan = calculateSwingEntryPrice({
      price: current.close,
      marketCap: null,
      swingVWAP,
      support,
      resistance,
      rsi,
      candleColor: current.close > current.open ? 'green' : current.close < current.open ? 'red' : 'neutral',
      gapOpenPct: previous.close ? ((current.open - previous.close) / previous.close) * 100 : 0,
      gapNowPct: previous.close ? ((current.close - previous.close) / previous.close) * 100 : 0,
      volumeSpike: volumeData?.volumeSpike,
      volatilityPct,
    });

    const rr = toNumber(entryPlan?.riskRewardAfterCosts ?? entryPlan?.riskReward);
    if (!Number.isFinite(rr) || rr < 1) continue;

    const trade = simulateSwingTrade({
      futureCandles: candles.slice(i + 1),
      entryPrice: entryPlan.entryPrice,
      stopLoss: entryPlan.stopLoss,
      target1: entryPlan.target1,
      maxHoldBars,
    });
    if (!trade) continue;

    trades.push({
      tradeDate: current.timestamp,
      entryPrice: entryPlan.entryPrice,
      stopLoss: entryPlan.stopLoss,
      target1: entryPlan.target1,
      rMultiple: Number(trade.rMultiple.toFixed(3)),
      outcome: trade.outcome,
      holdBars: trade.holdBars,
      signalLabel: swingView.label,
      rrPlanned: rr,
    });
  }

  return {
    symbol,
    years: Number(range.replace('y', '')),
    thresholds,
    metrics: computeMetrics(trades),
    trades: trades.slice(-100),
    notes: [
      'Historical event/news filters are not replayed in this backtest.',
      'Daily candles use a conservative assumption: stop wins if stop and target touch in the same bar.',
    ],
  };
}

export async function runSwingThresholdSweep({
  symbol,
  years = 3,
  rsiPeriod = 14,
  maxHoldBars = 15,
  sweep = {},
}) {
  const adxTrendCandidates = Array.isArray(sweep.adxTrendMin) && sweep.adxTrendMin.length
    ? sweep.adxTrendMin
    : [18, 20, 22, 25];
  const adxStrongCandidates = Array.isArray(sweep.adxStrongMin) && sweep.adxStrongMin.length
    ? sweep.adxStrongMin
    : [28, 30, 32];
  const rsiMinCandidates = Array.isArray(sweep.highConvictionRsiMin) && sweep.highConvictionRsiMin.length
    ? sweep.highConvictionRsiMin
    : [42, 45, 48];
  const rsiMaxCandidates = Array.isArray(sweep.highConvictionRsiMax) && sweep.highConvictionRsiMax.length
    ? sweep.highConvictionRsiMax
    : [62, 65, 68];

  const runs = [];
  for (const swingAdxTrendMin of adxTrendCandidates) {
    for (const swingAdxStrongMin of adxStrongCandidates) {
      for (const highConvictionRsiMin of rsiMinCandidates) {
        for (const highConvictionRsiMax of rsiMaxCandidates) {
          if (highConvictionRsiMin >= highConvictionRsiMax) continue;
          const thresholds = {
            swingAdxTrendMin,
            swingAdxStrongMin,
            highConvictionRsiMin,
            highConvictionRsiMax,
          };
          const result = await runSwingBacktest({
            symbol,
            years,
            rsiPeriod,
            maxHoldBars,
            thresholds,
          });
          runs.push({
            thresholds,
            metrics: result.metrics,
          });
        }
      }
    }
  }

  const ranked = runs.sort((a, b) => {
    const aScore = (a.metrics.expectancyR * 4) + (a.metrics.winRate / 100) - (a.metrics.maxDrawdownR * 0.6);
    const bScore = (b.metrics.expectancyR * 4) + (b.metrics.winRate / 100) - (b.metrics.maxDrawdownR * 0.6);
    return bScore - aScore;
  });

  return {
    symbol,
    years,
    rsiPeriod,
    maxHoldBars,
    evaluatedConfigs: runs.length,
    topConfigurations: ranked.slice(0, 10),
  };
}
