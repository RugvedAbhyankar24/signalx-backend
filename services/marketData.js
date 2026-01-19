import fetch from 'node-fetch';

const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YF_QUOTE = 'https://query1.finance.yahoo.com/v7/finance/quote';
const NSE_HOME = 'https://www.nseindia.com';
const NSE_API = 'https://www.nseindia.com/api';
let cookies = ''
/* =====================
   YAHOO CHART FETCH
====================== */
async function yahooChart(symbol, params) {
  const usp = new URLSearchParams(params);
  const url = `${YF_BASE}/${encodeURIComponent(symbol)}?${usp.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo fetch failed for ${symbol}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${symbol}`);
  return result;
}

/* =====================
   COMPANY META (NSE)
====================== */
export async function fetchCompanyMeta(symbol) {
  const base = baseIndianSymbol(symbol);
  const data = await fetchNSE(`/quote-equity?symbol=${encodeURIComponent(base)}`);
  const info = data?.info || data?.metadata || {};
  const securityInfo = data?.securityInfo || {};
  return {
    companyName: info.companyName || info.symbol || base,
    industry: info.industry || securityInfo.industry || info.sector,
  };
}

async function initNSESession() {
  const res = await fetch(NSE_HOME, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'text/html'
    }
  })

  cookies = res.headers.get('set-cookie')
}

/* =====================
   SYMBOL NORMALIZATION
====================== */
function normalizeIndianSymbol(symbol) {
  if (!symbol) return symbol;
  const s = String(symbol).trim().toUpperCase();
  if (s.endsWith('.NS') || s.endsWith('.BO')) return s;
  return `${s}.NS`;
}

/* =====================
   GAP + PRICE (NSE)
====================== */
export async function fetchGapData(symbol) {
  const base = baseIndianSymbol(symbol);

  try {
    const q = await fetchNSEQuote(base);

    const prevClose = q?.previousClose ?? null;
    const open = q?.open ?? null;
    const currentPrice = q?.lastPrice ?? null;

    if (prevClose == null || open == null) {
      throw new Error('NSE missing price fields');
    }

    const gapOpenPct = ((open - prevClose) / prevClose) * 100;
    const gapNowPct =
      currentPrice != null
        ? ((currentPrice - prevClose) / prevClose) * 100
        : null;

    let marketCap = q?.marketCap ?? null;
    let marketCapSource = marketCap ? 'NSE' : null;

    if (!marketCap && currentPrice && q?.issuedSize) {
      const issued = Number(q.issuedSize);
      if (isFinite(issued) && issued > 0) {
        marketCap = Math.round(currentPrice * issued);
        marketCapSource = 'NSE:issuedSize';
      }
    }

    if (!marketCap) {
      marketCap = await fetchScreenerMarketCap(base);
      marketCapSource = marketCap ? 'Screener' : null;
    }

    if (!marketCap) {
      const norm = normalizeIndianSymbol(symbol);
      const yq = await fetchQuote(norm);
      marketCap = yq?.marketCap ?? null;
      marketCapSource = marketCap ? 'Yahoo' : null;
    }

    return {
      open,
      prevClose,
      currentPrice,
      gapOpenPct,
      gapNowPct,
      marketCap,
      marketCapSource,
      priceSource: 'NSE',
      companyName: q?.companyName || base,
    };
  } catch (err) {
    throw new Error(`NSE quote failed: ${err.message || err}`);
  }
}

/* =====================
   OHLCV (YAHOO)
====================== */
export async function fetchOHLCV(symbol, minPeriods = 60) {
  const norm = normalizeIndianSymbol(symbol);
  const result = await yahooChart(norm, { range: '6mo', interval: '1d' });

  const q = result?.indicators?.quote?.[0];
  if (!q) throw new Error(`No OHLC data for ${symbol}`);

  const candles = q.close.map((_, i) => ({
  open: q.open[i],
  high: q.high[i],
  low: q.low[i],
  close: q.close[i],
  volume: q.volume[i],
  isGreen: q.close[i] > q.open[i],
  isRed: q.close[i] < q.open[i],
}))

    .filter(
      c =>
        c.open != null &&
        c.high != null &&
        c.low != null &&
        c.close != null &&
        c.volume != null
    );

  if (candles.length < minPeriods) {
    throw new Error(`Insufficient OHLC data for ${symbol}`);
  }

  return candles;
}
export async function fetchIndexOHLC(indexName) {
  const name = indexName.toUpperCase().replace(/\s+/g, '')

  // -----------------------
  // NSE INDICES
  // -----------------------
  const nseMap = {
    NIFTY50: 'NIFTY%2050',
    NIFTY: 'NIFTY%2050',
    BANKNIFTY: 'NIFTY%20BANK',
    NIFTYBANK: 'NIFTY%20BANK'
  }

  if (nseMap[name]) {
    if (!cookies) await initNSESession()

    const url = `${NSE_API}/equity-stockIndices?index=${nseMap[name]}`
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
        Cookie: cookies,
        Referer: NSE_HOME
      }
    })

    if (!res.ok) throw new Error(`NSE index fetch failed (${res.status})`)

    const json = await res.json()
    const d = json?.data?.[0]
    if (!d) throw new Error(`No NSE index data for ${indexName}`)

    return {
      open: d.open,
      high: d.dayHigh,
      low: d.dayLow,
      prevClose: d.previousClose,
      last: d.lastPrice,
      changePct: d.pChange,
      source: 'NSE'
    }
  }

  // -----------------------
  // BSE: SENSEX (YAHOO)
  // -----------------------
