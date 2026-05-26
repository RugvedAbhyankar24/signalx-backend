import { fetchNSE } from './marketData.js';

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatDateDDMMYYYY(date) {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/\.(NS|BO)$/i, '');
}

export function classifyMarketActivitySignal({ flow = null, deals = null, biasDirection = 'long' } = {}) {
  const direction = biasDirection === 'short' ? 'short' : 'long';
  const reasons = [];
  let score = 0;

  const fiiNet = toNumber(flow?.fii?.netValueCr);
  const diiNet = toNumber(flow?.dii?.netValueCr);
  const combinedNet = [fiiNet, diiNet].filter(v => v != null).reduce((sum, v) => sum + v, 0);

  if (fiiNet != null || diiNet != null) {
    if (direction === 'long') {
      if (combinedNet >= 1500) {
        score += 2;
        reasons.push(`Institutional cash flow supportive: net ${combinedNet.toFixed(0)} Cr`);
      } else if (combinedNet <= -1500) {
        score -= 2;
        reasons.push(`Institutional cash flow against longs: net ${combinedNet.toFixed(0)} Cr`);
      }
    } else {
      if (combinedNet <= -1500) {
        score += 2;
        reasons.push(`Institutional cash flow supportive for shorts: net ${combinedNet.toFixed(0)} Cr`);
      } else if (combinedNet >= 1500) {
        score -= 2;
        reasons.push(`Institutional cash flow against shorts: net ${combinedNet.toFixed(0)} Cr`);
      }
    }
  }

  const buyDealValueCr = toNumber(deals?.buyDealValueCr);
  const sellDealValueCr = toNumber(deals?.sellDealValueCr);
  const netDealValueCr =
    buyDealValueCr != null && sellDealValueCr != null
      ? buyDealValueCr - sellDealValueCr
      : null;

  if (netDealValueCr != null && Math.abs(netDealValueCr) >= 10) {
    if (direction === 'long' && netDealValueCr > 0) {
      score += 2;
      reasons.push(`Recent block/bulk deal accumulation: ${netDealValueCr.toFixed(1)} Cr net buy`);
    } else if (direction === 'short' && netDealValueCr < 0) {
      score += 2;
      reasons.push(`Recent block/bulk deal distribution: ${Math.abs(netDealValueCr).toFixed(1)} Cr net sell`);
    } else {
      score -= 3;
      reasons.push(`Recent block/bulk deal flow conflicts with setup: ${netDealValueCr.toFixed(1)} Cr`);
    }
  }

  let status = 'neutral';
  if (score >= 3) status = 'supportive';
  else if (score <= -3) status = 'adverse';
  if (!reasons.length) reasons.push('No strong institutional activity edge detected');

  return { status, score, reasons };
}

export async function fetchInstitutionalFlowSnapshot() {
  const rows = await fetchNSE('/fiidiiTradeNse');
  const entries = Array.isArray(rows) ? rows : [];
  const map = {};

  for (const row of entries) {
    const category = String(row?.category || '').trim().toUpperCase();
    if (!category) continue;
    map[category] = {
      buyValueCr: toNumber(row?.buyValue),
      sellValueCr: toNumber(row?.sellValue),
      netValueCr: toNumber(row?.netValue),
      date: row?.date || null,
    };
  }

  return {
    fii: map.FII || map['FII/FPI'] || null,
    dii: map.DII || null,
    asOf: map.FII?.date || map['FII/FPI']?.date || map.DII?.date || null,
  };
}

export async function fetchRecentDealActivity(symbol, options = {}) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    return {
      symbol: normalized,
      bulkDeals: [],
      blockDeals: [],
      buyDealValueCr: 0,
      sellDealValueCr: 0,
      totalDeals: 0,
    };
  }

  const lookbackDays = Number.isFinite(options.lookbackDays) ? Math.max(1, options.lookbackDays) : 5;
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - lookbackDays));
  const fromDate = formatDateDDMMYYYY(from);
  const toDate = formatDateDDMMYYYY(now);

  const [bulkRes, blockRes] = await Promise.all([
    fetchNSE(`/historicalOR/bulk-block-short-deals?optionType=bulk_deals&from=${fromDate}&to=${toDate}`).catch(() => ({ data: [] })),
    fetchNSE(`/historicalOR/bulk-block-short-deals?optionType=block_deals&from=${fromDate}&to=${toDate}`).catch(() => ({ data: [] })),
  ]);

  const filterForSymbol = (rows) => (Array.isArray(rows) ? rows : [])
    .filter((row) => String(row?.BD_SYMBOL || '').trim().toUpperCase() === normalized)
    .slice(0, 25)
    .map((row) => ({
      date: row?.BD_DT_DATE || null,
      symbol: row?.BD_SYMBOL || normalized,
      companyName: row?.BD_SCRIP_NAME || null,
      clientName: row?.BD_CLIENT_NAME || null,
      side: row?.BD_BUY_SELL || null,
      quantity: toNumber(row?.BD_QTY_TRD),
      price: toNumber(row?.BD_TP_WATP),
      estimatedValueCr:
        toNumber(row?.BD_QTY_TRD) != null && toNumber(row?.BD_TP_WATP) != null
          ? Number((((row.BD_QTY_TRD * row.BD_TP_WATP) || 0) / 10000000).toFixed(2))
          : null,
      remarks: row?.BD_REMARKS || null,
    }));

  const bulkDeals = filterForSymbol(bulkRes?.data);
  const blockDeals = filterForSymbol(blockRes?.data);
  const allDeals = [...bulkDeals, ...blockDeals];

  let buyDealValueCr = 0;
  let sellDealValueCr = 0;
  for (const deal of allDeals) {
    if (!Number.isFinite(deal.estimatedValueCr)) continue;
    if (String(deal.side).toUpperCase() === 'BUY') buyDealValueCr += deal.estimatedValueCr;
    else if (String(deal.side).toUpperCase() === 'SELL') sellDealValueCr += deal.estimatedValueCr;
  }

  return {
    symbol: normalized,
    bulkDeals,
    blockDeals,
    buyDealValueCr: Number(buyDealValueCr.toFixed(2)),
    sellDealValueCr: Number(sellDealValueCr.toFixed(2)),
    totalDeals: allDeals.length,
  };
}

export async function fetchMarketActivityProfile(symbol, options = {}) {
  const biasDirection = options.biasDirection === 'short' ? 'short' : 'long';
  const [flow, deals] = await Promise.all([
    fetchInstitutionalFlowSnapshot().catch(() => null),
    fetchRecentDealActivity(symbol, options).catch(() => null),
  ]);

  return {
    symbol: normalizeSymbol(symbol),
    flow,
    deals,
    signal: classifyMarketActivitySignal({ flow, deals, biasDirection }),
  };
}
