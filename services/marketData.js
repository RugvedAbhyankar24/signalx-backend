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

const IST_WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short',
});

/**
 * Returns true only when NSE's live API is expected to be reachable:
 * a weekday that is not in NSE_HOLIDAYS and is within a loose window
 * around market hours (08:00–16:30 IST). Outside this window the API
 * either returns 403 or stale data, so we skip straight to Yahoo.
 */
function isNSELikelyAvailable() {
  const now = new Date();
  const weekday = IST_WEEKDAY_FORMATTER.format(now);
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const istDate = IST_DATE_FORMATTER.format(now);
  const NSE_HOLIDAYS = new Set(
    String(process.env.NSE_HOLIDAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  );
  if (NSE_HOLIDAYS.has(istDate)) return false;

  // Accept a wider window than the trading session so pre-open and
  // post-close data calls also use NSE (08:00–16:30 IST)
  const hourMin = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now);
  const [h, m] = hourMin.split(':').map(Number);
  const mins = h * 60 + m;
  return mins >= 8 * 60 && mins <= 16 * 60 + 30;
}
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
/**
 * Yahoo Finance fallback for full gap/price data.
 * Uses the v8 chart API (more reliable than v7/quote which requires crumbs).
 * Works on weekends — returns last trading session's price as currentPrice.
 */
async function fetchGapDataFromYahoo(symbol) {
  const norm = normalizeIndianSymbol(symbol);  // e.g. HDFCBANK.NS

  // Fetch 5-day daily chart — gives us meta fields and recent OHLCV
  const result = await yahooChart(norm, { range: '5d', interval: '1d' });
  const meta = result?.meta;
  if (!meta) throw new Error('Yahoo Finance chart returned no meta');

  // Prefer the live regularMarketPrice from meta; fall back to last daily close
  let currentPrice = meta.regularMarketPrice ?? null;
  let prevClose    = meta.regularMarketPreviousClose ?? meta.previousClose ?? null;
  let open         = meta.regularMarketOpen ?? null;
  let marketCap    = meta.marketCap ?? null;

  // If meta fields are missing (can happen outside trading hours for some feeds),
  // derive from the daily OHLCV candles in the chart response
  if (currentPrice == null || prevClose == null) {
    const q  = result?.indicators?.quote?.[0];
    const ts = result?.timestamp ?? [];
    const closes = (q?.close  ?? []).map((v, i) => ({ v, t: ts[i] })).filter(x => x.v != null);
    const opens  = (q?.open   ?? []).map((v, i) => ({ v, t: ts[i] })).filter(x => x.v != null);

    if (closes.length >= 2) {
      currentPrice ??= closes[closes.length - 1].v;
      prevClose    ??= closes[closes.length - 2].v;
      open         ??= opens[opens.length - 1]?.v ?? null;
    } else if (closes.length === 1) {
      currentPrice ??= closes[0].v;
    }
  }

  if (currentPrice == null || prevClose == null) {
    throw new Error('Yahoo Finance missing core price fields');
  }

  const gapOpenPct = (open != null && prevClose !== 0)
    ? ((open - prevClose) / prevClose) * 100
    : null;
  const gapNowPct = prevClose !== 0
    ? ((currentPrice - prevClose) / prevClose) * 100
    : null;

  return {
    open,
    prevClose,
    currentPrice,
    gapOpenPct,
    gapNowPct,
    marketCap,
    marketCapSource: marketCap ? 'Yahoo' : null,
    priceSource: 'Yahoo',
    companyName: meta.longName || meta.shortName || baseIndianSymbol(symbol),
  };
}

