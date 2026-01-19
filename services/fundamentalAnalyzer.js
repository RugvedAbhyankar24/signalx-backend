export function evaluateFundamentals({
  marketCap,
  revenueGrowth,
  profitGrowth,
  debtToEquity,
  roe,
  analystSentiment,
  marketPosition
}) {
  let score = 0
  let reasons = []

  // 1️⃣ Earnings Quality & Growth Trend
  if (revenueGrowth !== null && profitGrowth !== null) {
    if (revenueGrowth > 15 && profitGrowth > 20) {
      score += 3
      reasons.push('Exceptional earnings growth with strong profitability')
    } else if (revenueGrowth > 10 && profitGrowth > 10) {
      score += 2
      reasons.push('Consistent double-digit earnings growth')
    } else if (revenueGrowth > 5 && profitGrowth > 5) {
      score += 1
      reasons.push('Moderate earnings growth trajectory')
    } else if (revenueGrowth < 0 || profitGrowth < 0) {
      score -= 1
      reasons.push('Declining earnings trend concerns')
    }
  }

  // 2️⃣ Financial Health & Balance Sheet Strength
  if (debtToEquity !== null) {
    if (debtToEquity < 0.3) {
      score += 2
      reasons.push('Conservative debt structure with strong balance sheet')
    } else if (debtToEquity < 0.6) {
      score += 1
      reasons.push('Manageable debt levels')
    } else if (debtToEquity > 1.5) {
      score -= 2
      reasons.push('High leverage raises financial risk concerns')
    }
  }

  // 3️⃣ Return Efficiency & Profitability
  if (roe !== null) {
    if (roe > 25) {
      score += 2
      reasons.push('Exceptional return on equity generation')
    } else if (roe > 18) {
      score += 1
      reasons.push('Strong shareholder returns')
    } else if (roe < 8) {
      score -= 1
      reasons.push('Below-average return on equity')
    }
  }

  // 4️⃣ Market Position & Competitive Advantage
  if (marketPosition === 'leader') {
    score += 3
    reasons.push('Dominant market leader with competitive moat')
  } else if (marketPosition === 'challenger') {
    score += 2
    reasons.push('Strong market position with growth potential')
  } else if (marketPosition === 'emerging') {
    score += 1
    reasons.push('Emerging player with market opportunity')
    if (marketCap > 1e11) {
      score -= 1
      reasons.push('Scale present but competitive advantage still unproven')
    }
  }

  // 5️⃣ Analyst & Market Sentiment Alignment
  if (analystSentiment === 'positive') {
    score += 1
    reasons.push('Positive analyst consensus and brokerage coverage')
  } else if (analystSentiment === 'negative') {
    score -= 1
    reasons.push('Cautious analyst outlook presents headwinds')
  }

  // 6️⃣ Size & Scale Advantage (Market Cap Based)
  if (marketCap > 1e12) {
    score += 1
    reasons.push('Large-cap stability with institutional backing')
  } else if (marketCap < 5e10) {
    score -= 1
    reasons.push('Small-cap volatility and liquidity risks')
  }
  score = Math.min(score, 8)
  return { score, reasons }
}
