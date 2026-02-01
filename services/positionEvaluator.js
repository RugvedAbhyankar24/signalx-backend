/**
 * ==================================================
 * SWING TRADING EVALUATION (Institutional Grade)
 * Horizon: 3–15 trading days
 *
 * Philosophy:
 * - Trade with institutions, not emotions
 * - Momentum + Liquidity + Location
 * - Avoid crowded & low-quality moves
 * ==================================================
 */
export function evaluateSwing({
  rsi,
  gapOpenPct,
  volumeSpike,
  price,
  vwap,
  support,
  resistance
}) {
  const reasons = []

  const aboveVWAP = price > vwap
  const nearResistance = resistance && price >= resistance * 0.97
  const nearSupport = support && price <= support * 1.05
  const volumeOK = volumeSpike || (price > vwap && rsi > 50)

  // Gap segregation - eliminate event-driven volatility
  const isGapDay = Math.abs(gapOpenPct) >= 1.2

  if (isGapDay && !volumeSpike) {
    return {
      label: 'Gap Day – Avoid Swing',
      sentiment: 'negative',
      reasons: ['Gap-driven volatility unsuitable for swing trades']
    }
  }

  /* =========================
     1️⃣ HIGH-CONVICTION SWING
  ========================== */
  if (
    rsi >= 45 &&
    rsi <= 65 &&
    Math.abs(gapOpenPct) <= 2.0 &&
    volumeOK &&
    aboveVWAP &&
    !nearResistance
  ) {
    reasons.push('Momentum in favorable RSI zone')
    reasons.push('Price above VWAP indicates bullish structure')
    reasons.push(volumeSpike ? 'Volume confirms participation' : 'Building momentum')

    return {
      label: 'High-Quality Swing Setup',
      sentiment: 'positive',
      reasons
    }
  }

  /* =========================
     2️⃣ EARLY MOMENTUM (WATCH)
  ========================== */
  if (
    rsi >= 35 &&
    rsi < 50 &&
    volumeOK &&
    !nearResistance
  ) {
    reasons.push('Early momentum emerging')
    reasons.push(aboveVWAP ? 'Price above VWAP is bullish' : 'Building base below VWAP')
    reasons.push(volumeSpike ? 'Volume pickup suggests accumulation' : 'Watch for volume confirmation')

    return {
      label: 'Potential Swing – Needs Confirmation',
      sentiment: 'positive',
      reasons
    }
  }

  /* =========================
     3️⃣ SUPPORT-BASED BOUNCE
  ========================== */
  if (
    rsi >= 30 &&
    rsi <= 55 &&
    nearSupport &&
    (aboveVWAP || volumeSpike)
  ) {
    reasons.push('Price reacting near support zone')
    reasons.push(volumeSpike ? 'Volume confirms institutional interest' : 'Watch for volume confirmation')
    reasons.push('Suitable for tactical swing entry')

    return {
      label: 'Support-Based Swing Attempt',
      sentiment: 'positive',
      reasons
    }
  }

  /* =========================
     4️⃣ MOMENTUM BREAKOUT
  ========================== */
  if (
    rsi >= 45 &&
    rsi <= 75 &&
    nearResistance &&
    volumeOK
  ) {
    reasons.push('Breaking resistance with momentum')
    reasons.push(volumeSpike ? 'Volume confirms breakout strength' : 'Watch for volume on breakout')
    reasons.push('High-potential swing setup')

    return {
      label: 'Breakout Swing Setup',
      sentiment: 'positive',
      reasons
    }
  }

  /* =========================
     5️⃣ CONSOLIDATION PLAY
  ========================== */
  if (
    rsi >= 40 &&
    rsi <= 60 &&
    Math.abs(gapOpenPct) <= 1.0 &&
    !nearResistance &&
    !nearSupport &&
    volumeOK
  ) {
    reasons.push('Stock in consolidation phase')
    reasons.push('Awaiting breakout direction')
    reasons.push(volumeSpike ? 'Volume suggests impending move' : 'Add to watchlist')

    return {
      label: 'Consolidation Watch',
      sentiment: 'positive',
      reasons
    }
  }

  /* =========================
     6️⃣ CROWDED / LATE MOVE
  ========================== */
  if (rsi > 75) {
    reasons.push('Momentum is overheated and crowded')
    reasons.push('Risk of sharp profit booking')
    reasons.push('Unfavorable risk–reward for fresh entries')

    return {
      label: 'Late Move – Avoid Fresh Entry',
      sentiment: 'negative',
      reasons
    }
  }

  /* =========================
     7️⃣ GAP RISK / STRUCTURE WEAK
  ========================== */
  if (Math.abs(gapOpenPct) > 2.0) {
    reasons.push('Large overnight gap increases volatility risk')
    reasons.push('Institutional desks prefer stability for swing trades')

    return {
      label: 'High Gap Risk – Avoid Swing Trade',
      sentiment: 'negative',
      reasons
    }
  }

  /* =========================
     8️⃣ DEFAULT: NO EDGE
  ========================== */
  reasons.push('Momentum, liquidity, or structure not aligned')
  reasons.push('No institutional edge visible')

  return {
    label: 'No Swing Opportunity',
    sentiment: 'negative',
    reasons
  }
}