export async function fetchGapData(symbol) {
  const base = baseIndianSymbol(symbol);
  let nseError = null;

  // ── Primary: NSE (only on trading days within market window) ──
  if (!isNSELikelyAvailable()) {
    console.debug(`[fetchGapData] NSE skipped for ${base} (market closed) — using Yahoo Finance`);
    return fetchGapDataFromYahoo(symbol);
  }

  try {
    const q = await fetchNSEQuote(base);

    const prevClose    = q?.previousClose ?? null;
    const open         = q?.open ?? null;
    const currentPrice = q?.lastPrice ?? null;

    if (prevClose == null || open == null) {
      throw new Error('NSE missing price fields');
    }

    const gapOpenPct = ((open - prevClose) / prevClose) * 100;
    const gapNowPct  = currentPrice != null
      ? ((currentPrice - prevClose) / prevClose) * 100
      : null;

    let marketCap       = q?.marketCap ?? null;
    let marketCapSource = marketCap ? 'NSE' : null;

    if (!marketCap && currentPrice && q?.issuedSize) {
      const issued = Number(q.issuedSize);
      if (isFinite(issued) && issued > 0) {
        marketCap = Math.round(currentPrice * issued);
        marketCapSource = 'NSE:issuedSize';
      }
    }

    // Market-cap fallbacks (non-blocking — don't let these fail the whole call)
    if (!marketCap) {
      try {
        marketCap = await fetchScreenerMarketCap(base);
        marketCapSource = marketCap ? 'Screener' : null;
      } catch { /* ignore */ }
    }
    if (!marketCap) {
      try {
        const yResult = await yahooChart(normalizeIndianSymbol(symbol), { range: '1d', interval: '1d' });
        marketCap = yResult?.meta?.marketCap ?? null;
        marketCapSource = marketCap ? 'Yahoo' : null;
      } catch { /* ignore */ }
    }

    return { open, prevClose, currentPrice, gapOpenPct, gapNowPct, marketCap, marketCapSource, priceSource: 'NSE', companyName: q?.companyName || base };
  } catch (err) {
    nseError = err;
    console.warn(`[fetchGapData] NSE failed for ${base} (${err.message}) — trying Yahoo Finance`);
  }

  // ── Fallback: Yahoo Finance ───────────────────────────────────
  try {
    return await fetchGapDataFromYahoo(symbol);
  } catch (yhErr) {
    throw new Error(`Price unavailable — NSE: ${nseError.message}; Yahoo: ${yhErr.message}`);
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
    NIFTY50: 'NIFTY 50',
    NIFTY: 'NIFTY 50',
    BANKNIFTY: 'NIFTY BANK',
    NIFTYBANK: 'NIFTY BANK'
  }

  if (nseMap[name]) {
    try {
      const json = await fetchNSE('/allIndices')
      const rows = Array.isArray(json?.data) ? json.data : []
      const d = rows.find((row) => String(row?.index || '').toUpperCase() === nseMap[name])
      if (!d) throw new Error(`No NSE index data for ${indexName}`)

      const open = Number(d.open)
      const high = Number(d.high ?? d.dayHigh)
      const low = Number(d.low ?? d.dayLow)
      const prevClose = Number(d.previousClose)
      const last = Number(d.last)
      const changePct = Number(d.percentChange ?? d.pChange)

      return {
        open: Number.isFinite(open) ? open : null,
        high: Number.isFinite(high) ? high : null,
        low: Number.isFinite(low) ? low : null,
        prevClose: Number.isFinite(prevClose) ? prevClose : null,
        last: Number.isFinite(last) ? last : null,
        changePct: Number.isFinite(changePct) ? changePct : null,
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

// Browser-like UA used across all NSE requests
const NSE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

/**
 * Establish an NSE session by visiting the home page and then the
 * live-equity-market data page. NSE/Cloudflare expects at least two
 * page visits before accepting API calls; visiting only the home page
 * often results in 404 on the first API request.
 */
async function refreshNSESession() {
  const now = Date.now()
  const htmlHeaders = {
    'User-Agent': NSE_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
  }

  // Step 1 — home page (gets the initial nsit / nseappid cookies)
  const homeRes = await fetch(NSE_HOME, { headers: htmlHeaders })
  const rawHome = homeRes.headers.raw ? homeRes.headers.raw() : {}
  const homeCookies = rawHome['set-cookie'] || []

  // Step 2 — equity market page (deepens the session, required by NSE)
  const warmupRes = await fetch(`${NSE_HOME}/market-data/live-equity-market`, {
    headers: {
      ...htmlHeaders,
      Referer: NSE_HOME + '/',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      Cookie: homeCookies.map(c => c.split(';')[0]).join('; '),
    }
  })
  const rawWarmup = warmupRes.headers.raw ? warmupRes.headers.raw() : {}
  const warmupCookies = rawWarmup['set-cookie'] || []

  // Merge cookies: later Set-Cookie headers override earlier ones by name
  const cookieMap = new Map()
  for (const c of [...homeCookies, ...warmupCookies]) {
    const pair = c.split(';')[0].trim()
    const eqIdx = pair.indexOf('=')
    if (eqIdx > 0) cookieMap.set(pair.slice(0, eqIdx), pair)
  }

  if (cookieMap.size > 0) {
    nseCookie = Array.from(cookieMap.values()).join('; ')
    nseCookieTime = now
  }
}

async function getNSEHeaders(forceRefresh = false) {
  const now = Date.now()
  const stale = !nseCookie || now - nseCookieTime > 5 * 60 * 1000

  if (forceRefresh || stale) {
    try {
      await refreshNSESession()
    } catch {
      // Non-fatal: proceed with whatever cookies we have (or none)
    }
  }

  return {
    'User-Agent': NSE_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    Referer: `${NSE_HOME}/`,
    'X-Requested-With': 'XMLHttpRequest',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    Connection: 'keep-alive',
    Cookie: nseCookie || '',
  }
}

export async function fetchNSE(path, retries = 3) {
  return withNSELock(async () => {
    let lastError
    for (let i = 0; i < retries; i++) {
      try {
        // Force-refresh session on every retry after the first attempt
        const headers = await getNSEHeaders(i > 0)
        const res = await fetch(`${NSE_API}${path}`, { headers })

        if (res.ok) return res.json()

        // 401/403/404 all indicate a session/bot-protection issue — reset and retry
        const status = res.status
        lastError = new Error(`NSE request failed (${status})`)
        nseCookie = null
        nseCookieTime = 0

        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (i + 1))) // 1s, 2s back-off
        }
      } catch (err) {
        lastError = err
        nseCookie = null
        nseCookieTime = 0
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (i + 1)))
        }
      }
    }
    throw lastError
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

/**
 * Lightweight price-only quote — skips the slow market-cap fallback chain.
 * Tries NSE first; falls back to Yahoo Finance if NSE is unavailable.
 * Returns { currentPrice, previousClose, dayChangePct } or throws.
 */
export async function fetchQuoteBasic(symbol) {
  const base = baseIndianSymbol(symbol);
  const norm = normalizeIndianSymbol(symbol);

  // Skip NSE outside trading window to avoid guaranteed 403s
  if (!isNSELikelyAvailable()) {
    try {
      const result = await yahooChart(norm, { range: '2d', interval: '1d' });
      const meta = result?.meta;
      if (!meta) return { currentPrice: null, previousClose: null, dayChangePct: null };
      const currentPrice  = meta.regularMarketPrice ?? null;
      const previousClose = meta.regularMarketPreviousClose ?? meta.previousClose ?? null;
      const dayChangePct  =
        meta.regularMarketChangePercent ??
        (currentPrice != null && previousClose != null && previousClose !== 0
          ? ((currentPrice - previousClose) / previousClose) * 100
          : null);
      return { currentPrice, previousClose, dayChangePct };
    } catch {
      return { currentPrice: null, previousClose: null, dayChangePct: null };
    }
  }

  // Primary: NSE (trading days only)
  try {
    const q = await fetchNSEQuote(base);
    const currentPrice  = q?.lastPrice ?? null;
    const previousClose = q?.previousClose ?? null;
    const dayChangePct  =
      currentPrice != null && previousClose != null && previousClose !== 0
        ? ((currentPrice - previousClose) / previousClose) * 100
        : null;
    return { currentPrice, previousClose, dayChangePct };
  } catch {
    // Fallback: Yahoo Finance chart API (v8 — more reliable than v7/quote)
    try {
      const norm = normalizeIndianSymbol(symbol);
      const result = await yahooChart(norm, { range: '2d', interval: '1d' });
      const meta = result?.meta;
      if (!meta) return { currentPrice: null, previousClose: null, dayChangePct: null };
      const currentPrice  = meta.regularMarketPrice ?? null;
      const previousClose = meta.regularMarketPreviousClose ?? meta.previousClose ?? null;
      const dayChangePct  =
        meta.regularMarketChangePercent ??
        (currentPrice != null && previousClose != null && previousClose !== 0
          ? ((currentPrice - previousClose) / previousClose) * 100
          : null);
      return { currentPrice, previousClose, dayChangePct };
    } catch {
      return { currentPrice: null, previousClose: null, dayChangePct: null };
    }
  }
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

  // Skip NSE entirely outside trading window — avoids guaranteed 403s
  if (!isNSELikelyAvailable()) return q

  // If already valid NSE symbol, try directly
  try {
    await fetchNSEQuote(q)
    return q
  } catch (_) {}

  // 🔍 NSE search API (official)
  try {
    const data = await fetchNSE(
      `/search/autocomplete?q=${encodeURIComponent(q)}`
    )

    const best = data?.symbols?.[0]
    if (best?.symbol) return best.symbol
  } catch (_) {
    // NSE may be unavailable (e.g. rate-limited) — fall through to symbol passthrough
  }

  // NSE couldn't confirm — return the raw symbol so fetchGapData falls back to Yahoo.
  return q
}

/* =====================
   FAST SCAN (Stage 1)
====================== */
export async function fastMarketScan() {
  const data = await fetchNSE('/equity-stockIndices?index=NIFTY%20500')
  const stocks = data?.data || []

  const stage1Limit = Math.max(
    30,
    Math.min(120, Number(process.env.FAST_SCAN_STAGE1_LIMIT || 50))
  )
  const minPrice = Number(process.env.FAST_SCAN_MIN_PRICE || 10)
  const minVolume = Number(process.env.FAST_SCAN_MIN_VOLUME || 50000)
  const minMovement = Number(process.env.FAST_SCAN_MIN_MOVEMENT || 0.3)
  const minTurnover = Number(process.env.FAST_SCAN_MIN_TURNOVER || 75000000) // 7.5 Cr

  const normalized = stocks
    .map(s => {
      const symbol = s?.symbol
      const price = Number(s?.lastPrice)
      const changePct = Number(s?.pChange)
      const prevClose = Number(s?.previousClose)
      const open = Number(s?.open)
      const dayHigh = Number(s?.dayHigh)
      const dayLow = Number(s?.dayLow)
      const volume = Number(s?.totalTradedVolume)

      if (!symbol || !Number.isFinite(price) || !Number.isFinite(changePct) || !Number.isFinite(volume)) {
        return null
      }
      if (!(price > minPrice) || !(volume > minVolume)) return null

      const movement = Math.abs(changePct)
      if (movement < minMovement) return null

      const turnover = price * volume
      const intradayMoveFromOpen =
        Number.isFinite(open) && open > 0 ? ((price - open) / open) * 100 : changePct
      const dayRangePct =
        Number.isFinite(dayHigh) && Number.isFinite(dayLow) && Number.isFinite(prevClose) && prevClose > 0
          ? ((dayHigh - dayLow) / prevClose) * 100
          : movement
      const side = changePct >= 0 ? 'long' : 'short'
      const directionalBias = Math.abs(changePct)
      const participationScore = movement * Math.sqrt(Math.max(volume, 1))
      const directionalStructureScore = (() => {
        if (!Number.isFinite(dayHigh) || !Number.isFinite(dayLow) || dayHigh <= dayLow) return 0.5
        const rangePosition = (price - dayLow) / (dayHigh - dayLow)
        const clamped = Math.min(Math.max(rangePosition, 0), 1)
        return side === 'short' ? 1 - clamped : clamped
      })()
      const directionalMoveFromOpen = side === 'short'
        ? Math.max(-intradayMoveFromOpen, -2)
        : Math.max(intradayMoveFromOpen, -2)

      const compositeScore =
        movement * 3.9 +
        Math.log10(Math.max(turnover, 1)) * 2.0 +
        directionalBias * 0.85 +
        directionalMoveFromOpen * 0.25 +
        Math.max(dayRangePct, 0) * 0.35 +
        directionalStructureScore * 1.4

      return {
        symbol,
        price,
        changePct,
        volume,
        movement,
        turnover,
        participationScore,
        intradayMoveFromOpen,
        dayRangePct,
        directionalStructureScore,
        side,
        compositeScore,
        gapPct: Number.isFinite(prevClose) && prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : null
      }
    })
    .filter(Boolean)

  let institutionalPool = normalized.filter(s => s.turnover >= minTurnover)
  if (institutionalPool.length < stage1Limit) {
    institutionalPool = normalized
  }

  const momentumCount = Math.max(10, Math.round(stage1Limit * 0.45))
  const liquidityCount = Math.max(10, Math.round(stage1Limit * 0.35))
  const participationCount = Math.max(8, Math.round(stage1Limit * 0.3))
  const compositeCount = Math.max(12, Math.round(stage1Limit * 0.45))

  const upsidePool = institutionalPool.filter(s => s.side === 'long')
  const downsidePool = institutionalPool.filter(s => s.side === 'short')
  const balancedPerSide = Math.max(6, Math.round(stage1Limit * 0.22))

  const momentumLeaders = [
    ...[...upsidePool].sort((a, b) => b.changePct - a.changePct).slice(0, balancedPerSide),
    ...[...downsidePool].sort((a, b) => a.changePct - b.changePct).slice(0, balancedPerSide),
    ...[...institutionalPool].sort((a, b) => b.movement - a.movement).slice(0, Math.max(6, momentumCount - (balancedPerSide * 2)))
  ]

  const liquidityLeaders = [...institutionalPool]
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, liquidityCount)

  const participationLeaders = [
    ...[...upsidePool].sort((a, b) => b.participationScore - a.participationScore).slice(0, Math.max(4, Math.round(participationCount / 2))),
    ...[...downsidePool].sort((a, b) => b.participationScore - a.participationScore).slice(0, Math.max(4, Math.round(participationCount / 2))),
    ...[...institutionalPool].sort((a, b) => b.participationScore - a.participationScore).slice(0, 4)
  ]

  const compositeLeaders = [...institutionalPool]
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, compositeCount)

  const unique = new Map()
  for (const item of [...compositeLeaders, ...momentumLeaders, ...liquidityLeaders, ...participationLeaders, ...institutionalPool]) {
    const existing = unique.get(item.symbol)
    if (!existing || item.compositeScore > existing.compositeScore) {
      unique.set(item.symbol, item)
    }
    if (unique.size >= stage1Limit * 2) break
  }

  return [...unique.values()]
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, stage1Limit)
    .map(s => ({
      symbol: s.symbol,
      price: s.price,
      changePct: s.changePct,
      volume: s.volume,
      side: s.side,
      movement: s.movement,
      turnover: Math.round(s.turnover),
      intradayMoveFromOpen: Number(s.intradayMoveFromOpen.toFixed(2)),
      dayRangePct: Number(s.dayRangePct.toFixed(2)),
      gapPct: s.gapPct == null ? null : Number(s.gapPct.toFixed(2)),
      compositeScore: Number(s.compositeScore.toFixed(2))
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

    const extract = (regex) => {
      const raw = html.match(regex)?.[1]
      if (!raw) return null

      const cleaned = raw.replace(/,/g, '').trim()
      const isParenNegative = cleaned.startsWith('(') && cleaned.endsWith(')')
      const numeric = Number(cleaned.replace(/[()]/g, ''))
      if (!Number.isFinite(numeric)) return null

      return isParenNegative ? -Math.abs(numeric) : numeric
    }

    return {
      revenueGrowth: extract(/Sales Growth[^%]*([+-]?\(?[\d.]+\)?)[\s%]/i),
      profitGrowth: extract(/Profit Growth[^%]*([+-]?\(?[\d.]+\)?)[\s%]/i),
      roe: extract(/ROE[^%]*([+-]?\(?[\d.]+\)?)[\s%]/i),
      debtToEquity: extract(/Debt to Equity[^:]*([+-]?\(?[\d.]+\)?)/i)
    }
  } catch {
    return null
  }
}
