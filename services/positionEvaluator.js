/**
 * ==================================================
 * SWING TRADING EVALUATION
 * Horizon: 3–15 trading days
 *
 * Philosophy:
 * - Institutions enter when momentum is healthy,
 *   not when price is euphoric or collapsing
 * - RSI mid-zone + low gap = controlled participation
 * ==================================================
 */
export function evaluateSwing({ rsi, gapOpenPct }) {
  // 1️⃣ Institutional sweet spot
  // RSI in 48–58 is where trend-following desks prefer entries
  if (
    rsi >= 48 &&
    rsi <= 58 &&
    Math.abs(gapOpenPct) <= 1.0
  ) {
    return {
      label: 'High-Quality Swing Setup',
      sentiment: 'positive'
    }
  }

  // 2️⃣ Early momentum pickup (watchlist zone)
  // Often seen after shallow pullbacks in strong stocks
  if (
    rsi >= 42 &&
    rsi < 48 &&
    Math.abs(gapOpenPct) < 0.8
  ) {
    return {
      label: 'Potential Swing – Needs Confirmation',
      sentiment: 'neutral'
    }
  }

  // 3️⃣ Late-stage momentum (crowded trade)
  // Most swing traders get trapped here
  if (rsi > 65) {
    return {
      label: 'Late Move – Risky for Fresh Entry',
      sentiment: 'negative'
    }
  }

  // 4️⃣ Weak / broken structure
  return {
    label: 'No Swing Opportunity',
    sentiment: 'negative'
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
export function evaluateLongTerm({ rsi, marketCap }) {
  // Defensive guard
  if (!marketCap || marketCap <= 0) {
    return {
      label: 'Insufficient Data',
      sentiment: 'neutral'
    }
  }

  // 1️⃣ Prime accumulation zone (institutional buying)
  // Large caps + RSI 38–45 = fear without breakdown
  if (
    marketCap >= 5e10 &&
    rsi >= 38 &&
    rsi <= 45
  ) {
    return {
      label: 'Strong Long-Term Accumulation Zone',
      sentiment: 'positive'
    }
  }

  // 2️⃣ Hold zone (trend healthy, valuation normal)
  // Most mutual funds sit here
  if (
    marketCap >= 5e10 &&
    rsi > 45 &&
    rsi <= 60
  ) {
    return {
      label: 'Hold – Add Only on Dips',
      sentiment: 'neutral'
    }
  }

  // 3️⃣ Deep weakness – avoid catching falling knives
  // Big funds wait for base formation here
  if (rsi < 38) {
    return {
      label: 'High Risk – Wait for Stability',
      sentiment: 'negative'
    }
  }

  // 4️⃣ Default
  return {
    label: 'Not a Long-Term Accumulation Candidate',
    sentiment: 'negative'
  }
}
