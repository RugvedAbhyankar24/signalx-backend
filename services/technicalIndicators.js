const IST_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function getISTDate(input) {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return IST_DATE_FORMATTER.format(d);
}

export function getCurrentISTDate() {
  return IST_DATE_FORMATTER.format(new Date());
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function trueRange(current, previousClose) {
  const high = toFiniteNumber(current?.high);
  const low = toFiniteNumber(current?.low);
  const prevClose = toFiniteNumber(previousClose);
  if (high == null || low == null) return null;

  const range1 = high - low;
  if (prevClose == null) return range1;
  const range2 = Math.abs(high - prevClose);
  const range3 = Math.abs(low - prevClose);
  return Math.max(range1, range2, range3);
}

export function detectVolumeSpike(candles, lookback = 20, multiplier = 1.5) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { volumeSpike: false, avgVolume: null, latestVolume: null };
  }

  const validVolumes = candles
    .map(c => toFiniteNumber(c?.volume))
    .filter(v => v != null && v > 0);
  const latestVol = validVolumes.length ? validVolumes[validVolumes.length - 1] : null;
  const vols = candles
    .slice(-lookback - 2, -1)
    .map(c => toFiniteNumber(c?.volume))
    .filter(v => v != null && v > 0);
  const avgVol = vols.length
    ? vols.reduce((a, b) => a + b, 0) / vols.length
    : latestVol;

  return {
    volumeSpike:
      latestVol != null &&
      avgVol != null &&
      avgVol > 0 &&
      latestVol > avgVol * multiplier,
    avgVolume: avgVol == null ? null : Math.round(avgVol),
    latestVolume: latestVol,
  };
}

export function filterCandlesToISTSession(candles, sessionDate = getCurrentISTDate()) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  return candles.filter(c => c?.tradeDateIST === sessionDate || getISTDate(c?.timestamp) === sessionDate);
}

export function selectIntradaySessionCandles(candles, fallbackCount = 24) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const sessionCandles = filterCandlesToISTSession(candles);
  if (sessionCandles.length > 0) return sessionCandles;
  return candles.slice(-fallbackCount);
}

export function calculateVWAP(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  let pv = 0;
  let vol = 0;

  candles.forEach(c => {
    const high = toFiniteNumber(c?.high);
    const low = toFiniteNumber(c?.low);
    const close = toFiniteNumber(c?.close);
    const volume = toFiniteNumber(c?.volume);
    if (high == null || low == null || close == null || volume == null || volume <= 0) return;

    const typicalPrice = (high + low + close) / 3;
    pv += typicalPrice * volume;
    vol += volume;
  });

  return vol === 0 ? null : +(pv / vol).toFixed(2);
}

export function calculateIntradayVWAP(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  let pv = 0, vol = 0;

  const candlesToUse = selectIntradaySessionCandles(candles, 5);

  for (const c of candlesToUse) {
    const high = toFiniteNumber(c?.high);
    const low = toFiniteNumber(c?.low);
    const close = toFiniteNumber(c?.close);
    const volume = toFiniteNumber(c?.volume);
    if (high == null || low == null || close == null || volume == null || volume <= 0) continue;

    const tp = (high + low + close) / 3;
    pv += tp * volume;
    vol += volume;
  }

  return vol === 0 ? null : +(pv / vol).toFixed(2);
}

export function calculateSwingVWAP(candles, days = 5) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  // Calculate 5-day VWAP for swing trading (institutional approach)
  // For daily data, we only need 'days' number of candles, not days * 20
  const swingCandles = candles.slice(-days); // Take last 5 daily candles
  let pv = 0;
  let vol = 0;

  swingCandles.forEach(c => {
    const high = toFiniteNumber(c?.high);
    const low = toFiniteNumber(c?.low);
    const close = toFiniteNumber(c?.close);
    const volume = toFiniteNumber(c?.volume);
    if (high == null || low == null || close == null || volume == null || volume <= 0) return;

    const typicalPrice = (high + low + close) / 3;
    pv += typicalPrice * volume;
    vol += volume;
  });

  return vol === 0 ? null : +(pv / vol).toFixed(2);
}

