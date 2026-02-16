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

export function detectVolumeSpike(candles, lookback = 20, multiplier = 1.5) {
  const vols = candles.slice(-lookback - 1, -1).map(c => c.volume);
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const latestVol = candles[candles.length - 1].volume;

  return {
    volumeSpike: latestVol > avgVol * multiplier,
    avgVolume: Math.round(avgVol),
    latestVolume: latestVol,
  };
}

export function calculateVWAP(candles) {
  let pv = 0;
  let vol = 0;

  candles.forEach(c => {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    pv += typicalPrice * c.volume;
    vol += c.volume;
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
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    vol += c.volume;
  }

  return vol === 0 ? null : +(pv / vol).toFixed(2);
}

export function calculateSwingVWAP(candles, days = 5) {
  // Calculate 5-day VWAP for swing trading (institutional approach)
  // For daily data, we only need 'days' number of candles, not days * 20
  const swingCandles = candles.slice(-days); // Take last 5 daily candles
  let pv = 0;
  let vol = 0;

  swingCandles.forEach(c => {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    pv += typicalPrice * c.volume;
    vol += c.volume;
  });

  return vol === 0 ? null : +(pv / vol).toFixed(2);
}

export function supportResistance(candles, lookback = 20) {
  const recent = candles.slice(-lookback);
  return {
    support: Math.min(...recent.map(c => c.low)),
    resistance: Math.max(...recent.map(c => c.high)),
  };
}

export function detectBreakout(price, resistance, bufferPct = 0.3) {
  return price > resistance * (1 + bufferPct / 100);
}

export function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) {
    return 50; // Not enough data
  }

  let gains = 0;
  let losses = 0;
  
  // Calculate initial average gains and losses
  for (let i = 1; i <= period; i++) {
    const difference = prices[i].close - prices[i - 1].close;
    if (difference >= 0) {
      gains += difference;
    } else {
      losses -= difference; // Make losses positive
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period || 1; // Avoid division by zero
  
  // Calculate subsequent values
  for (let i = period + 1; i < prices.length; i++) {
    const difference = prices[i].close - prices[i - 1].close;
    
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
