export function makeDecision({
  gapPct,
  rsi,
  rsiCategory,
  confirmation = false,
  rsiBias,
  candleColor
}) {
  const GAP_WEAK = 0.8
  const GAP_STRONG = 2.0

  const isStrongGapUp = gapPct >= GAP_STRONG
  const isStrongGapDown = gapPct <= -GAP_STRONG
  const isWeakGap = Math.abs(gapPct) >= GAP_WEAK && Math.abs(gapPct) < GAP_STRONG


  /* =====================
     1️⃣ GAP TOO SMALL
  ====================== */
  if (Math.abs(gapPct) < GAP_WEAK) {
    return {
      label: 'No Trade',
      sentiment: 'neutral',
      reason: 'Gap too small — market noise',
      icon: 'ℹ️'
    }
  }

  /* =====================
     2️⃣ WEAK GAP MOMENTUM
  ====================== */
  if (
    isWeakGap &&
    confirmation &&
    rsiBias === 'bullish' &&
    candleColor === 'green'
  ) {
    return {
      label: 'Tradeable',
      sentiment: 'positive',
      reason: 'Weak gap with strong momentum continuation',
      icon: '✅'
    }
  }

  /* =====================
     3️⃣ STRONG GAP UP
  ====================== */
  if (isStrongGapUp) {
    if (rsiCategory === 'overbought') {
      return {
        label: 'Cautious',
        sentiment: 'neutral',
        reason: `Strong gap up but RSI high (${rsi})`,
        icon: '⚠️'
      }
    }

    if (confirmation && rsiBias === 'bullish' && candleColor === 'green') {
      return {
        label: 'Tradeable',
        sentiment: 'positive',
        reason: 'Strong gap up with volume, VWAP & bullish structure',
        icon: '✅'
      }
    }

    return {
      label: 'Cautious',
      sentiment: 'neutral',
      reason: 'Gap up but confirmation weak',
      icon: '⚠️'
    }
  }

  /* =====================
     4️⃣ STRONG GAP DOWN
  ====================== */
  if (isStrongGapDown) {
    if (rsiCategory === 'oversold' && candleColor === 'green') {
      return {
        label: 'Cautious',
        sentiment: 'neutral',
        reason: 'Gap down with oversold RSI and reversal attempt',
        icon: '⚠️'
      }
    }

    return {
      label: 'Avoid',
      sentiment: 'negative',
      reason: 'Strong gap down with bearish structure',
      icon: '❌'
    }
  }

  /* =====================
     FALLBACK
  ====================== */
  return {
    label: 'No Trade',
    sentiment: 'neutral',
    reason: 'Unclear structure',
    icon: 'ℹ️',
  }
}