export function supportResistance(candles, lookback = 20) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { support: null, resistance: null };
  }
  const recent = candles.slice(-lookback);
  const allLows = recent.map(c => toFiniteNumber(c?.low)).filter(v => v != null);
  const allHighs = recent.map(c => toFiniteNumber(c?.high)).filter(v => v != null);

  if (!allLows.length) return { support: null, resistance: null };

  // --- Structural Support: highest pivot swing low ---
  // Using absolute Math.min captures isolated wick spikes as "support", producing
  // stop-losses that are either dangerously wide or placed at irrelevant levels.
  // Pivot swing lows (local minima — lower than both neighbours) represent real
  // structural floors where buyers have stepped in repeatedly, which is exactly
  // what institutional desks anchor stop placement to.
  const pivotLows = [];
  for (let i = 1; i < recent.length - 1; i++) {
    const low  = toFiniteNumber(recent[i]?.low);
    const prev = toFiniteNumber(recent[i - 1]?.low);
    const next = toFiniteNumber(recent[i + 1]?.low);
    if (low != null && prev != null && next != null && low <= prev && low <= next) {
      pivotLows.push(low);
    }
  }
  // "Highest pivot low" = nearest clean structural floor below price
  // If no pivot is detectable (e.g. monotonic move, very few candles) fall back
  // to absolute minimum so we never return null when data exists.
  const support = pivotLows.length
    ? Math.max(...pivotLows)
    : Math.min(...allLows);

  // --- Resistance: absolute recent high ---
  // The absolute recent high is the correct overhead ceiling for:
  //   • breakout detection (price > resistance × 1.002 + volume)
  //   • target capping (T1/T2 should not be set above the period's high)
  //   • nearResistance guard (price approaching the last swing peak)
  // Pivot-based resistance would give the *lowest* recent peak, which could be
  // below current price in a trending market — misclassifying a live trend as
  // "near resistance" when there is no overhead supply.
  const resistance = allHighs.length ? Math.max(...allHighs) : null;

  return { support, resistance };
}

export function detectBreakout(price, resistance, bufferPct = 0.3) {
  const p = toFiniteNumber(price);
  const r = toFiniteNumber(resistance);
  const b = toFiniteNumber(bufferPct);
  if (p == null || r == null || r <= 0 || b == null) return false;
  return p > r * (1 + b / 100);
}

export function calculateRSI(prices, period = 14) {
  if (!Array.isArray(prices)) return 50;

  const closes = prices
    .map(p => {
      if (typeof p === 'number') return toFiniteNumber(p);
      return toFiniteNumber(p?.close);
    })
    .filter(v => v != null);

  if (closes.length < period + 1) {
    return 50; // Not enough data — return neutral
  }

  let gains = 0;
  let losses = 0;

  // Seed: simple average of first `period` moves
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff; // keep positive
  }

  let avgGain = gains  / period;
  let avgLoss = losses / period;

  // Wilder's smoothing for all subsequent bars
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1))         / period;
    } else {
      avgGain = (avgGain * (period - 1))         / period;
      avgLoss = (avgLoss * (period - 1) - diff)  / period;
    }
  }

  // Exact boundary values — avoid the floating-point RS shortcut
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;

  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

export function estimateATRPercent(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const relevant = candles.slice(-Math.max(period + 1, 6));
  if (relevant.length < 2) return null;

  const trValues = [];
  for (let i = 1; i < relevant.length; i++) {
    const tr = trueRange(relevant[i], relevant[i - 1]?.close);
    if (tr != null && tr >= 0) trValues.push(tr);
  }

  if (!trValues.length) return null;
  const atr = trValues.reduce((a, b) => a + b, 0) / trValues.length;
  const close = toFiniteNumber(relevant[relevant.length - 1]?.close);
  if (close == null || close <= 0) return null;

  return (atr / close) * 100;
}

// =============================================================================
// ✦ PROFESSIONAL INDICATOR SUITE
// All indicators below work on existing OHLCV data — no new data source needed.
// =============================================================================

/**
 * EMA over an array of numeric values.
 * Returns the full series (array aligned with `values`), with null for positions
 * before the first valid EMA.  Used internally by MACD and getEMAStack.
 */
function calculateEMASeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k = 2 / (period + 1);
  const result = new Array(values.length).fill(null);
  // Seed: SMA of the first `period` values
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  result[period - 1] = seed / period;
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/**
 * Single terminal EMA value.  Fast path when you only need the last number.
 */
