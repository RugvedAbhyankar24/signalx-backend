import fetch from 'node-fetch';

const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YF_QUOTE = 'https://query1.finance.yahoo.com/v7/finance/quote';
const NSE_HOME = 'https://www.nseindia.com';
const NSE_API = 'https://www.nseindia.com/api';
const IST_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
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
function getISTDateFromEpoch(epochSeconds) {
  return IST_DATE_FORMATTER.format(new Date(epochSeconds * 1000));
}

export async function fetchOHLCV(symbol, minPeriods = 60, options = {}) {
  const interval = options.interval || '1d';
  const range = options.range || (interval === '1d' ? '6mo' : '5d');
  const norm = normalizeIndianSymbol(symbol);
  const result = await yahooChart(norm, { range, interval });

  const q = result?.indicators?.quote?.[0];
  const t = result?.timestamp; // ✅ FIX: timestamp is at root level, not in indicators
  if (!q) throw new Error(`No OHLC data for ${symbol}`);

  const candles = q.close.map((_, i) => ({
    timestamp: t?.[i]
      ? (interval === '1d'
          ? new Date(t[i] * 1000).toISOString().slice(0, 10)
          : new Date(t[i] * 1000).toISOString())
      : null,
    tradeDateIST: t?.[i] ? getISTDateFromEpoch(t[i]) : null,
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
  const name = indexName
    .toUpperCase()
    .replace(/[\s\-]/g, '') // ✅ FIX: Handle both spaces and hyphens

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
    try {
      const url = `${NSE_API}/equity-stockIndices?index=${nseMap[name]}`
      let res = await fetch(url, { headers: await getNSEHeaders() })

      if (res.status === 403) {
        // 🔄 Force cookie refresh ONCE
        res = await fetch(url, {
          headers: await getNSEHeaders(true)
        })
      }

      if (!res.ok) {
        throw new Error(`NSE index fetch failed (${res.status})`)
      }

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
    } catch (err) {
      console.warn('NSE index failed, falling back to Yahoo:', err.message)

      const yahooSymbol =
        name === 'BANKNIFTY' || name === 'NIFTYBANK'
          ? '^NSEBANK'
          : '^NSEI'

      const chart = await yahooChart(yahooSymbol, {
        range: '1d',
        interval: '5m'
      })

      const meta = chart.meta
      const quote = chart.indicators.quote[0]
      const last = meta.regularMarketPrice

      return {
        open: meta.chartPreviousClose,
        high: meta.regularMarketDayHigh,
        low: meta.regularMarketDayLow,
        prevClose: meta.previousClose,
        last,
        changePct: meta.regularMarketChangePercent,
        source: 'YAHOO-FALLBACK'
      }
    }
  }

  // -----------------------
  // BSE: SENSEX (Simplified API Implementation)
  // -----------------------
if (name === 'SENSEX') {
  try {
    // Try BSE web scraping first - most reliable
    const bseWebResponse = await fetch('https://www.bseindia.com/sensex/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })
    
    if (bseWebResponse.ok) {
      const html = await bseWebResponse.text()
      // Extract Sensex value from HTML using regex patterns
      const sensexMatch = html.match(/class="sensexval"[^>]*>([\d,]+\.?\d*)/i) || 
                          html.match(/id="sensexvalue"[^>]*>([\d,]+\.?\d*)/i) ||
                          html.match(/SENSEX[^>]*>([\d,]+\.?\d*)/i)
      
      const changeMatch = html.match(/class="sensexchange"[^>]*>([+-]?[\d,]+\.?\d*)/i) ||
                          html.match(/id="sensexchange"[^>]*>([+-]?[\d,]+\.?\d*)/i)
      
      const percentMatch = html.match(/class="sensexpercent"[^>]*>([+-]?[\d,]+\.?\d*)/i) ||
                           html.match(/id="sensexpercent"[^>]*>([+-]?[\d,]+\.?\d*)/i)
      
      if (sensexMatch) {
        const sensexValue = parseFloat(sensexMatch[1].replace(/,/g, ''))
        const changeValue = changeMatch ? parseFloat(changeMatch[1].replace(/,/g, '')) : null
        const changePercent = percentMatch ? parseFloat(percentMatch[1].replace(/,/g, '')) : null
        
        return {
          open: null,
          high: null,
          low: null,
          prevClose: changeValue && sensexValue ? sensexValue - changeValue : null,
          last: sensexValue,
          changePct: changePercent,
          source: 'BSE Web Scraped'
        }
      }
    }
  } catch (scrapeError) {
    console.log('Web scraping failed, trying Yahoo:', scrapeError.message)
  }

  // Fallback to Yahoo Finance
  const chart = await yahooChart('^BSESN', {
    range: '1d',
    interval: '5m'  // 5-minute intervals for more recent data
  })

  const meta = chart?.meta
  const quote = chart?.indicators?.quote?.[0]

  if (!meta || !quote?.close?.length) {
    throw new Error('Yahoo Sensex data missing')
  }

  const closes = quote.close.filter(v => v != null)
  const last = meta.regularMarketPrice ?? closes[closes.length - 1]
  const prevClose = meta.regularMarketPreviousClose ?? meta.previousClose ?? closes[closes.length - 2]

  let changePct = null
  if (typeof meta.regularMarketChangePercent === 'number') {
    changePct = meta.regularMarketChangePercent
  } else if (prevClose && last) {
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
let nseLock = Promise.resolve(); // 🔒 Mutex lock for NSE calls

async function withNSELock(fn) {
  const release = nseLock;
  let unlock;
  nseLock = new Promise(r => (unlock = r));
  await release;
  try {
    return await fn();
  } finally {
    unlock();
  }
}

function baseIndianSymbol(symbol) {
  if (!symbol) return symbol;
  return String(symbol).trim().toUpperCase().replace(/\.(NS|BO)$/i, '');
}

async function getNSEHeaders(forceRefresh = false) {
  const now = Date.now()
  const needNew = forceRefresh || !nseCookie || now - nseCookieTime > 5 * 60 * 1000

  if (needNew) {
    const res = await fetch(NSE_HOME, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Accept: 'text/html',
        'Accept-Language': 'en-IN,en;q=0.9',
        Connection: 'keep-alive'
      }
    })

    const raw = res.headers.raw?.()
    const cookies = raw?.['set-cookie']

    if (cookies?.length) {
      nseCookie = cookies.map(c => c.split(';')[0]).join('; ')
      nseCookieTime = now
    }
  }

  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    Accept: 'application/json',
    'Accept-Language': 'en-IN,en;q=0.9',
    Referer: NSE_HOME + '/',
    'X-Requested-With': 'XMLHttpRequest',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    Connection: 'keep-alive',
    Cookie: nseCookie
  }
}

export async function fetchNSE(path, retries = 1) {
  return withNSELock(async () => {
    for (let i = 0; i < retries; i++) {
      try {
        const headers = await getNSEHeaders();
        const res = await fetch(`${NSE_API}${path}`, { headers });
        if (!res.ok) throw new Error(`NSE request failed (${res.status})`);
        return res.json();
      } catch (error) {
        if (i === retries - 1) throw error;
        nseCookie = null;
        nseCookieTime = 0;
        await new Promise(r => setTimeout(r, 800));
      }
    }
  });
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

/* =====================
   FAST SCAN (Stage 1)
====================== */
export async function fastMarketScan() {
  const data = await fetchNSE('/equity-stockIndices?index=NIFTY%20500')
  const stocks = data?.data || []

  return stocks
    .filter(s => {
      // Stage 1: Fast, cheap filters
      const movement = Math.abs(s.pChange || 0)
      const price = s.lastPrice || 0
      const volume = s.totalTradedVolume || 0
      
      return (
        movement >= 0.5 &&           // Lower threshold for initial scan
        price > 10 &&                 // Basic price filter
        volume > 50000               // Basic volume filter
      )
    })
    .sort((a, b) => Math.abs(b.pChange || 0) - Math.abs(a.pChange || 0))
    .slice(0, 50)                    // Shortlist 30-50 stocks for deep scan
    .map(s => ({
      symbol: s.symbol,
      price: s.lastPrice,
      changePct: s.pChange,
      volume: s.totalTradedVolume,
      movement: Math.abs(s.pChange || 0),
      // Quick gap calculation if previous close available
      gapPct: s.previousClose ? ((s.lastPrice - s.previousClose) / s.previousClose) * 100 : null
    }))
}

export async function fetchMarketMovers() {
  const data = await fetchNSE('/equity-stockIndices?index=NIFTY%20500')

  const stocks = data?.data || []

  return stocks
    .filter(s => {
      // Pre-filtering criteria - institutional grade
      const movement = Math.abs(s.pChange || 0)
      const price = s.lastPrice || 0
      const volume = s.totalTradedVolume || 0
      
      return (
        movement >= 1 &&           // At least 1% movement
        price > 20 &&              // Avoid illiquid junk
        volume > 100000            // Minimum liquidity threshold
      )
    })
    .sort((a, b) => Math.abs(b.pChange || 0) - Math.abs(a.pChange || 0))
    .slice(0, 30)                 // Take top 30 qualified movers
    .map(s => ({
      symbol: s.symbol,
      price: s.lastPrice,
      changePct: s.pChange,
      volume: s.totalTradedVolume,
      movement: Math.abs(s.pChange || 0)  // Add movement magnitude for sorting
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
