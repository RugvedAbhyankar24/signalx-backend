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

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function detectVolumeSpike(candles, lookback = 20, multiplier = 1.5) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { volumeSpike: false, avgVolume: null, latestVolume: null };
  }

  const latestVol = toFiniteNumber(candles[candles.length - 1]?.volume);
  const vols = candles
    .slice(-lookback - 1, -1)
    .map(c => toFiniteNumber(c?.volume))
    .filter(v => v != null && v >= 0);
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

  const todayIST = IST_DATE_FORMATTER.format(new Date());

  // Filter for today's IST trading session
  const todayCandles = candles.filter(c =>
    c.tradeDateIST === todayIST || getISTDate(c.timestamp) === todayIST
  );
  
  // If no today's candles, use last few candles as fallback
  const candlesToUse = todayCandles.length > 0 ? todayCandles : candles.slice(-5);

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
  const lows = recent.map(c => toFiniteNumber(c?.low)).filter(v => v != null);
  const highs = recent.map(c => toFiniteNumber(c?.high)).filter(v => v != null);

  return {
    support: lows.length ? Math.min(...lows) : null,
    resistance: highs.length ? Math.max(...highs) : null,
  };
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
    .map(p => toFiniteNumber(p?.close))
    .filter(v => v != null);

  if (closes.length < period + 1) {
    return 50; // Not enough data
  }

  let gains = 0;
  let losses = 0;
  
  // Calculate initial average gains and losses
  for (let i = 1; i <= period; i++) {
    const difference = closes[i] - closes[i - 1];
    if (difference >= 0) {
      gains += difference;
    } else {
      losses -= difference; // Make losses positive
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period || 1; // Avoid division by zero
  
  // Calculate subsequent values
  for (let i = period + 1; i < closes.length; i++) {
    const difference = closes[i] - closes[i - 1];
    
    if (difference >= 0) {
      avgGain = (avgGain * (period - 1) + difference) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - difference) / period;
    }
  }

  const rs = avgGain / (avgLoss || 0.0001); // Avoid division by zero
  return 100 - (100 / (1 + rs));
}