export function calculateEMA(values, period) {
  const series = calculateEMASeries(values, period);
  const last = series[series.length - 1];
  return last != null ? +last.toFixed(2) : null;
}

/**
 * EMA Stack — the primary trend-regime filter.
 *
 * Bullish stack:  Price > EMA20 > EMA50  →  institutions are net-long, only take longs.
 * Bearish stack:  Price < EMA20 < EMA50  →  institutions are net-short, counter-trend
 *                                             longs carry significantly higher failure rate.
 * Mixed:          Transition / chop zone — use other filters to decide.
 *
 * Returns null for all values when there are not enough candles.
 */
export function getEMAStack(candles) {
  if (!Array.isArray(candles) || candles.length < 50) return null;
  const closes = candles.map(c => toFiniteNumber(c?.close)).filter(v => v != null);
  if (closes.length < 50) return null;

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const price  = closes[closes.length - 1];

  if (ema20 == null || ema50 == null) return null;

  const aboveEMA20     = price > ema20;
  const aboveEMA50     = price > ema50;
  const bullishStack   = aboveEMA20 && ema20 > ema50;   // Full bull regime
  const bearishStack   = !aboveEMA20 && ema20 < ema50;  // Full bear regime
  const goldenCross    = ema20 > ema50;                  // Medium-term bias

  return {
    ema20,
    ema50,
    aboveEMA20,
    aboveEMA50,
    goldenCross,
    bullishStack,
    bearishStack,
    regime: bullishStack ? 'bullish' : bearishStack ? 'bearish' : 'mixed'
  };
}

/**
 * MACD (12 / 26 / 9) — trend-direction and momentum-exhaustion filter.
 *
 * Key signals used in evaluations:
 *  • bullish:        MACD line above signal line (positive momentum)
 *  • aboveZero:      MACD line above zero (trend is up over medium term)
 *  • bullishCross:   MACD just crossed above signal (fresh momentum trigger)
 *  • histExpanding:  Histogram growing — momentum is accelerating
 */
export function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (!Array.isArray(closes) || closes.length < slow + signal + 1) return null;

  const fastSeries = calculateEMASeries(closes, fast);
  const slowSeries = calculateEMASeries(closes, slow);

  // Build MACD line only where both EMAs are valid (slow EMA starts later)
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastSeries[i] != null && slowSeries[i] != null) {
      macdLine.push(fastSeries[i] - slowSeries[i]);
    }
  }
  if (macdLine.length < signal + 1) return null;

  const signalSeries = calculateEMASeries(macdLine, signal);
  const lastIdx  = signalSeries.length - 1;
  const prevIdx  = signalSeries.length - 2;

  const lastMACD   = macdLine[macdLine.length - 1];
  const lastSignal = signalSeries[lastIdx];
  const prevMACD   = macdLine[macdLine.length - 2];
  const prevSignal = signalSeries[prevIdx];

  if (lastSignal == null || prevSignal == null) return null;

  const lastHist = lastMACD - lastSignal;
  const prevHist = prevMACD - prevSignal;

  return {
    macd:         +lastMACD.toFixed(4),
    signal:       +lastSignal.toFixed(4),
    histogram:    +lastHist.toFixed(4),
    bullish:      lastMACD > lastSignal,
    aboveZero:    lastMACD > 0,
    bullishCross: prevHist < 0 && lastHist > 0,   // Fresh bullish crossover
    bearishCross: prevHist > 0 && lastHist < 0,   // Fresh bearish crossover
    histExpanding: Math.abs(lastHist) > Math.abs(prevHist)  // Momentum accelerating
  };
}

/**
 * Bollinger Bands (20, 2σ) — volatility context and squeeze detection.
 *
 * squeeze:      Bandwidth < 3.5% → low-volatility coil, breakout likely soon.
 * percentB:     0 = at lower band, 0.5 = at midline, 1 = at upper band.
 *               >1 or <0 = price outside the bands (extended / mean-reversion risk).
 */
