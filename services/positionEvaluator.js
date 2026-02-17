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
  gapNowPct,
  volumeSpike,
  price,
  swingVWAP,
  support,
  resistance
}) {
  // 🛡️ DEFENSIVE GUARD: Check swingVWAP availability
  if (!swingVWAP || !isFinite(swingVWAP)) {
    return {
      label: 'Insufficient Structure Data',
      sentiment: 'neutral',
      reasons: ['Swing VWAP unavailable']
    }
  }

  const reasons = []

  const aboveStructure = price > swingVWAP
  const breakoutConfirmed = getBreakoutConfirmation(resistance, price, volumeSpike)
  const nearSupport = support && price <= support * 1.05
  const volumeOK = volumeSpike || (price > swingVWAP && rsi > 50)
  const effectiveGap = Number.isFinite(gapNowPct)
    ? gapNowPct
    : (Number.isFinite(gapOpenPct) ? gapOpenPct : 0)

  // Hard blockers for institutional swing quality
  if (effectiveGap <= -4.0) {
    return {
      label: 'Capitulation Gap Risk – Avoid Swing',
      sentiment: 'negative',
      reasons: ['Deep negative gap indicates event-risk regime, avoid fresh swing entries']
    }
  }

  if (effectiveGap <= -2.8 && !nearSupport) {
    return {
      label: 'Sharp Gap Down – Structure Weak',
      sentiment: 'negative',
      reasons: ['Sharp downside gap without support proximity weakens institutional swing setup']
    }
  }

  if (!aboveStructure && rsi < 40 && effectiveGap <= -1.5) {
    return {
      label: 'Weak Structure – Avoid Swing',
      sentiment: 'negative',
      reasons: ['Price below swing VWAP with weak RSI in negative gap context']
    }
  }

  // Gap segregation - eliminate event-driven volatility
  const isLargeGap = Math.abs(effectiveGap) >= 2.5

  if (isLargeGap && effectiveGap < 0 && !volumeSpike) {
    return {
      label: 'Large Gap – Avoid Swing',
      sentiment: 'negative',
      reasons: ['Large event-driven gap without volume confirmation']
    }
  }

  /* =========================
     1️⃣ HIGH-CONVICTION SWING
  ========================== */
  if (
    rsi >= 45 &&
    rsi <= 65 &&
    effectiveGap >= -1.0 &&
    effectiveGap <= 5.5 &&
    volumeOK &&
    aboveStructure &&
    !breakoutConfirmed
  ) {
    reasons.push('Momentum in favorable RSI zone')
    reasons.push('Price above swing VWAP indicates bullish structure')
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
    effectiveGap > -2.2 &&
    (aboveStructure || nearSupport) &&
    volumeOK &&
    !breakoutConfirmed
  ) {
    reasons.push('Early momentum emerging')
    reasons.push(aboveStructure ? 'Price above swing VWAP is bullish' : 'Building base below swing VWAP')
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
    effectiveGap > -2.8 &&
    nearSupport &&
    (aboveStructure || volumeSpike)
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
    rsi <= 68 && // 🔧 FIX: Cap RSI lower to avoid distribution tops
    breakoutConfirmed &&
    effectiveGap > -1.5 &&
    effectiveGap <= 5.0 // 🔧 FIX: Add gap filter to avoid chasing tops
  ) {
    reasons.push('Breaking resistance with volume confirmation')
    reasons.push('Institutional-grade breakout confirmed')
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
    Math.abs(effectiveGap) <= 1.5 &&
    !breakoutConfirmed &&
    !nearSupport
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
  if (effectiveGap < -2.0) {
    reasons.push('Negative gap context increases downside event risk')
    reasons.push('Institutional desks avoid weak-structure recovery attempts')

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

const DEFAULT_INTRADAY_ROUND_TRIP_COST_BPS = Number(process.env.INTRADAY_ROUND_TRIP_COST_BPS || 18)
const DEFAULT_SWING_ROUND_TRIP_COST_BPS = Number(process.env.SWING_ROUND_TRIP_COST_BPS || 30)

function calculateRiskReward(entryPrice, stopLoss, target1) {
  const risk = entryPrice - stopLoss
  const reward = target1 - entryPrice
  if (!Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0) return null
  return reward / risk
}

function applyRoundTripCostModel({ entryPrice, stopLoss, target1, costBps }) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null
  const rrGross = calculateRiskReward(entryPrice, stopLoss, target1)
  if (rrGross == null) return null

  const effectiveCostBps = Number.isFinite(costBps) && costBps >= 0 ? costBps : 0
  const roundTripCostPerShare = entryPrice * (effectiveCostBps / 10000)

  const grossRiskPerShare = Math.max(entryPrice - stopLoss, 0)
  const grossRewardPerShare = Math.max(target1 - entryPrice, 0)
  const netRiskPerShare = grossRiskPerShare + roundTripCostPerShare
  const netRewardPerShare = Math.max(grossRewardPerShare - roundTripCostPerShare, 0)
  const rrNet = netRiskPerShare > 0 ? netRewardPerShare / netRiskPerShare : null

  return {
    riskRewardGross: rrGross,
    riskRewardAfterCosts: rrNet,
    estimatedRoundTripCostPerShare: roundTripCostPerShare,
    estimatedRoundTripCostPct: effectiveCostBps / 100
  }
}

function formatRatio(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00'
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

function roundToPaise(value) {
  return Math.round(value * 100) / 100
}

// TRUE BREAKOUT CONFIRMATION LOGIC
function getBreakoutConfirmation(resistance, price, volumeSpike) {
  return (
    resistance &&
    price > resistance * 1.002 && // acceptance - 0.2% above resistance
    volumeSpike // must have volume confirmation
  );
}

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
 * INTRADAY ENTRY PRICE CALCULATOR
 * Calculates optimal entry price based on technical analysis
 * ==================================================
 */
export function calculateSwingEntryPrice({
  price,
  marketCap,
  swingVWAP,
  support,
  resistance,
  rsi,
  candleColor,
  gapOpenPct,
  gapNowPct,
  volumeSpike,
  volatilityPct
}) {
  const currentPrice = Number(price)
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return {
      entryPrice: null,
      stopLoss: null,
      target1: null,
      target2: null,
      entryReason: 'Invalid price data',
      entryType: 'invalid',
      riskReward: '0.00',
      riskRewardAfterCosts: '0.00',
      riskRewardGross: '0.00',
      estimatedRoundTripCostPerShare: null,
      estimatedRoundTripCostPct: null
    }
  }

  const hasSwingVWAP = Number.isFinite(swingVWAP) && swingVWAP > 0
  const validSupport = Number.isFinite(support) && support > 0 ? support : null
  const validResistance = Number.isFinite(resistance) && resistance > 0 ? resistance : null
  const validMarketCap = Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null
  const normalizedRSI = Number.isFinite(rsi) ? rsi : 50
  const effectiveGap = Number.isFinite(gapNowPct)
    ? gapNowPct
    : (Number.isFinite(gapOpenPct) ? gapOpenPct : 0)
  const atrPct = clamp(
    Number.isFinite(volatilityPct) ? volatilityPct : 2.4,
    1.0,
    7.5
  )
  const atrMove = currentPrice * (atrPct / 100)

  let entryPrice = currentPrice
  let entryReason = 'Swing market entry - immediate position'
  let entryType = 'swing_market'

  const swingVWAPDistancePct =
    hasSwingVWAP ? ((currentPrice - swingVWAP) / swingVWAP) * 100 : null
  const supportDistancePct =
    validSupport && validSupport < currentPrice
      ? ((currentPrice - validSupport) / currentPrice) * 100
      : null

  if (
    hasSwingVWAP &&
    currentPrice > swingVWAP &&
    normalizedRSI >= 45 &&
    normalizedRSI <= 72
  ) {
    const nearSwingVWAPPct = clamp(atrPct * 0.9, 1.2, 3.8)
    if (
      Number.isFinite(swingVWAPDistancePct) &&
      swingVWAPDistancePct <= nearSwingVWAPPct
    ) {
      const entryBufferPct = clamp(atrPct * 0.18, 0.12, 0.45)
      entryPrice = Math.min(
        currentPrice,
        swingVWAP * (1 + entryBufferPct / 100)
      )
      entryReason = `Swing VWAP pullback - ${swingVWAPDistancePct.toFixed(1)}% above structure`
      entryType = 'swing_vwap'
    } else {
      entryPrice = currentPrice
      entryReason = `Swing continuation - ${swingVWAPDistancePct?.toFixed(1) ?? '0.0'}% above swing VWAP`
      entryType = 'swing_momentum'
    }
  } else if (
    validSupport &&
    validSupport < currentPrice &&
    Number.isFinite(supportDistancePct) &&
    supportDistancePct <= clamp(atrPct * 1.0, 1.2, 4.0) &&
    normalizedRSI >= 35 &&
    normalizedRSI <= 62
  ) {
    const entryBufferPct = clamp(atrPct * 0.1, 0.08, 0.3)
    entryPrice = Math.min(currentPrice, validSupport * (1 + entryBufferPct / 100))
    entryReason = `Support accumulation - ${supportDistancePct.toFixed(1)}% above support`
    entryType = 'swing_support'
  } else if (
    validResistance &&
    currentPrice >= validResistance * 0.997 &&
    normalizedRSI >= 50 &&
    normalizedRSI <= 72 &&
    (volumeSpike || candleColor === 'green')
  ) {
    const breakoutBufferPct = clamp(atrPct * 0.08, 0.05, 0.25)
    entryPrice = Math.min(currentPrice, validResistance * (1 + breakoutBufferPct / 100))
    entryReason = 'Swing breakout continuation - institutional momentum participation'
    entryType = 'swing_breakout'
  } else if (normalizedRSI >= 44 && normalizedRSI <= 64 && Math.abs(effectiveGap) <= 1.5) {
    entryPrice = currentPrice
    entryReason = 'Swing consolidation breakout - staggered build-up zone'
    entryType = 'swing_consolidation'
  } else if (normalizedRSI >= 48 && normalizedRSI <= 70 && candleColor === 'green') {
    entryPrice = currentPrice
    entryReason = 'Swing momentum alignment - trend follow setup'
    entryType = 'swing_momentum'
  }

  entryPrice = roundToPaise(Math.min(entryPrice, currentPrice))

  const minStopDistancePct = clamp(atrPct * 0.85, 1.2, 3.0)
  const maxStopDistancePct = clamp(atrPct * 1.9, 2.8, 7.5)

  const stopAtrMultipleByType = {
    swing_vwap: 1.1,
    swing_support: 1.0,
    swing_breakout: 1.35,
    swing_consolidation: 1.2,
    swing_momentum: 1.25,
    swing_market: 1.15
  }
  const stopAtrMultiple = stopAtrMultipleByType[entryType] ?? 1.15
  const atrStopPct = clamp(atrPct * stopAtrMultiple, minStopDistancePct, maxStopDistancePct)
  const atrStop = entryPrice * (1 - atrStopPct / 100)

  const structureStops = []
  if (
    hasSwingVWAP &&
    swingVWAP < entryPrice &&
    ((entryPrice - swingVWAP) / entryPrice) * 100 <= Math.max(atrPct * 1.6, 3.5)
  ) {
    structureStops.push(swingVWAP - atrMove * 0.3)
  }
  if (
    validSupport &&
    validSupport < entryPrice &&
    ((entryPrice - validSupport) / entryPrice) * 100 <= Math.max(atrPct * 1.8, 4.0)
  ) {
    structureStops.push(validSupport - atrMove * 0.35)
  }

  let stopLoss = structureStops.length ? Math.max(...structureStops) : atrStop
  const nearestAllowedStop = entryPrice * (1 - minStopDistancePct / 100)
  const farthestAllowedStop = entryPrice * (1 - maxStopDistancePct / 100)
  stopLoss = Math.min(stopLoss, nearestAllowedStop)
  stopLoss = Math.max(stopLoss, farthestAllowedStop)

  let riskPerShare = entryPrice - stopLoss
  const minRiskPct = clamp(atrPct * 0.55, 1.0, 2.8)
  const maxRiskPct = clamp(atrPct * 2.0, 2.5, 7.8)
  const minRiskPerShare = entryPrice * (minRiskPct / 100)
  const maxRiskPerShare = entryPrice * (maxRiskPct / 100)
  riskPerShare = clamp(riskPerShare, minRiskPerShare, maxRiskPerShare)
  stopLoss = entryPrice - riskPerShare

  let rr1Base = {
    swing_vwap: 2.0,
    swing_support: 2.4,
    swing_breakout: 2.1,
    swing_consolidation: 1.9,
    swing_momentum: 1.8,
    swing_market: 1.8
  }[entryType] ?? 1.8

  if (normalizedRSI >= 66) rr1Base -= 0.2
  else if (normalizedRSI <= 50) rr1Base += 0.2

  if (Math.abs(effectiveGap) > 1.5) rr1Base -= 0.1
  if (effectiveGap <= -2.5 && entryType === 'swing_market') rr1Base -= 0.25
  if (volumeSpike) rr1Base += 0.1

  const rr1 = clamp(rr1Base, 1.5, 3.2)
  const rr2 = clamp(rr1 + Math.max(rr1 * 0.9, 1.2), 2.8, 5.8)

  let target1 = entryPrice + riskPerShare * rr1
  let target1CappedByResistance = false
  if (validResistance && validResistance > entryPrice && entryType !== 'swing_breakout') {
    const resistanceBufferPct = clamp(atrPct * 0.12, 0.15, 0.55)
    const resistanceCap = validResistance * (1 - resistanceBufferPct / 100)
    target1 = Math.min(target1, resistanceCap)
    target1CappedByResistance = true
  } else if (validResistance && validResistance > entryPrice && entryType === 'swing_breakout') {
    const breakoutExtensionCap = validResistance + atrMove * 0.9
    target1 = Math.min(target1, breakoutExtensionCap)
    target1CappedByResistance = true
  }
  if (!target1CappedByResistance) {
    target1 = Math.max(target1, entryPrice + riskPerShare * 1.05)
  }

  let target2 = entryPrice + riskPerShare * rr2
  const minTarget2Step = Math.max(riskPerShare * 0.55, entryPrice * 0.006)
  target2 = Math.max(target2, target1 + minTarget2Step)
  if (validResistance && validResistance > entryPrice && target2 <= validResistance) {
    target2 = validResistance + atrMove * 1.2
  }

  // Keep runner target realistic by market-cap + volatility regime.
  const baseTarget2CapPct =
    validMarketCap != null
      ? (validMarketCap >= 1.5e12 ? 7.5
        : validMarketCap >= 5e11 ? 8.5
        : validMarketCap >= 2e11 ? 9.5
        : validMarketCap >= 8e10 ? 11.0
        : 12.5)
      : 10.5
  let target2CapPct = baseTarget2CapPct
  target2CapPct += clamp((atrPct - 3.0) * 0.7, -1.0, 2.0)
  if (entryType === 'swing_breakout') target2CapPct += 1.0
  if (entryType === 'swing_support') target2CapPct += 0.6
  if (entryType === 'swing_market') target2CapPct -= 0.6
  if (normalizedRSI >= 64) target2CapPct -= 0.7
  else if (normalizedRSI <= 48) target2CapPct += 0.4
  if (volumeSpike) target2CapPct += 0.3
  if (effectiveGap <= -1.5) target2CapPct -= 0.4
  target2CapPct = clamp(target2CapPct, 6.5, 15.0)

  const target2CapPrice = entryPrice * (1 + target2CapPct / 100)
  if (target2CapPrice > target1) {
    target2 = Math.min(target2, target2CapPrice)
  }

  // Universal realism rule: when T1 is resistance-capped (non-breakout),
  // keep T2 as a controlled post-resistance runner.
  if (target1CappedByResistance && validResistance && entryType !== 'swing_breakout') {
    let postResistanceAtrMult =
      validMarketCap != null
        ? (validMarketCap >= 1.5e12 ? 0.8
          : validMarketCap >= 5e11 ? 1.0
          : validMarketCap >= 2e11 ? 1.2
          : validMarketCap >= 8e10 ? 1.4
          : 1.6)
        : 1.2
    postResistanceAtrMult += clamp((atrPct - 3.0) * 0.08, -0.15, 0.25)
    if (volumeSpike) postResistanceAtrMult += 0.1
    if (normalizedRSI >= 62) postResistanceAtrMult -= 0.1
    postResistanceAtrMult = clamp(postResistanceAtrMult, 0.75, 1.8)

    const atrBasedRunnerCap = validResistance + atrMove * postResistanceAtrMult
    const pctBasedRunnerCap = validResistance * (1 + clamp(atrPct * 0.4, 0.6, 2.2) / 100)
    const tightRunnerCap = Math.min(atrBasedRunnerCap, pctBasedRunnerCap)

    if (tightRunnerCap > target1) {
      target2 = Math.min(target2, tightRunnerCap)
      let minRunnerStep = Math.max(entryPrice * 0.0025, riskPerShare * 0.2)
      if (target1 + minRunnerStep > tightRunnerCap) {
        minRunnerStep = Math.max(entryPrice * 0.0012, riskPerShare * 0.1)
      }
      target2 = Math.max(target2, target1 + minRunnerStep)
      target2 = Math.min(target2, tightRunnerCap)
    }
  }
  if (target2 <= target1) {
    target2 = target1 + Math.max(entryPrice * 0.0025, riskPerShare * 0.2)
  }

  if (entryType !== 'swing_breakout' && entryPrice === currentPrice) {
    entryReason += ' (Limit preferred, wait for pullback)'
  }

  stopLoss = roundToPaise(stopLoss)
  target1 = roundToPaise(target1)
  target2 = roundToPaise(target2)

  const rrStats = applyRoundTripCostModel({
    entryPrice,
    stopLoss,
    target1,
    costBps: DEFAULT_SWING_ROUND_TRIP_COST_BPS
  })
  const rrGross = rrStats?.riskRewardGross ?? calculateRiskReward(entryPrice, stopLoss, target1)
  const rrNet = rrStats?.riskRewardAfterCosts ?? rrGross
  
  return {
    entryPrice,
    stopLoss: Math.round(stopLoss * 100) / 100,
    target1: Math.round(target1 * 100) / 100,
    target2: Math.round(target2 * 100) / 100,
    entryReason,
    entryType,
    riskReward: formatRatio(rrNet),
    riskRewardAfterCosts: formatRatio(rrNet),
    riskRewardGross: formatRatio(rrGross),
    estimatedRoundTripCostPerShare: rrStats
      ? Math.round(rrStats.estimatedRoundTripCostPerShare * 100) / 100
      : null,
    estimatedRoundTripCostPct: rrStats?.estimatedRoundTripCostPct ?? null
  };
}

/**
 * ==================================================
 * INTRADAY ENTRY PRICE CALCULATOR
 * Calculates optimal entry price based on technical analysis
 * ==================================================
 */
export function calculateIntradayEntryPrice({
  price,
  vwap,
  support,
  resistance,
  rsi,
  candleColor,
  gapOpenPct,
  volumeSpike,
  volatilityPct
}) {
  const currentPrice = Number(price)
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return {
      entryPrice: null,
      stopLoss: null,
      target1: null,
      target2: null,
      entryReason: 'Invalid price data',
      entryType: 'invalid',
      riskReward: '0.00',
      riskRewardAfterCosts: '0.00',
      riskRewardGross: '0.00',
      estimatedRoundTripCostPerShare: null,
      estimatedRoundTripCostPct: null
    }
  }

  const hasVwap = Number.isFinite(vwap) && vwap > 0
  const validSupport = Number.isFinite(support) && support > 0 ? support : null
  const validResistance = Number.isFinite(resistance) && resistance > 0 ? resistance : null
  const normalizedRSI = Number.isFinite(rsi) ? rsi : 50
  const atrPct = clamp(
    Number.isFinite(volatilityPct) ? volatilityPct : 1.1,
    0.45,
    3.8
  )
  const atrMove = currentPrice * (atrPct / 100)

  let entryPrice = currentPrice
  let entryReason = 'Market level entry - immediate execution'
  let entryType = 'market_level'

  const vwapExtension = hasVwap ? (currentPrice - vwap) / vwap : 0
  const extensionLimit = clamp((atrPct * 1.8) / 100, 0.03, 0.055)
  if (vwapExtension > extensionLimit && !volumeSpike && normalizedRSI > 60) {
    return {
      entryPrice: roundToPaise(currentPrice),
      stopLoss: roundToPaise(currentPrice * 0.988),
      target1: roundToPaise(currentPrice * 1.01),
      target2: roundToPaise(currentPrice * 1.018),
      entryReason: 'Stretch Zone – Scalp Only (Overextended VWAP)',
      entryType: 'scalp_only',
      riskReward: '0.60',
      riskRewardAfterCosts: '0.60',
      riskRewardGross: '0.70',
      estimatedRoundTripCostPerShare: roundToPaise(currentPrice * (DEFAULT_INTRADAY_ROUND_TRIP_COST_BPS / 10000)),
      estimatedRoundTripCostPct: DEFAULT_INTRADAY_ROUND_TRIP_COST_BPS / 100
    }
  }
  const vwapDistancePct =
    hasVwap ? ((currentPrice - vwap) / vwap) * 100 : null
  const supportDistancePct =
    validSupport && validSupport < currentPrice
      ? ((currentPrice - validSupport) / currentPrice) * 100
      : null

  if (hasVwap && currentPrice > vwap && normalizedRSI >= 42 && normalizedRSI <= 80) {
    const nearVWAPPct = clamp(atrPct * 1.1, 0.45, 2.1)
    if (Number.isFinite(vwapDistancePct) && vwapDistancePct <= nearVWAPPct) {
      const entryBufferPct = clamp(atrPct * 0.12, 0.05, 0.18)
      entryPrice = Math.min(currentPrice, vwap * (1 + entryBufferPct / 100))
      entryReason = `VWAP pullback entry - ${vwapDistancePct.toFixed(1)}% above VWAP`
      entryType = 'vwap_pullback'
    } else {
      entryPrice = currentPrice
      entryReason = `Trend continuation - ${vwapDistancePct?.toFixed(1) ?? '0.0'}% above VWAP`
      entryType = 'trend_continuation'
    }
  } else if (
    validSupport &&
    validSupport < currentPrice &&
    Number.isFinite(supportDistancePct) &&
    supportDistancePct <= clamp(atrPct * 1.1, 0.8, 2.5) &&
    normalizedRSI >= 35 &&
    normalizedRSI <= 62
  ) {
    const entryBufferPct = clamp(atrPct * 0.09, 0.05, 0.16)
    entryPrice = Math.min(currentPrice, validSupport * (1 + entryBufferPct / 100))
    entryReason = `Support level entry - ${supportDistancePct.toFixed(1)}% above support`
    entryType = 'support_level'
  } else if (
    validResistance &&
    currentPrice >= validResistance * 0.998 &&
    normalizedRSI >= 48 &&
    normalizedRSI <= 72 &&
    (volumeSpike || candleColor === 'green')
  ) {
    const breakoutBufferPct = clamp(atrPct * 0.08, 0.04, 0.14)
    entryPrice = Math.min(currentPrice, validResistance * (1 + breakoutBufferPct / 100))
    entryReason = 'Resistance breakout - institutional momentum confirmation'
    entryType = 'resistance_breakout'
  } else if ((gapOpenPct ?? 0) > 0.8 && (gapOpenPct ?? 0) < 4.5 && candleColor === 'green') {
    entryPrice = currentPrice
    entryReason = `ORB continuation - ${(gapOpenPct ?? 0).toFixed(1)}% opening gap`
    entryType = 'orb_breakout'
  } else if (normalizedRSI >= 45 && normalizedRSI <= 65 && Math.abs(gapOpenPct ?? 0) <= 0.6) {
    entryPrice = currentPrice
    entryReason = `Consolidation breakout - RSI ${normalizedRSI.toFixed(1)} zone`
    entryType = 'consolidation_level'
  } else if (normalizedRSI >= 50 && normalizedRSI <= 70) {
    entryPrice = currentPrice
    entryReason = `Volume confirmed momentum - RSI ${normalizedRSI.toFixed(1)}`
    entryType = 'volume_confirmed_level'
  }

  const pullbackPreferredEntryTypes = new Set([
    'vwap_pullback',
    'trend_continuation',
    'support_level',
    'consolidation_level',
    'volume_confirmed_level',
    'market_level'
  ])
  if (pullbackPreferredEntryTypes.has(entryType)) {
    const minPullbackPct = clamp(atrPct * 0.16, 0.08, 0.22)
    const maxPullbackPct = clamp(atrPct * 0.55, 0.2, 0.75)
    const anchorBufferPct = clamp(atrPct * 0.08, 0.04, 0.16)
    const vwapAnchor =
      hasVwap && vwap < currentPrice ? vwap * (1 + anchorBufferPct / 100) : null

    let preferredEntry = currentPrice * (1 - minPullbackPct / 100)
    if (Number.isFinite(vwapAnchor)) {
      preferredEntry = Math.max(preferredEntry, vwapAnchor)
    }
    preferredEntry = Math.max(preferredEntry, currentPrice * (1 - maxPullbackPct / 100))

    const minTickBelow = Math.max(currentPrice * 0.0002, 0.05)
    preferredEntry = Math.min(preferredEntry, currentPrice - minTickBelow)

    if (Number.isFinite(preferredEntry) && preferredEntry > 0) {
      entryPrice = preferredEntry
      if (!entryReason.includes('Limit preferred')) {
        entryReason = `${entryReason} (Limit preferred, wait for pullback)`
      }
    }
  }

  entryPrice = roundToPaise(Math.min(entryPrice, currentPrice))

  const minStopDistancePct = clamp(atrPct * 0.65, 0.45, 1.2)
  const maxStopDistancePct = clamp(atrPct * 1.7, 1.0, 2.8)

  const stopAtrMultipleByType = {
    vwap_pullback: 0.85,
    trend_continuation: 1.05,
    support_level: 1.0,
    resistance_breakout: 1.15,
    orb_breakout: 1.2,
    consolidation_level: 0.95,
    volume_confirmed_level: 1.0,
    market_level: 1.0
  }
  const stopAtrMultiple = stopAtrMultipleByType[entryType] ?? 1.0
  const atrStopPct = clamp(atrPct * stopAtrMultiple, minStopDistancePct, maxStopDistancePct)
  const atrStop = entryPrice * (1 - atrStopPct / 100)

  const structureStops = []
  if (
    hasVwap &&
    vwap < entryPrice &&
    ((entryPrice - vwap) / entryPrice) * 100 <= Math.max(atrPct * 2.2, 1.6)
  ) {
    structureStops.push(vwap - atrMove * 0.25)
  }
  if (
    validSupport &&
    validSupport < entryPrice &&
    ((entryPrice - validSupport) / entryPrice) * 100 <= Math.max(atrPct * 2.6, 2.0)
  ) {
    structureStops.push(validSupport - atrMove * 0.2)
  }

  let stopLoss = structureStops.length ? Math.max(...structureStops) : atrStop
  const nearestAllowedStop = entryPrice * (1 - minStopDistancePct / 100)
  const farthestAllowedStop = entryPrice * (1 - maxStopDistancePct / 100)
  stopLoss = Math.min(stopLoss, nearestAllowedStop)
  stopLoss = Math.max(stopLoss, farthestAllowedStop)

  let riskPerShare = entryPrice - stopLoss
  const minRiskPct = clamp(atrPct * 0.6, 0.35, 1.1)
  const maxRiskPct = clamp(atrPct * 1.9, 1.2, 3.0)
  const minRiskPerShare = entryPrice * (minRiskPct / 100)
  const maxRiskPerShare = entryPrice * (maxRiskPct / 100)
  riskPerShare = clamp(riskPerShare, minRiskPerShare, maxRiskPerShare)
  stopLoss = entryPrice - riskPerShare

  let rr1Base = {
    vwap_pullback: 1.6,
    trend_continuation: 1.35,
    support_level: 1.8,
    resistance_breakout: 1.5,
    orb_breakout: 1.4,
    consolidation_level: 1.45,
    volume_confirmed_level: 1.4,
    market_level: 1.35
  }[entryType] ?? 1.35

  if (normalizedRSI >= 63) rr1Base -= 0.15
  else if (normalizedRSI <= 48) rr1Base += 0.12

  if (atrPct >= 2.0) rr1Base -= 0.08
  else if (atrPct <= 0.8) rr1Base += 0.08

  if (volumeSpike) rr1Base += 0.05

  const rr1 = clamp(rr1Base, 1.2, 2.1)
  const rr2 = clamp(rr1 + Math.max(rr1 * 0.75, 0.8), 2.0, 3.6)

  let target1 = entryPrice + riskPerShare * rr1
  let target1CappedByResistance = false
  if (validResistance && validResistance > entryPrice) {
    const resistanceBufferPct = clamp(atrPct * 0.15, 0.08, 0.35)
    const resistanceCap = validResistance * (1 - resistanceBufferPct / 100)
    if (resistanceCap > entryPrice + riskPerShare * 0.9) {
      const previousTarget1 = target1
      target1 = Math.min(target1, resistanceCap)
      if (target1 < previousTarget1) target1CappedByResistance = true
    }
  }

  let target2 = entryPrice + riskPerShare * rr2
  const minTarget2Step = Math.max(riskPerShare * 0.6, entryPrice * 0.004)
  target2 = Math.max(target2, target1 + minTarget2Step)
  if (validResistance && validResistance > entryPrice && target2 <= validResistance) {
    target2 = validResistance + atrMove * 0.8
  }

  // Universal realism rule for intraday runners:
  // if T1 is resistance-capped (and setup is not a breakout), keep T2 tightly controlled.
  if (
    target1CappedByResistance &&
    validResistance &&
    entryType !== 'resistance_breakout' &&
    entryType !== 'orb_breakout'
  ) {
    let postResistanceAtrMult = {
      vwap_pullback: 0.5,
      trend_continuation: 0.55,
      support_level: 0.65,
      consolidation_level: 0.45,
      volume_confirmed_level: 0.5,
      market_level: 0.45
    }[entryType] ?? 0.5

    postResistanceAtrMult += clamp((atrPct - 1.2) * 0.08, -0.08, 0.2)
    if (volumeSpike) postResistanceAtrMult += 0.05
    if (normalizedRSI >= 62) postResistanceAtrMult -= 0.05
    postResistanceAtrMult = clamp(postResistanceAtrMult, 0.35, 0.9)

    const atrBasedRunnerCap = validResistance + atrMove * postResistanceAtrMult
    const pctBasedRunnerCap = validResistance * (1 + clamp(atrPct * 0.25, 0.25, 0.9) / 100)
    const tightRunnerCap = Math.min(atrBasedRunnerCap, pctBasedRunnerCap)

    if (tightRunnerCap > target1) {
      target2 = Math.min(target2, tightRunnerCap)

      let minRunnerStep = Math.max(entryPrice * 0.001, riskPerShare * 0.15)
      if (target1 + minRunnerStep > tightRunnerCap) {
        minRunnerStep = Math.max(entryPrice * 0.0005, riskPerShare * 0.08)
      }
      target2 = Math.max(target2, target1 + minRunnerStep)
      target2 = Math.min(target2, tightRunnerCap)
    }
  }
  if (target2 <= target1) {
    target2 = target1 + Math.max(entryPrice * 0.0005, riskPerShare * 0.08)
  }

  stopLoss = roundToPaise(stopLoss)
  target1 = roundToPaise(target1)
  target2 = roundToPaise(target2)

  const rrStats = applyRoundTripCostModel({
    entryPrice,
    stopLoss,
    target1,
    costBps: DEFAULT_INTRADAY_ROUND_TRIP_COST_BPS
  })
  const rrGross = rrStats?.riskRewardGross ?? calculateRiskReward(entryPrice, stopLoss, target1)
  const rrNet = rrStats?.riskRewardAfterCosts ?? rrGross
  
  // 🛡️ INSTITUTIONAL GUARD: Check RR before returning
  if ((rrNet ?? 0) < 1) {
    return {
      entryPrice,
      stopLoss: Math.round(stopLoss * 100) / 100,
      target1: Math.round(target1 * 100) / 100,
      target2: Math.round(target2 * 100) / 100,
      entryReason: entryReason + ' (RR weak – wait for better location)',
      entryType: 'rr_weak',
      riskReward: formatRatio(rrNet),
      riskRewardAfterCosts: formatRatio(rrNet),
      riskRewardGross: formatRatio(rrGross),
      estimatedRoundTripCostPerShare: rrStats
        ? Math.round(rrStats.estimatedRoundTripCostPerShare * 100) / 100
        : null,
      estimatedRoundTripCostPct: rrStats?.estimatedRoundTripCostPct ?? null
    }
  }
  
  return {
    entryPrice,
    stopLoss: Math.round(stopLoss * 100) / 100,
    target1: Math.round(target1 * 100) / 100,
    target2: Math.round(target2 * 100) / 100,
    entryReason,
    entryType,
    riskReward: formatRatio(rrNet),
    riskRewardAfterCosts: formatRatio(rrNet),
    riskRewardGross: formatRatio(rrGross),
    estimatedRoundTripCostPerShare: rrStats
      ? Math.round(rrStats.estimatedRoundTripCostPerShare * 100) / 100
      : null,
    estimatedRoundTripCostPct: rrStats?.estimatedRoundTripCostPct ?? null
  };
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
  const hasVwap = Number.isFinite(vwap) && vwap > 0;
  
  const aboveVWAP = hasVwap && price > vwap
  const belowVWAP = hasVwap && price < vwap
  const breakoutConfirmed = getBreakoutConfirmation(resistance, price, volumeSpike)
  const nearSupport = support && price <= support * 1.02
  const effectiveGap = (gapNowPct ?? gapOpenPct ?? 0)
  const volumeOK = volumeSpike || (aboveVWAP && rsi > 50)

  // Protect against CHOP days - filter sideways markets
  if (
    Math.abs(effectiveGap) < 0.2 &&
    !volumeSpike &&
    hasVwap &&
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
    rsi >= 40 &&
    rsi <= 65 &&
    effectiveGap >= 0.2 &&
    effectiveGap < 3.5 &&
    volumeOK &&
    aboveVWAP &&
    !breakoutConfirmed
  ) {
    reasons.push(effectiveGap > 0.5 ? 'Gap up with momentum' : 'Positive price action')
    reasons.push('Price above VWAP shows bullish structure')
    reasons.push('RSI in optimal intraday zone')
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
    rsi >= 45 &&
    rsi <= 65 &&
    aboveVWAP &&
    effectiveGap >= -0.2
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
     2️⃣ STRETCH ZONE (VOLUME ONLY)
  ========================== */
  if (
    rsi > 65 &&
    rsi <= 70 &&
    volumeSpike &&
    aboveVWAP
  ) {
    reasons.push('Momentum in stretch zone - volume required')
    reasons.push('Trading above VWAP with volume confirmation')
    reasons.push('Suitable for scalp/quick trades only')

    return {
      label: 'Stretch Zone - Scalp Only',
      sentiment: 'positive',
      reasons
    }
  }

  /* =========================
     3️⃣ BREAKOUT PLAY
  ========================== */
  if (
    breakoutConfirmed &&
    rsi >= 50 &&
    rsi <= 70
  ) {
    reasons.push('Institutional-grade breakout confirmed')
    reasons.push('Volume confirms resistance break')
    reasons.push(candleColor === 'green' ? 'Bullish momentum toward resistance' : 'Consolidating before breakout')

    return {
      label: 'Breakout Candidate',
      sentiment: 'positive',
      reasons
    }
  }

  /* =========================
     4️⃣ MODERATE MOMENTUM (NEUTRAL-POSITIVE)
  ========================== */
  if (
    rsi >= 45 &&
    rsi <= 70 &&
    aboveVWAP &&
    effectiveGap >= -0.3
  ) {
    reasons.push('Moderate momentum with VWAP support')
    reasons.push(volumeSpike ? 'Volume confirms interest' : 'Awaiting volume confirmation')
    reasons.push(candleColor === 'green' ? 'Bullish bias' : 'Consolidating with upside potential')

    return {
      label: 'Moderate Momentum - Watch',
      sentiment: 'positive',
      reasons
    }
  }

  /* =========================
     5️⃣ CONSOLIDATION BREAKOUT POTENTIAL
  ========================== */
  if (
    rsi >= 40 &&
    rsi <= 60 &&
    Math.abs(effectiveGap) <= 0.5 &&
    !breakoutConfirmed &&
    !nearSupport
  ) {
    reasons.push('Consolidation phase - watch for breakout')
    reasons.push(volumeSpike ? 'Volume suggests impending move' : 'Low volatility - add to watchlist')
    reasons.push(aboveVWAP ? 'Above VWAP provides support' : 'Below VWAP - needs confirmation')

    return {
      label: 'Consolidation Watch',
      sentiment: 'positive',
      reasons
    }
  }

  /* =========================
     6️⃣ AVOID - OVERBOUGHT/DISTRIBUTION
  ========================== */
  if (rsi > 70) {
    reasons.push('RSI in distribution zone (>70) - institutions selling')
    reasons.push('High risk of reversal or profit booking')
    reasons.push('Unfavorable risk-reward for fresh entries')
    reasons.push('Avoid fresh entries - scalp only if experienced')

    return {
      label: 'Overbought - Avoid Fresh Entry',
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