if (name === 'SENSEX') {
  const chart = await yahooChart('^BSESN', {
    range: '5d',
    interval: '1d'
  })

  const meta = chart?.meta
  const quote = chart?.indicators?.quote?.[0]

  if (!meta || !quote?.close?.length) {
    throw new Error('Yahoo Sensex data missing')
  }

  const closes = quote.close.filter(v => v != null)

  const last = meta.regularMarketPrice ?? closes[closes.length - 1]

  const prevClose =
    meta.regularMarketPreviousClose ??
    meta.previousClose ??
    closes[closes.length - 2]

  let changePct = null

  // ✅ Best case: Yahoo already gives it
  if (typeof meta.regularMarketChangePercent === 'number') {
    changePct = meta.regularMarketChangePercent
  }
  // ✅ Fallback: calculate safely
  else if (prevClose && last) {
    changePct = ((last - prevClose) / prevClose) * 100
  }

  return {
    open: meta.chartPreviousClose ?? prevClose,
    high: meta.regularMarketDayHigh,
    low: meta.regularMarketDayLow,
    prevClose,
    last,
    changePct: changePct != null ? Number(changePct.toFixed(2)) : null,
    source: 'YAHOO'
  }
}



  throw new Error(`Unknown index: ${indexName}`)
}



/* =====================
   YAHOO QUOTE (FALLBACK)
====================== */
async function fetchQuote(symbol) {
  const url = `${YF_QUOTE}?symbols=${encodeURIComponent(symbol)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data?.quoteResponse?.result?.[0] || null;
}

/* =====================
   NSE HELPERS
====================== */
let nseCookie = null;
let nseCookieTime = 0;

function baseIndianSymbol(symbol) {
  if (!symbol) return symbol;
  return String(symbol).trim().toUpperCase().replace(/\.(NS|BO)$/i, '');
}

async function getNSEHeaders() {
  const now = Date.now();
  const needNew = !nseCookie || now - nseCookieTime > 10 * 60 * 1000;

  if (needNew) {
    const res = await fetch(NSE_HOME, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html',
      },
    });

    const raw = res.headers.raw?.();
    const cookies = raw?.['set-cookie'];
    if (cookies?.length) {
      nseCookie = cookies.map(c => c.split(';')[0]).join('; ');
      nseCookieTime = now;
    }
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json',
    Referer: NSE_HOME + '/',
    'X-Requested-With': 'XMLHttpRequest',
  };

  if (nseCookie) headers.Cookie = nseCookie;
  return headers;
}

export async function fetchNSE(path) {
  const headers = await getNSEHeaders();
  const res = await fetch(`${NSE_API}${path}`, { headers });
  if (!res.ok) throw new Error(`NSE request failed (${res.status})`);
  return res.json();
}

async function fetchNSEQuote(symbolBase) {
  const data = await fetchNSE(`/quote-equity?symbol=${encodeURIComponent(symbolBase)}`);
  const p = data?.priceInfo || {};
  const s = data?.securityInfo || {};
  const info = data?.info || {};
  return {
    lastPrice: p.lastPrice,
    previousClose: p.previousClose,
    open: p.open,
    marketCap: s.marketCap ?? p.totalMarketCap,
    issuedSize: s.issuedSize,
    companyName: info.companyName || symbolBase,
  };
}

/* =====================
   SCREENER FALLBACK
====================== */
async function fetchScreenerMarketCap(symbolBase) {
  try {
    const res = await fetch(`https://www.screener.in/company/${symbolBase}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/Market\s*Cap[^\d]*([\d,.]+)\s*Cr/i);
    if (!m) return null;
    return Math.round(parseFloat(m[1].replace(/,/g, '')) * 1e7);
  } catch {
    return null;
  }
}

export async function resolveNSESymbol(query) {
  const q = query.trim().toUpperCase()

  // If already valid NSE symbol, try directly
  try {
    await fetchNSEQuote(q)
    return q
  } catch (_) {}

  // 🔍 NSE search API (official)
  const data = await fetchNSE(
    `/search/autocomplete?q=${encodeURIComponent(q)}`
  )

  const best = data?.symbols?.[0]
  if (!best?.symbol) {
    throw new Error(`No NSE symbol found for "${query}"`)
  }

  return best.symbol
}

export async function fetchMarketMovers() {
  const data = await fetchNSE('/equity-stockIndices?index=NIFTY%20500')

  const stocks = data?.data || []

  return stocks
    .slice(0, 12)
    .map(s => ({
      symbol: s.symbol,
      price: s.lastPrice,
      changePct: s.pChange
    }))
}
export async function fetchFundamentals(symbolBase) {
  try {
    const res = await fetch(`https://www.screener.in/company/${symbolBase}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const html = await res.text()

    const extract = (regex) =>
      Number(html.match(regex)?.[1]?.replace(/,/g, '')) || null

    return {
      revenueGrowth: extract(/Sales Growth[^%]*([\d.]+)%/i),
      profitGrowth: extract(/Profit Growth[^%]*([\d.]+)%/i),
      roe: extract(/ROE[^%]*([\d.]+)%/i),
      debtToEquity: extract(/Debt to Equity[^:]*([\d.]+)/i)
    }
  } catch {
    return null
  }
}