export function calculateBollingerBands(candles, period = 20, stdDevMult = 2) {
  if (!Array.isArray(candles) || candles.length < period) return null;
  const closes = candles.slice(-period).map(c => toFiniteNumber(c?.close)).filter(v => v != null);
  if (closes.length < period) return null;

  const mean     = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  const stdDev   = Math.sqrt(variance);
  const upper    = mean + stdDevMult * stdDev;
  const lower    = mean - stdDevMult * stdDev;
  const current  = closes[closes.length - 1];
  const bandwidth = mean > 0 ? ((upper - lower) / mean) * 100 : null;
  const percentB  = (upper - lower) > 0 ? (current - lower) / (upper - lower) : null;

  return {
    upper:        +upper.toFixed(2),
    middle:       +mean.toFixed(2),
    lower:        +lower.toFixed(2),
    bandwidth:    bandwidth != null ? +bandwidth.toFixed(2) : null,
    squeeze:      bandwidth != null && bandwidth < 3.5,
    nearUpperBand: current >= upper * 0.99,
    nearLowerBand: current <= lower * 1.01,
    percentB:     percentB != null ? +percentB.toFixed(3) : null
  };
}

/**
 * Previous Day High / Low / Close — the most-watched intraday S/R levels.
 *
 * PDH / PDL act as intraday support/resistance for the entire next session.
 * Breakouts above PDH with volume = strong intraday continuation.
 * Rejections at PDH = high-probability reversal zone.
 * PDC = overnight reference price for gap analysis.
 *
 * Works on 5m candle arrays that carry tradeDateIST or a timestamp field.
 */
export function getPreviousDayLevels(candles) {
  if (!Array.isArray(candles) || candles.length < 2) {
    return { pdh: null, pdl: null, pdc: null };
  }

  // Group candles by IST session date
  const byDate = {};
  for (const c of candles) {
    const date = c.tradeDateIST ?? getISTDate(c.timestamp);
    if (!date) continue;
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(c);
  }

  const dates = Object.keys(byDate).sort();
  if (dates.length < 2) return { pdh: null, pdl: null, pdc: null };

  const prevDate    = dates[dates.length - 2];
  const prevCandles = byDate[prevDate];
  const highs = prevCandles.map(c => toFiniteNumber(c?.high)).filter(v => v != null);
  const lows  = prevCandles.map(c => toFiniteNumber(c?.low)).filter(v => v != null);
  const pdc   = toFiniteNumber(prevCandles[prevCandles.length - 1]?.close);

  return {
    pdh: highs.length ? +Math.max(...highs).toFixed(2) : null,
    pdl: lows.length  ? +Math.min(...lows).toFixed(2)  : null,
    pdc: pdc != null  ? +pdc.toFixed(2)                : null
  };
}

/**
 * Volume Trend — is participation growing or fading?
 *
 * Compares the average volume of the first half of the lookback window
 * against the second half.  Rising volume into a move = institutional conviction.
 * Falling volume on a push = distribution / exhaustion.
 */
export function getVolumeTrend(candles, lookback = 6) {
  if (!Array.isArray(candles) || candles.length < lookback) {
    return { trend: 'unknown', ratio: null };
  }
  const recent = candles.slice(-lookback);
  const vols   = recent.map(c => toFiniteNumber(c?.volume)).filter(v => v != null && v > 0);
  if (vols.length < 4) return { trend: 'unknown', ratio: null };

  const mid      = Math.floor(vols.length / 2);
  const avgFirst  = vols.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const avgSecond = vols.slice(mid).reduce((a, b) => a + b, 0) / (vols.length - mid);
  const ratio     = avgFirst > 0 ? avgSecond / avgFirst : null;

  return {
    trend: ratio == null ? 'unknown' : ratio > 1.25 ? 'rising' : ratio < 0.78 ? 'fading' : 'neutral',
    ratio: ratio != null ? +ratio.toFixed(2) : null
  };
}

// =============================================================================
// ✦ ADVANCED INDICATOR SUITE — Round 2
// ADX, Supertrend, OBV, VWAP Bands, Candlestick Patterns
// All work on existing OHLCV — zero new data sources required.
// =============================================================================

