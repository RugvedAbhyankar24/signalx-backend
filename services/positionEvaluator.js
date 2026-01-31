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

  /* =========================
     1️⃣ HIGH-CONVICTION SWING
  ========================== */
  if (
    rsi >= 48 &&
    rsi <= 60 &&
    Math.abs(gapOpenPct) <= 0.8 &&
    volumeSpike &&
    aboveVWAP &&
    !nearResistance
  ) {
    reasons.push('Healthy momentum in institutional RSI zone')
    reasons.push('Price above VWAP indicates favorable cost structure')
    reasons.push('Volume expansion confirms smart money participation')

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
    rsi >= 42 &&
    rsi < 48 &&
    volumeSpike &&
    aboveVWAP &&
    !nearResistance
  ) {
    reasons.push('Early momentum emerging after consolidation')
    reasons.push('Volume pickup suggests accumulation')
    reasons.push('Await further confirmation before entry')

    return {
      label: 'Potential Swing – Needs Confirmation',
      sentiment: 'neutral',
      reasons
    }
  }

  /* =========================
     3️⃣ SUPPORT-BASED BOUNCE
  ========================== */
  if (
    rsi >= 38 &&
    rsi <= 45 &&
    nearSupport &&
    volumeSpike
  ) {
    reasons.push('Price reacting near support zone')
    reasons.push('Controlled pessimism with institutional interest')
    reasons.push('Suitable only for tactical swing traders')

    return {
      label: 'Support-Based Swing Attempt',
      sentiment: 'neutral',
      reasons
    }
  }

  /* =========================
     4️⃣ CROWDED / LATE MOVE
  ========================== */
  if (rsi > 65) {
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
     5️⃣ GAP RISK / STRUCTURE WEAK
  ========================== */
  if (Math.abs(gapOpenPct) > 1.5) {
    reasons.push('Large overnight gap increases volatility risk')
    reasons.push('Institutional desks prefer stability for swing trades')

    return {
      label: 'High Gap Risk – Avoid Swing Trade',
      sentiment: 'negative',
      reasons
    }
  }

  /* =========================
     6️⃣ DEFAULT: NO EDGE
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
    rsi >= 45 &&
    rsi <= 65 &&
    effectiveGap > 0.5 &&
    effectiveGap < 2.5 &&
    volumeSpike &&
    aboveVWAP &&
    candleColor === 'green' &&
    !nearResistance
  ) {
    reasons.push('Gap up with strong volume confirmation')
    reasons.push('Price above VWAP shows bullish momentum')
    reasons.push('RSI in optimal intraday range (45-65)')
    reasons.push('Green candle confirms buying pressure')

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
    rsi >= 50 &&
    rsi <= 70 &&
    volumeSpike &&
    aboveVWAP &&
    candleColor === 'green' &&
    effectiveGap > 0
  ) {
    reasons.push('Momentum continuation with volume support')
    reasons.push('Trading above key VWAP level')
    reasons.push('RSI shows sustained bullish momentum')

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
    volumeSpike &&
    rsi >= 55 &&
    rsi <= 75 &&
    candleColor === 'green'
  ) {
    reasons.push('Breaking resistance with high volume')
    reasons.push('RSI indicates strength for breakout')
    reasons.push('Volume confirms institutional participation')

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

