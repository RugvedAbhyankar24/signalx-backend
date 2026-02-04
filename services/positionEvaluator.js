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
  const nearResistance = resistance && price >= resistance * 0.98 && rsi > 55 // Improved filter - avoid early breakout calls
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
 * INTRADAY ENTRY PRICE CALCULATOR
 * Calculates optimal entry price based on technical analysis
 * ==================================================
 */
export function calculateSwingEntryPrice({
  price,
  vwap,
  support,
  resistance,
  rsi,
  candleColor,
  gapOpenPct,
  volumeSpike
}) {
  let entryPrice = price;
  let entryReason = '';
  let entryType = 'current';
  
  // Calculate nearest valid levels BELOW price for swing (institutional safety fix)
  const buffer = 0.002; // 0.2% buffer for swing execution
  const nearestBelowPrice = Math.max(
    vwap && vwap < price ? vwap : 0, // Only VWAP if below current price
    support && support < price ? support : 0 // Only support if below current price
  ); // CRITICAL: Never enter above structure unintentionally
  
  // Strategy 1: SWING VWAP LEVEL - Enter at VWAP with buffer (swing favorite)
  if (price > vwap && rsi >= 50 && rsi <= 75 && volumeSpike) {
    entryPrice = vwap + (vwap * buffer); // VWAP level + small buffer
    entryReason = 'Swing VWAP level - institutional trend following';
    entryType = 'swing_vwap';
  }
  
  // Strategy 2: SWING SUPPORT LEVEL - Enter at support with buffer (AMC accumulation)
  else if (support && price <= support * 1.03 && rsi >= 35 && rsi <= 60) {
    entryPrice = support + (support * buffer); // Support level + buffer
    entryReason = 'Swing support level - AMC accumulation zone';
    entryType = 'swing_support';
  }
  
  // Strategy 3: SWING BREAKOUT - Enter at resistance breakout with buffer
  else if (resistance && price >= resistance * 0.98 && volumeSpike && rsi >= 55) {
    entryPrice = resistance + (resistance * buffer); // Resistance breakout + buffer
    entryReason = 'Swing breakout - institutional momentum entry';
    entryType = 'swing_breakout';
  }
  
  // Strategy 4: SWING CONSOLIDATION - Enter after consolidation break
  else if (rsi >= 45 && rsi <= 65 && Math.abs(gapOpenPct) <= 1.0) {
    entryPrice = price + (price * buffer); // Current level + buffer
    entryReason = 'Swing consolidation breakout - position building';
    entryType = 'swing_consolidation';
  }
  
  // Strategy 5: SWING MOMENTUM - Enter on momentum with volume confirmation
  else if (volumeSpike && rsi >= 50 && rsi <= 70 && candleColor === 'green') {
    entryPrice = Math.max(nearestBelowPrice, price * 0.998) + buffer; // Best level + buffer
    entryReason = 'Swing momentum - volume confirmed position';
    entryType = 'swing_momentum';
  }
  
  // Strategy 6: SWING MARKET - Enter at current market level
  else {
    entryPrice = price; // Market level entry
    entryReason = 'Swing market entry - immediate position';
    entryType = 'swing_market';
  }
  
  // Round to 2 decimal places for Indian stocks
  entryPrice = Math.round(entryPrice * 100) / 100;
  
  // Calculate SWING-SPECIFIC stop loss (wider than intraday)
  let stopLoss;
  
  // Check if structural levels are within reasonable distance for swing
  const vwapDistance = vwap ? Math.abs(entryPrice - vwap) / entryPrice : 1;
  const supportDistance = support ? Math.abs(entryPrice - support) / entryPrice : 1;
  
  // Use structure only if within 3% of entry for swing (wider than intraday)
  if (vwapDistance <= 0.03 && vwap) {
    // VWAP is close - use VWAP-based stop
    stopLoss = Math.min(vwap * 0.99, entryPrice * 0.97); // 1% below VWAP, 3% max
  } else if (supportDistance <= 0.03 && support) {
    // Support is close - use support-based stop
    stopLoss = Math.min(support * 1.01, entryPrice * 0.97); // 1% below support, 3% max
  } else {
    // Structure too far - use swing percentage-based stop
    stopLoss = entryPrice * 0.97; // 3% swing stop (wider than intraday)
  }
  
  // Calculate SWING-SPECIFIC targets (larger than intraday)
  let targetPercent;
  
  switch (entryType) {
    case 'swing_vwap':
      targetPercent = 8.0; // 8% target from VWAP
      break;
    case 'swing_support':
      targetPercent = 12.0; // 12% target from support
      break;
    case 'swing_breakout':
      targetPercent = 15.0; // 15% target for breakout
      break;
    case 'swing_consolidation':
      targetPercent = 10.0; // 10% target for consolidation
      break;
    case 'swing_momentum':
      targetPercent = 7.0; // 7% target for momentum
      break;
    default:
      targetPercent = 6.0; // 6% default swing target
  }
  
  // DYNAMIC RSI-BASED TARGET SCALING (institutional approach)
  if (rsi > 65) {
    targetPercent *= 0.7; // Reduce targets by 30% when RSI > 65 (AMC logic)
  } else if (rsi > 60) {
    targetPercent *= 0.85; // Reduce targets by 15% when RSI > 60
  }
  
  // Ensure minimum reasonable targets
  targetPercent = Math.max(targetPercent, 4.0); // Minimum 4% target
  
  // Calculate percentage-based targets first
  const calculatedTarget1 = entryPrice * (1 + targetPercent / 100);
  const calculatedTarget2 = entryPrice * (1 + (targetPercent * 1.5) / 100); // 1.5x for swing
  
  // Apply institutional liquidity filters for swing
  let target1, target2;
  
  // Target 1: Respect nearby resistance (liquidity barrier)
  if (resistance && resistance > entryPrice) {
    target1 = Math.min(calculatedTarget1, resistance * 0.99); // Just below resistance
  } else {
    target1 = calculatedTarget1; // Use calculated target if no resistance
  }
  
  // Target 2: Respect weekly range and reasonable extension
  const weeklyHigh = Math.max(price, entryPrice * 1.15); // Approximate weekly high
  target2 = Math.min(calculatedTarget2, weeklyHigh * 0.98); // Just below weekly high
  
  // Ensure target2 > target1
  if (target2 <= target1) {
    target2 = target1 * 1.05; // Minimum 5% above target1 for swing
  }
  
  return {
    entryPrice,
    stopLoss: Math.round(stopLoss * 100) / 100,
    target1: Math.round(target1 * 100) / 100,
    target2: Math.round(target2 * 100) / 100,
    entryReason,
    entryType,
    riskReward: ((target1 - entryPrice) / (entryPrice - stopLoss)).toFixed(2)
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
  volumeSpike
}) {
  let entryPrice = price;
  let entryReason = '';
  let entryType = 'current';
  
  // Calculate nearest valid levels BELOW price (institutional safety fix)
  const buffer = 0.001; // 0.1% buffer for execution
  const nearestBelowPrice = Math.max(
    vwap && vwap < price ? vwap : 0, // Only VWAP if below current price
    support && support < price ? support : 0 // Only support if below current price
  ); // CRITICAL: Never enter above structure unintentionally
  
  // Strategy 1: DUAL-MODE VWAP - Pullback vs Trend Continuation (institutional fix)
  if (price > vwap && rsi >= 45 && rsi <= 80 && volumeSpike) {
    if (price <= vwap * 1.003) {
      // Price is near VWAP - enter at VWAP pullback
      entryPrice = vwap + (vwap * buffer); // VWAP level + small buffer
      entryReason = 'VWAP pullback entry - institutional retest';
      entryType = 'vwap_pullback';
    } else {
      // Price is far from VWAP - trend continuation entry
      entryPrice = price; // Enter at current price (trend continuation)
      entryReason = 'Trend continuation entry - momentum play';
      entryType = 'trend_continuation';
    }
  }
  
  // Strategy 2: SUPPORT LEVEL - Enter at support with buffer (AMC style)
  else if (support && price <= support * 1.02 && rsi >= 35 && rsi <= 60) {
    entryPrice = support + (support * buffer); // Support level + small buffer
    entryReason = 'Support level entry - AMC accumulation zone';
    entryType = 'support_level';
  }
  
  // Strategy 3: RESISTANCE BREAKOUT - Enter at breakout level with buffer
  else if (resistance && price >= resistance * 0.995 && volumeSpike) {
    entryPrice = resistance + (resistance * buffer); // Resistance level + buffer
    entryReason = 'Resistance breakout - institutional entry';
    entryType = 'resistance_breakout';
  }
  
  // Strategy 4: OPENING RANGE BREAKOUT - Enter at ORB high with buffer
  else if (gapOpenPct > 1.0 && gapOpenPct < 5.0 && candleColor === 'green') {
    const orbHigh = price * 1.01; // Approximate ORB high
    entryPrice = orbHigh + (orbHigh * buffer); // ORB level + buffer
    entryReason = 'Opening range breakout - gap momentum';
    entryType = 'orb_breakout';
  }
  
  // Strategy 5: CONSOLIDATION LEVEL - Enter at consolidation breakout
  else if (rsi >= 45 && rsi <= 65 && Math.abs(gapOpenPct) <= 0.5) {
    entryPrice = price + (price * buffer); // Current level + buffer
    entryReason = 'Consolidation breakout - level entry';
    entryType = 'consolidation_level';
  }
  
  // Strategy 6: VOLUME CONFIRMED LEVEL - Enter at volume-confirmed level
  else if (volumeSpike && rsi >= 50 && rsi <= 70) {
    entryPrice = Math.max(nearestBelowPrice, price * 0.999) + buffer; // Best level + buffer
    entryReason = 'Volume confirmed level - institutional entry';
    entryType = 'volume_confirmed_level';
  }
  
  // Strategy 7: MARKET LEVEL - Enter at current market level
  else {
    entryPrice = price; // Market level entry
    entryReason = 'Market level entry - immediate execution';
    entryType = 'market_level';
  }
  
  // Round to 2 decimal places for Indian stocks
  entryPrice = Math.round(entryPrice * 100) / 100;
  
  // Calculate HYBRID stop loss (structure when close, percentage when far)
  let stopLoss;
  
  // Check if structural levels are within reasonable distance
  const vwapDistance = vwap ? Math.abs(entryPrice - vwap) / entryPrice : 1;
  const supportDistance = support ? Math.abs(entryPrice - support) / entryPrice : 1;
  
  // Use structure only if within 2% of entry, otherwise use percentage
  if (vwapDistance <= 0.02 && vwap) {
    // VWAP is close - use VWAP-based stop
    stopLoss = Math.min(vwap * 0.995, entryPrice * 0.98);
  } else if (supportDistance <= 0.02 && support) {
    // Support is close - use support-based stop
    stopLoss = Math.min(support * 1.005, entryPrice * 0.98);
  } else {
    // Structure too far - use percentage-based stop
    stopLoss = entryPrice * 0.98; // 2% stop
  }
  
  // Calculate LIQUIDITY-AWARE targets (institutional approach)
  let targetPercent;
  let stopLossPercent;
  
  switch (entryType) {
    case 'vwap_pullback':
      stopLossPercent = 1.5; // Standard stop for VWAP pullback
      targetPercent = 4.0; // Standard target from VWAP
      break;
    case 'trend_continuation':
      stopLossPercent = 2.0; // Wider stop for momentum play
      targetPercent = 3.0; // Conservative target for trend continuation
      break;
    case 'support_level':
      stopLossPercent = 2.0; // Wider stop for support
      targetPercent = 5.0; // High target from support
      break;
    case 'resistance_breakout':
      stopLossPercent = 1.2; // Tight stop for breakout
      targetPercent = 5.5; // High target for breakout
      break;
    case 'orb_breakout':
      stopLossPercent = 1.0; // Very tight stop for ORB
      targetPercent = 4.5; // Good target for ORB
      break;
    case 'consolidation_level':
      stopLossPercent = 1.3; // Tight stop for breakout
      targetPercent = 5.0; // High target for breakout
      break;
    case 'volume_confirmed_level':
      stopLossPercent = 1.6; // Standard stop for volume
      targetPercent = 3.5; // Conservative target
      break;
    default:
      stopLossPercent = 1.5;
      targetPercent = 3.0;
  }
  
  // Calculate LIQUIDITY-FIRST targets (institutional approach)
  let target1, target2;
  
  // LIQUIDITY HARD CAPS - Institutions respect these first
  const nearestResistance = resistance && resistance > entryPrice ? resistance * 0.995 : null;
  const dayHighLiquidity = Math.max(price, entryPrice * 1.05) * 0.99; // Day high liquidity
  const orbHighLiquidity = entryPrice * 1.02 * 0.99; // ORB high liquidity (2% above entry)
  const vwapBandLiquidity = vwap ? vwap * 1.03 * 0.99 : null; // VWAP band liquidity
  
  // TARGET 1: Nearest liquidity pool (hard cap)
  const liquidityPools = [nearestResistance, orbHighLiquidity, vwapBandLiquidity].filter(Boolean);
  const nearestLiquidity = liquidityPools.length > 0 ? Math.min(...liquidityPools) : null;
  
  if (nearestLiquidity && nearestLiquidity > entryPrice) {
    // Liquidity exists - cap at liquidity, ignore percentage
    target1 = nearestLiquidity;
  } else {
    // No nearby liquidity - use conservative percentage
    target1 = entryPrice * (1 + Math.min(targetPercent, 3) / 100); // Max 3% if no liquidity
  }
  
  // TARGET 2: Next liquidity pool or range extension
  const nextLiquidityPools = [dayHighLiquidity, nearestResistance, orbHighLiquidity].filter(Boolean);
  const nextLiquidity = nextLiquidityPools.length > 0 ? Math.min(...nextLiquidityPools) : null;
  
  if (nextLiquidity && nextLiquidity > target1) {
    // Next liquidity exists - cap at next liquidity
    target2 = nextLiquidity;
  } else {
    // No next liquidity - conservative range extension
    target2 = target1 * 1.02; // Minimum 2% above target1
  }
  
  // Ensure realistic targets (market-clean, not math-clean)
  if (target2 <= target1) {
    target2 = target1 * 1.015; // Minimum 1.5% above target1
  }
  
  return {
    entryPrice,
    stopLoss: Math.round(stopLoss * 100) / 100,
    target1: Math.round(target1 * 100) / 100,
    target2: Math.round(target2 * 100) / 100,
    entryReason,
    entryType,
    riskReward: ((target1 - entryPrice) / (entryPrice - stopLoss)).toFixed(2)
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
    rsi >= 40 &&
    rsi <= 75 &&
    effectiveGap >= 0.2 &&
    effectiveGap < 3.5 &&
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
    rsi >= 45 &&
    rsi <= 70 &&
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
    !nearResistance &&
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
     6️⃣ AVOID - OVERBOUGHT
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