/**
 * ADX — Average Directional Index (Wilder, 14-period default)
 *
 * The single most important trend-STRENGTH filter.
 * Direction alone (EMA stack, MACD) does not tell you if the trend is real.
 * ADX < 20 = market is choppy/ranging → breakout and trend signals are noise.
 * ADX > 25 = trend is confirmed → EMA and MACD signals become reliable.
 * ADX > 40 = strong established trend, momentum trades have highest win rate.
 *
 * +DI > -DI = bullish pressure dominant
 * -DI > +DI = bearish pressure dominant
 *
 * Returns null when there is not enough data.
 */
export function calculateADX(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period * 2 + 1) return null;

  const n = candles.length;
  const trArr     = new Array(n).fill(null);
  const plusDMArr = new Array(n).fill(null);
  const minusDMArr= new Array(n).fill(null);

  for (let i = 1; i < n; i++) {
    const high     = toFiniteNumber(candles[i]?.high);
    const low      = toFiniteNumber(candles[i]?.low);
    const prevHigh = toFiniteNumber(candles[i - 1]?.high);
    const prevLow  = toFiniteNumber(candles[i - 1]?.low);
    const prevClose= toFiniteNumber(candles[i - 1]?.close);
    if (high == null || low == null || prevHigh == null || prevLow == null || prevClose == null) continue;

    trArr[i]     = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const upMove  = high - prevHigh;
    const downMove= prevLow - low;
    plusDMArr[i]  = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDMArr[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
  }

  // Wilder's smoothing: initial = SMA, then rolling
  function wilderSmooth(arr, p) {
    const out = [];
    let sum = 0, count = 0;
    for (let i = 1; i <= p; i++) { if (arr[i] != null) { sum += arr[i]; count++; } }
    if (count < p) return out;
    out.push(sum);
    for (let i = p + 1; i < arr.length; i++) {
      const v = arr[i] ?? 0;
      out.push(out[out.length - 1] - out[out.length - 1] / p + v);
    }
    return out;
  }

  const sTR  = wilderSmooth(trArr, period);
  const sPDM = wilderSmooth(plusDMArr, period);
  const sMDM = wilderSmooth(minusDMArr, period);
  if (!sTR.length) return null;

  const plusDI  = sTR.map((tr, i) => tr > 0 ? (sPDM[i] / tr) * 100 : 0);
  const minusDI = sTR.map((tr, i) => tr > 0 ? (sMDM[i] / tr) * 100 : 0);
  const dx      = plusDI.map((p, i) => {
    const sum = p + minusDI[i];
    return sum > 0 ? (Math.abs(p - minusDI[i]) / sum) * 100 : 0;
  });

  const adxSmooth = wilderSmooth(dx, period);
  if (!adxSmooth.length) return null;

  const adx   = adxSmooth[adxSmooth.length - 1];
  const pDI   = plusDI[plusDI.length - 1];
  const mDI   = minusDI[minusDI.length - 1];

  return {
    adx:        +adx.toFixed(2),
    plusDI:     +pDI.toFixed(2),
    minusDI:    +mDI.toFixed(2),
    trending:   adx > 20,            // trend starting to develop
    strongTrend: adx > 30,           // confirmed strong trend — signals most reliable here
    direction:  pDI > mDI ? 'bullish' : 'bearish'
  };
}

/**
 * Supertrend (ATR-based trend-following line, 10-period ATR × 3 multiplier)
 *
 * Extremely popular in NSE/Indian retail and HNI circles as a clean
 * entry/exit system.  When trend = 'up', supertrendLine is a rising
 * support floor (trail your stop here).  When trend = 'down', it becomes
 * an overhead ceiling.
 *
 * crossUp  = just flipped bullish → fresh long trigger
 * crossDown = just flipped bearish → fresh short / exit long trigger
 *
 * distancePct = how far price is from the supertrend line (as % of price).
 * When distancePct > 3% in trending mode, the move may be getting extended.
 */
