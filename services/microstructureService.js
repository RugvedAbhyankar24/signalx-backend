import { fetchNSE } from './marketData.js';

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function baseIndianSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/\.(NS|BO)$/i, '');
}

function sumDepthQty(levels) {
  if (!Array.isArray(levels)) return null;
  let total = 0;
  let count = 0;
  for (const level of levels) {
    const qty = toNumber(level?.quantity ?? level?.qty);
    if (qty != null) {
      total += qty;
      count += 1;
    }
  }
  return count ? total : null;
}

function firstLevelPrice(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  return toNumber(levels[0]?.price);
}

export function classifyMicrostructureSignal(data = {}) {
  const spreadBps = toNumber(data.spreadBps);
  const imbalance = toNumber(data.imbalanceRatio);
  const buySellPressureRatio = toNumber(data.buySellPressureRatio);

  if (spreadBps == null && imbalance == null && buySellPressureRatio == null) {
    return {
      status: 'unavailable',
      bias: 'unknown',
      score: 0,
      reasons: ['Live order-book depth unavailable']
    };
  }

  const reasons = [];
  let score = 0;
  let bias = 'neutral';

  if (spreadBps != null) {
    if (spreadBps <= 8) {
      score += 2;
      reasons.push(`Tight spread (${spreadBps.toFixed(1)} bps)`);
    } else if (spreadBps >= 25) {
      score -= 2;
      reasons.push(`Wide spread (${spreadBps.toFixed(1)} bps)`);
    }
  }

  if (imbalance != null) {
    if (imbalance >= 0.18) {
      score += 3;
      bias = 'bullish';
      reasons.push(`Bid-side depth imbalance ${imbalance.toFixed(2)}`);
    } else if (imbalance <= -0.18) {
      score -= 3;
      bias = 'bearish';
      reasons.push(`Ask-side depth imbalance ${imbalance.toFixed(2)}`);
    }
  }

  if (buySellPressureRatio != null) {
    if (buySellPressureRatio >= 1.25) {
      score += 2;
      if (bias === 'neutral') bias = 'bullish';
      reasons.push(`Buy pressure ${buySellPressureRatio.toFixed(2)}x sell pressure`);
    } else if (buySellPressureRatio <= 0.8) {
      score -= 2;
      if (bias === 'neutral') bias = 'bearish';
      reasons.push(`Sell pressure ${(1 / Math.max(buySellPressureRatio, 0.01)).toFixed(2)}x buy pressure`);
    }
  }

  let status = 'neutral';
  if (score >= 4) status = 'favorable';
  else if (score <= -3) status = 'adverse';

  if (!reasons.length) reasons.push('Order-book mixed with no strong imbalance');

  return { status, bias, score, reasons };
}

export async function fetchMicrostructureSnapshot(symbol) {
  const base = baseIndianSymbol(symbol);

  try {
    const data = await fetchNSE(`/quote-equity?symbol=${encodeURIComponent(base)}`);
    const book = data?.marketDeptOrderBook || {};
    const tradeInfo = book?.tradeInfo || {};
    const bid = Array.isArray(book?.bid) ? book.bid : [];
    const ask = Array.isArray(book?.ask) ? book.ask : [];

    const bestBid = firstLevelPrice(bid);
    const bestAsk = firstLevelPrice(ask);
    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
    const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
    const spreadBps = spread != null && mid ? (spread / mid) * 10000 : null;

    const bidDepthQty = sumDepthQty(bid);
    const askDepthQty = sumDepthQty(ask);
    const totalBuyQuantity = toNumber(
      book?.totalBuyQuantity ?? tradeInfo?.totalBuyQuantity ?? tradeInfo?.buyQuantity
    );
    const totalSellQuantity = toNumber(
      book?.totalSellQuantity ?? tradeInfo?.totalSellQuantity ?? tradeInfo?.sellQuantity
    );

    const buyPressure = totalBuyQuantity ?? bidDepthQty;
    const sellPressure = totalSellQuantity ?? askDepthQty;
    const imbalanceRatio =
      buyPressure != null && sellPressure != null && (buyPressure + sellPressure) > 0
        ? (buyPressure - sellPressure) / (buyPressure + sellPressure)
        : null;
    const buySellPressureRatio =
      buyPressure != null && sellPressure != null && sellPressure > 0
        ? buyPressure / sellPressure
        : null;

    const signal = classifyMicrostructureSignal({
      spreadBps,
      imbalanceRatio,
      buySellPressureRatio,
    });

    return {
      available: true,
      bestBid,
      bestAsk,
      spread,
      spreadBps: spreadBps != null ? Number(spreadBps.toFixed(2)) : null,
      bidDepthQty,
      askDepthQty,
      totalBuyQuantity: buyPressure,
      totalSellQuantity: sellPressure,
      imbalanceRatio: imbalanceRatio != null ? Number(imbalanceRatio.toFixed(3)) : null,
      buySellPressureRatio: buySellPressureRatio != null ? Number(buySellPressureRatio.toFixed(2)) : null,
      signal,
    };
  } catch (error) {
    return {
      available: false,
      signal: {
        status: 'unavailable',
        bias: 'unknown',
        score: 0,
        reasons: [error.message || 'Order-book unavailable']
      }
    };
  }
}
