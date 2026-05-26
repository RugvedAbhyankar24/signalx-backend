export function computeRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length <= period) return null;
  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(Math.max(0, change));
    losses.push(Math.max(0, -change));
  }
  // First average
  let avgGain = average(gains.slice(0, period));
  let avgLoss = average(losses.slice(0, period));
  if (avgGain == null || avgLoss == null) return null;
  // Wilder's smoothing
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }
  // When there are no losses RSI is exactly 100 (not ~99.0 via RS=100 shortcut)
  if (avgLoss === 0) return 100;
  // When there are no gains RSI is exactly 0
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return Math.round(rsi * 10) / 10;
}

function average(arr) {
  const valid = arr.filter((v) => v != null);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

export function categorizeRSI(rsi) {
  if (rsi == null) return 'unknown'
  if (rsi < 40) return 'bearish'
  if (rsi <= 60) return 'neutral'
  return 'bullish'
}