export function calculateSupertrend(candles, atrPeriod = 10, multiplier = 3.0) {
  if (!Array.isArray(candles) || candles.length < atrPeriod + 2) return null;
  const n = candles.length;

  // --- Wilder ATR ---
  const trArr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    trArr[i] = trueRange(candles[i], candles[i - 1]?.close);
  }
  const atrArr = new Array(n).fill(null);
  let seed = 0, seedCount = 0;
  for (let i = 1; i <= atrPeriod; i++) { if (trArr[i] != null) { seed += trArr[i]; seedCount++; } }
  if (seedCount < atrPeriod) return null;
  atrArr[atrPeriod] = seed / atrPeriod;
  for (let i = atrPeriod + 1; i < n; i++) {
    if (trArr[i] == null || atrArr[i - 1] == null) continue;
    atrArr[i] = (atrArr[i - 1] * (atrPeriod - 1) + trArr[i]) / atrPeriod;
  }

  // --- Build Supertrend bands ---
  const upperArr = new Array(n).fill(null);
  const lowerArr = new Array(n).fill(null);
  const stArr    = new Array(n).fill(null); // final supertrend value
  const dirArr   = new Array(n).fill(null); // 1=up, -1=down

  for (let i = atrPeriod; i < n; i++) {
    const atr   = atrArr[i];
    const high  = toFiniteNumber(candles[i]?.high);
    const low   = toFiniteNumber(candles[i]?.low);
    const close = toFiniteNumber(candles[i]?.close);
    if (atr == null || high == null || low == null || close == null) continue;

    const hl2    = (high + low) / 2;
    let rawUB    = hl2 + multiplier * atr;
    let rawLB    = hl2 - multiplier * atr;

    // Prevent bands from widening against the prevailing trend
    if (i > atrPeriod && upperArr[i - 1] != null && lowerArr[i - 1] != null) {
      const pc = toFiniteNumber(candles[i - 1]?.close);
      rawUB = (rawUB < upperArr[i - 1] || (pc != null && pc > upperArr[i - 1])) ? rawUB : upperArr[i - 1];
      rawLB = (rawLB > lowerArr[i - 1] || (pc != null && pc < lowerArr[i - 1])) ? rawLB : lowerArr[i - 1];
    }
    upperArr[i] = rawUB;
    lowerArr[i] = rawLB;

    if (i === atrPeriod) {
      dirArr[i] = close > rawUB ? 1 : -1;
    } else if (dirArr[i - 1] != null) {
      const prev = dirArr[i - 1];
      if (prev === -1 && close > upperArr[i])      dirArr[i] = 1;
      else if (prev === 1 && close < lowerArr[i])  dirArr[i] = -1;
      else                                          dirArr[i] = prev;
    }
    stArr[i] = dirArr[i] === 1 ? lowerArr[i] : upperArr[i];
  }

  // Find last two valid direction readings
  let lastI = -1, prevI = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (dirArr[i] != null) {
      if (lastI === -1)      lastI = i;
      else if (prevI === -1) { prevI = i; break; }
    }
  }
  if (lastI === -1) return null;

  const lastDir  = dirArr[lastI];
  const prevDir  = prevI !== -1 ? dirArr[prevI] : lastDir;
  const lastLine = stArr[lastI];
  const lastClose= toFiniteNumber(candles[lastI]?.close);

  return {
    trend:          lastDir === 1 ? 'up' : 'down',
    supertrendLine: lastLine != null ? +lastLine.toFixed(2) : null,
    crossUp:        prevDir === -1 && lastDir === 1,   // just flipped bullish (buy signal)
    crossDown:      prevDir === 1  && lastDir === -1,  // just flipped bearish (sell signal)
    distancePct:    (lastClose != null && lastLine != null && lastClose > 0)
                      ? +Math.abs((lastClose - lastLine) / lastClose * 100).toFixed(2)
                      : null
  };
}

/**
 * OBV — On-Balance Volume (institutional accumulation/distribution detector)
 *
 * OBV adds volume when price closes up, subtracts when price closes down.
 * Because institutions move large blocks quietly over many sessions, OBV
 * often LEADS price — it starts rising before price breaks out (accumulation)
 * and starts falling before price tops (distribution).
 *
 * divergence 'bullish':  price making lower lows but OBV holding / rising
 *                        → smart money accumulating → breakout likely soon
 * divergence 'bearish':  price making higher highs but OBV falling
 *                        → smart money distributing → reversal risk
 *
 * rising: OBV currently above its 20-bar MA (momentum positive)
 */