/**
 * ==================================================
 * LONG-TERM / ACCUMULATION EVALUATION
 * Horizon: Months to Years
 *
 * Philosophy:
 * - Inspired by large AMCs & value investors
 * - Buy quality during controlled pessimism
 * - Avoid "cheap for a reason" traps
 * ==================================================
 */
// export function evaluateLongTerm({ rsi, marketCap }) {
//   // Defensive guard
//   if (!marketCap || marketCap <= 0) {
//     return {
//       label: 'Insufficient Data',
//       sentiment: 'neutral'
//     }
//   }

//   // 1️⃣ Prime accumulation zone (institutional buying)
//   // Large caps + RSI 38–45 = fear without breakdown
//   if (
//     marketCap >= 5e10 &&
//     rsi >= 38 &&
//     rsi <= 45
//   ) {
//     return {
//       label: 'Strong Long-Term Accumulation Zone',
//       sentiment: 'positive'
//     }
//   }

//   // 2️⃣ Hold zone (trend healthy, valuation normal)
//   // Most mutual funds sit here
//   if (
//     marketCap >= 5e10 &&
//     rsi > 45 &&
//     rsi <= 60
//   ) {
//     return {
//       label: 'Hold – Add Only on Dips',
//       sentiment: 'neutral'
//     }
//   }

//   // 3️⃣ Deep weakness – avoid catching falling knives
//   // Big funds wait for base formation here
//   if (rsi < 38) {
//     return {
//       label: 'High Risk – Wait for Stability',
//       sentiment: 'negative'
//     }
//   }

//   // 4️⃣ Default
//   return {
//     label: 'Not a Long-Term Accumulation Candidate',
//     sentiment: 'negative'
//   }
// }
import { evaluateFundamentals } from './fundamentalAnalyzer.js'

export function evaluateLongTerm({ rsi, marketCap, fundamentals }) {
  if (!marketCap || !fundamentals) {
    return {
      label: 'Insufficient Data',
      sentiment: 'neutral'
    }
  }

  const { score, reasons } = evaluateFundamentals({
    marketCap,
    ...fundamentals
  })

  const goodTiming = rsi >= 38 && rsi <= 45
  const neutralTiming = rsi > 45 && rsi <= 60

  // 1️⃣ Elite long-term entry (rare)
  if (score >= 5 && goodTiming) {
    return {
      label: 'High-Conviction Long-Term Accumulation',
      sentiment: 'positive',
      reasons
    }
  }

  // 2️⃣ Strong business, normal accumulation
  if (score >= 4 && neutralTiming) {
    return {
      label: 'Quality Business – Accumulate on Dips',
      sentiment: 'neutral',
      reasons
    }
  }

  // 3️⃣ Capitulation zone (watch, not rush)
  if (rsi < 30 && score >= 4) {
    return {
      label: 'High-Quality Business – Capitulation Zone',
      sentiment: 'neutral',
      reasons
    }
  }

  // 4️⃣ Timing risk, business intact
if (rsi < 38 && score >= 3) {
  return {
    label: 'Fundamentals Good, Timing Risky',
    sentiment: 'neutral',
    reasons
  }
}
if (rsi > 65 && score >= 4) {
  return {
    label: 'Strong Business, Overheated Zone – Avoid Fresh Buying',
    sentiment: 'neutral',
    reasons
  }
}


  // 5️⃣ Weak setup
  return {
    label: 'Weak Long-Term Setup',
    sentiment: 'negative',
    reasons
  }
}

/**
 * ==================================================
 * INTRADAY EVALUATION
 * Horizon: Same day trading
 *
 * Philosophy:
 * - Momentum + Volume + Price Action
 * - Quick entries and exits
 * - Focus on liquid stocks with clear direction
 * ==================================================
 */