export function calculateOBV(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return null;

  let obv = 0;
  const obvSeries = [];

  for (let i = 1; i < candles.length; i++) {
    const close     = toFiniteNumber(candles[i]?.close);
    const prevClose = toFiniteNumber(candles[i - 1]?.close);
    const volume    = toFiniteNumber(candles[i]?.volume);
    if (close == null || prevClose == null || volume == null) continue;
    if (close > prevClose)      obv += volume;
    else if (close < prevClose) obv -= volume;
    // equal close → OBV unchanged
    obvSeries.push(obv);
  }

  if (obvSeries.length < 5) return null;

  // 20-bar OBV moving average for trend direction
  const maPeriod = Math.min(20, obvSeries.length);
  const obvMA = obvSeries.slice(-maPeriod).reduce((a, b) => a + b, 0) / maPeriod;
  const currentOBV = obvSeries[obvSeries.length - 1];

  // Simple divergence: compare price direction vs OBV direction over last 10 bars
  const lb = Math.min(10, obvSeries.length - 1);
  const priceNow  = toFiniteNumber(candles[candles.length - 1]?.close);
  const priceThen = toFiniteNumber(candles[candles.length - 1 - lb]?.close);
  const obvNow    = obvSeries[obvSeries.length - 1];
  const obvThen   = obvSeries[obvSeries.length - 1 - lb];

  let divergence = 'none';
  if (priceNow != null && priceThen != null) {
    const priceDown = priceNow < priceThen * 0.995;
    const priceUp   = priceNow > priceThen * 1.005;
    const obvUp     = obvNow > obvThen;
    const obvDown   = obvNow < obvThen;
    if (priceDown && obvUp)   divergence = 'bullish';  // price down, OBV up → accumulation
    if (priceUp   && obvDown) divergence = 'bearish';  // price up, OBV down → distribution
  }

  return {
    obv:        currentOBV,
    obvMA:      +obvMA.toFixed(0),
    rising:     currentOBV > obvMA,
    divergence
  };
}

/**
 * VWAP Standard Deviation Bands (±1σ and ±2σ)
 *
 * Naked VWAP tells you the fair-value price. The bands tell you HOW FAR
 * price has stretched from that fair value in volatility-adjusted terms.
 *
 *  sd2Upper → price is 2 standard deviations above VWAP (overextended, fade risk)
 *  sd1Upper → mild extension, momentum still valid
 *  sd1Lower → healthy pullback into VWAP zone, potential re-entry
 *  sd2Lower → oversold extreme, mean-reversion / reversal opportunity
 *
 * aboveSD2 / belowSD2: flags for extreme intraday extension.
 * Use these to avoid chasing and to identify high-probability reversal entries.
 */
export function calculateVWAPBands(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  let pvSum = 0, volSum = 0;
  const tpVolPairs = [];

  for (const c of candles) {
    const high   = toFiniteNumber(c?.high);
    const low    = toFiniteNumber(c?.low);
    const close  = toFiniteNumber(c?.close);
    const volume = toFiniteNumber(c?.volume);
    if (high == null || low == null || close == null || volume == null || volume <= 0) continue;

    const tp  = (high + low + close) / 3;
    pvSum    += tp * volume;
    volSum   += volume;
    tpVolPairs.push({ tp, vol: volume });
  }

  if (volSum === 0 || tpVolPairs.length === 0) return null;

  const vwap = pvSum / volSum;

  // Volume-weighted variance
  let varianceSum = 0;
  for (const { tp, vol } of tpVolPairs) {
    varianceSum += vol * (tp - vwap) ** 2;
  }
  const stdDev    = Math.sqrt(varianceSum / volSum);
  const sd1Upper  = vwap + stdDev;
  const sd1Lower  = vwap - stdDev;
  const sd2Upper  = vwap + 2 * stdDev;
  const sd2Lower  = vwap - 2 * stdDev;
  const lastClose = toFiniteNumber(candles[candles.length - 1]?.close);

  return {
    vwap:      +vwap.toFixed(2),
    sd1Upper:  +sd1Upper.toFixed(2),
    sd1Lower:  +sd1Lower.toFixed(2),
    sd2Upper:  +sd2Upper.toFixed(2),
    sd2Lower:  +sd2Lower.toFixed(2),
    stdDev:    +stdDev.toFixed(2),
    aboveSD2:  lastClose != null && lastClose > sd2Upper,
    belowSD2:  lastClose != null && lastClose < sd2Lower,
    aboveSD1:  lastClose != null && lastClose > sd1Upper,
    belowSD1:  lastClose != null && lastClose < sd1Lower,
  };
}

/**
 * Candlestick Pattern Detector (single + two-candle patterns)
 *
 * These patterns are NOT magic — they only matter as confirmation when the
 * broader context (EMA, VWAP, ADX, volume) already supports a trade.
 * Use them to time entries, not to justify counter-trend moves.
 *
 * Patterns detected:
 *   bullishEngulfing  — strong reversal (bearish → bullish)
 *   bearishEngulfing  — strong reversal (bullish → bearish)
 *   hammer            — reversal from lows (long lower wick, small body at top)
 *   shootingStar      — reversal from highs (long upper wick, small body at bottom)
 *   doji              — indecision (body < 10% of range)
 *   marubozu          — pure momentum candle (body > 85% of range, no significant wicks)
 *   insideBar         — consolidation / coil (entire range inside prior candle)
 */
export function detectCandlePattern(candles) {
  const NONE = { pattern: 'none', direction: 'neutral', strength: 'none' };
  if (!Array.isArray(candles) || candles.length < 2) return NONE;

  const c0 = candles[candles.length - 1];
  const c1 = candles[candles.length - 2];

  const open0  = toFiniteNumber(c0?.open);
  const close0 = toFiniteNumber(c0?.close);
  const high0  = toFiniteNumber(c0?.high);
  const low0   = toFiniteNumber(c0?.low);
  const open1  = toFiniteNumber(c1?.open);
  const close1 = toFiniteNumber(c1?.close);
  const high1  = toFiniteNumber(c1?.high);
  const low1   = toFiniteNumber(c1?.low);

  if (open0 == null || close0 == null || high0 == null || low0 == null) return NONE;

  const body0       = Math.abs(close0 - open0);
  const body1       = open1 != null && close1 != null ? Math.abs(close1 - open1) : null;
  const range0      = high0 - low0;
  const isBullish0  = close0 > open0;
  const isBullish1  = close1 != null && open1 != null ? close1 > open1 : null;
  const upperWick0  = high0 - Math.max(open0, close0);
  const lowerWick0  = Math.min(open0, close0) - low0;

  if (range0 <= 0) return NONE;

  // --- Doji: body is tiny relative to range (indecision) ---
  if (body0 / range0 < 0.10) {
    return { pattern: 'doji', direction: 'neutral', strength: 'moderate' };
  }

  // --- Marubozu: near-pure momentum candle, virtually no wicks ---
  if (body0 / range0 > 0.85) {
    return {
      pattern: 'marubozu',
      direction: isBullish0 ? 'bullish' : 'bearish',
      strength: 'strong'
    };
  }

  // --- Hammer: long lower wick (≥ 2× body), small upper wick (≤ 30% body) ---
  if (lowerWick0 >= 2 * body0 && upperWick0 <= 0.3 * body0 && body0 > 0) {
    return { pattern: 'hammer', direction: 'bullish', strength: 'strong' };
  }

  // --- Shooting Star: long upper wick (≥ 2× body), small lower wick ---
  if (upperWick0 >= 2 * body0 && lowerWick0 <= 0.3 * body0 && body0 > 0) {
    return { pattern: 'shootingStar', direction: 'bearish', strength: 'strong' };
  }

  // Two-candle patterns — need prior candle data
  if (body1 != null && isBullish1 != null && open1 != null && close1 != null && high1 != null && low1 != null) {
    // --- Bullish Engulfing: current green body fully covers prior red body ---
    if (isBullish0 && !isBullish1 && open0 <= close1 && close0 >= open1 && body0 > body1 * 1.05) {
      return { pattern: 'bullishEngulfing', direction: 'bullish', strength: 'strong' };
    }

    // --- Bearish Engulfing: current red body fully covers prior green body ---
    if (!isBullish0 && isBullish1 && open0 >= close1 && close0 <= open1 && body0 > body1 * 1.05) {
      return { pattern: 'bearishEngulfing', direction: 'bearish', strength: 'strong' };
    }

    // --- Inside Bar: current range entirely within prior range (coil / pause) ---
    if (high0 <= high1 && low0 >= low1) {
      return { pattern: 'insideBar', direction: 'neutral', strength: 'moderate' };
    }
  }

  return NONE;
}