export function evaluateIntraday({
  rsi,
  gapOpenPct,
  gapNowPct,
  volumeSpike,
  price,
  vwap,
  support,
  resistance,
  candleColor,
  marketCap
}) {
  const reasons = []
  
  const aboveVWAP = price > vwap
  const belowVWAP = price < vwap
  const nearResistance = resistance && price >= resistance * 0.98
  const nearSupport = support && price <= support * 1.02
  const effectiveGap = gapNowPct || gapOpenPct
  const volumeOK = volumeSpike || (price > vwap && rsi > 50)

  // Protect against CHOP days - filter sideways markets
  if (
    Math.abs(effectiveGap) < 0.2 &&
    !volumeSpike &&
    Math.abs(price - vwap) / vwap < 0.002
  ) {
    reasons.push('Low volatility chop – intraday edge absent')
    return {
      label: 'Choppy Market – Avoid',
      sentiment: 'neutral',
      reasons
    }
  }
  
  // Filter for liquid stocks (market cap > 1000 cr)
  if (!marketCap || marketCap < 1e10) {
    reasons.push('Insufficient liquidity for intraday trading')
    return {
      label: 'Low Liquidity - Avoid',
      sentiment: 'negative',
      reasons
    }
  }

  /* =========================
     1️⃣ STRONG INTRADAY BUY
  ========================== */
  if (
    rsi >= 48 && rsi <= 62 &&
    effectiveGap >= 0.3 &&
    effectiveGap < 3.0 &&
    volumeOK &&
    aboveVWAP &&
    !nearResistance
  ) {
    reasons.push(effectiveGap > 0.5 ? 'Gap up with momentum' : 'Positive price action')
    reasons.push('Price above VWAP shows bullish structure')
    reasons.push('RSI in favorable intraday range')
    reasons.push(candleColor === 'green' ? 'Green candle confirms buying pressure' : 'Building momentum')

    return {
      label: 'Strong Intraday Buy',
      sentiment: 'positive',
      reasons
    }
  }

  /* =========================
     2️⃣ MOMENTUM CONTINUATION
  ========================== */
  if (
    rsi >= 48 &&
    rsi <= 65 &&
    volumeOK &&
    aboveVWAP &&
    effectiveGap >= 0
  ) {
    reasons.push('Momentum continuation pattern')
    reasons.push('Trading above key VWAP level')
    reasons.push(volumeSpike ? 'Volume supports the move' : 'Watch for volume confirmation')
    reasons.push(candleColor === 'green' ? 'Bullish candle pattern' : 'Consolidating with upside bias')

    return {
      label: 'Momentum Continuation',
      sentiment: 'positive',
      reasons
    }
  }

  /* =========================
     3️⃣ BREAKOUT PLAY
  ========================== */
  if (
    nearResistance &&
    volumeOK &&
    rsi >= 50 &&
    rsi <= 80
  ) {
    reasons.push('Near resistance with breakout potential')
    reasons.push(volumeSpike ? 'Volume indicates institutional interest' : 'Watch for volume on breakout')
    reasons.push(candleColor === 'green' ? 'Bullish momentum toward resistance' : 'Consolidating before breakout')

    return {
      label: 'Breakout Candidate',
      sentiment: 'positive',
      reasons
    }
  }

  /* =========================
     4️⃣ AVOID - OVERBOUGHT
  ========================== */
  if (rsi > 75) {
    reasons.push('RSI extremely overbought (>75)')
    reasons.push('High risk of reversal or profit booking')
    reasons.push('Unfavorable risk-reward for fresh entry')

    return {
      label: 'Overbought - Avoid',
      sentiment: 'negative',
      reasons
    }
  }

  /* =========================
     5️⃣ AVOID - BELOW VWAP
  ========================== */
  if (
    belowVWAP &&
    candleColor === 'red' &&
    effectiveGap < -0.5
  ) {
    reasons.push('Trading below VWAP with bearish momentum')
    reasons.push('Gap down indicates weakness')
    reasons.push('Red candle confirms selling pressure')

    return {
      label: 'Bearish Momentum - Avoid',
      sentiment: 'negative',
      reasons
    }
  }

  /* =========================
     6️⃣ DEFAULT: NO CLEAR SIGNAL
  ========================== */
  reasons.push('No clear intraday signal detected')
  reasons.push('Insufficient momentum or volume confirmation')

  return {
    label: 'No Clear Intraday Signal',
    sentiment: 'neutral',
    reasons
  }
}

