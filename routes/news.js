import express from 'express'
import { fetchCompanyNews, classifySentiment } from '../services/newsService.js'
import { fetchQuoteBasic } from '../services/marketData.js'

const router = express.Router()

/* ─────────────────────────────────────────────
   CONFIG
───────────────────────────────────────────── */
// No longer used for domain-restricting the RSS query — fetchFromGoogleNews
// now searches open-web and deduplicates across queries.
// Kept here only as the `trustedOnly` source-name filter for the watchlist display.
const TRUSTED_NEWS_DOMAINS = [
  'moneycontrol.com',
  'economictimes.indiatimes.com',
  'livemint.com',
  'business-standard.com',
  'cnbctv18.com',
  'reuters.com',
  'financialexpress.com',
  'thehindubusinessline.com',
  'ndtvprofit.com',
  'zeebiz.com',
  'businesstoday.in',
  'bqprime.com',
  'investing.com',
  'theprint.in',
]

const WATCHLIST_UNIVERSE = [
  { symbol: 'RELIANCE',   companyName: 'Reliance Industries',       aliases: ['Reliance Industries', 'Reliance Industries Ltd', 'RIL'] },
  { symbol: 'TCS',        companyName: 'Tata Consultancy Services',  aliases: ['Tata Consultancy Services', 'TCS'] },
  { symbol: 'HDFCBANK',   companyName: 'HDFC Bank',                  aliases: ['HDFC Bank', 'HDFC Bank Ltd'] },
  { symbol: 'ICICIBANK',  companyName: 'ICICI Bank',                 aliases: ['ICICI Bank', 'ICICI Bank Ltd'] },
  { symbol: 'INFY',       companyName: 'Infosys',                    aliases: ['Infosys', 'Infosys Ltd'] },
  { symbol: 'SBIN',       companyName: 'State Bank of India',        aliases: ['State Bank of India', 'SBI'] },
  { symbol: 'BHARTIARTL', companyName: 'Bharti Airtel',              aliases: ['Bharti Airtel', 'Airtel'] },
  { symbol: 'LT',         companyName: 'Larsen & Toubro',            aliases: ['Larsen & Toubro', 'L&T'] },
  { symbol: 'AXISBANK',   companyName: 'Axis Bank',                  aliases: ['Axis Bank', 'Axis Bank Ltd'] },
  { symbol: 'ITC',        companyName: 'ITC',                        aliases: ['ITC', 'ITC Ltd'] },
  { symbol: 'MARUTI',     companyName: 'Maruti Suzuki',              aliases: ['Maruti Suzuki', 'Maruti Suzuki India'] },
  { symbol: 'SUNPHARMA',  companyName: 'Sun Pharmaceutical',         aliases: ['Sun Pharmaceutical', 'Sun Pharma', 'Sun Pharmaceutical Industries'] },
  { symbol: 'BAJFINANCE', companyName: 'Bajaj Finance',              aliases: ['Bajaj Finance', 'Bajaj Finance Ltd'] },
  { symbol: 'HCLTECH',    companyName: 'HCL Technologies',           aliases: ['HCL Technologies', 'HCL Tech'] },
  { symbol: 'TATAMOTORS', companyName: 'Tata Motors',                aliases: ['Tata Motors', 'Tata Motors Ltd'] },
  { symbol: 'WIPRO',      companyName: 'Wipro',                      aliases: ['Wipro', 'Wipro Ltd'] },
  { symbol: 'KOTAKBANK',  companyName: 'Kotak Mahindra Bank',        aliases: ['Kotak Mahindra Bank', 'Kotak Bank'] },
  { symbol: 'TATASTEEL',  companyName: 'Tata Steel',                 aliases: ['Tata Steel', 'Tata Steel Ltd'] },
  { symbol: 'NTPC',       companyName: 'NTPC',                       aliases: ['NTPC', 'NTPC Ltd'] },
  { symbol: 'ADANIPORTS', companyName: 'Adani Ports',                aliases: ['Adani Ports', 'Adani Ports and Special Economic Zone'] },
]

// Per-company news fetch timeout (ms) — prevents one slow upstream stalling the build
const COMPANY_FETCH_TIMEOUT_MS = 12_000
// Price fetch timeout per stock
const PRICE_FETCH_TIMEOUT_MS = 6_000

/* ─────────────────────────────────────────────
   MARKET STATE
───────────────────────────────────────────── */
const IST_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function getIndianMarketState(now = new Date()) {
  const parts = IST_PARTS_FORMATTER.formatToParts(now)
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const weekday = map.weekday
  const hour = Number(map.hour)
  const minute = Number(map.minute)
  const mins = hour * 60 + minute
  const isWeekend = weekday === 'Sat' || weekday === 'Sun'
  const sessionOpen = 9 * 60 + 15
  const sessionClose = 15 * 60 + 30

  if (isWeekend) {
    return { isOpen: false, session: 'closed', label: 'Weekend watch', refreshMs: 60 * 60 * 1000, reason: 'weekend', istTime: `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}` }
  }
  if (mins < sessionOpen) {
    return { isOpen: false, session: 'pre_market', label: 'Pre-market watch', refreshMs: 10 * 60 * 1000, reason: 'pre_open', istTime: `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}` }
  }
  if (mins <= sessionClose) {
    return { isOpen: true, session: 'market_live', label: 'Live market watch', refreshMs: 15 * 60 * 1000, reason: 'market_open', istTime: `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}` }
  }
  return { isOpen: false, session: 'post_market', label: 'Post-market watch', refreshMs: 20 * 60 * 1000, reason: 'post_market', istTime: `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}` }
}

/* ─────────────────────────────────────────────
   SCORING
───────────────────────────────────────────── */
function calculateRecencyPoints(datetime) {
  if (!datetime) return 0
  const ageHours = (Date.now() - Number(datetime) * 1000) / (1000 * 60 * 60)
  if (ageHours <= 6)  return 10
  if (ageHours <= 24) return 7
  if (ageHours <= 48) return 4
  if (ageHours <= 72) return 2
  return 0
}

const HIGH_IMPACT_KEYWORDS = [
  'results', 'earnings', 'profit', 'loss', 'order', 'deal', 'stake',
  'guidance', 'dividend', 'approval', 'acquisition', 'merger', 'investigation',
  'penalty', 'default', 'target price', 'upgrade', 'downgrade', 'buyback',
  'fund raise', 'capex', 'shareholding', 'contract', 'revenue',
]

function calculateCatalystPoints(text, session) {
  const lower = String(text || '').toLowerCase()
  let score = 0
  for (const kw of HIGH_IMPACT_KEYWORDS) {
    if (lower.includes(kw)) score += 2
  }
  if (session === 'pre_market' && /today|ahead of|before market|opens/i.test(lower)) score += 2
  if (session === 'post_market' && /after market|after close|closing bell/i.test(lower)) score += 2
  return score
}

function calculateSentimentPoints(sentiment) {
  return sentiment === 'positive' || sentiment === 'negative' ? 6 : 2
}

function buildWatchReason(sentiment, session) {
  const sentimentMap = {
    positive: 'Positive news flow',
    negative: 'Negative news flow',
    neutral: 'Fresh headline activity',
  }
  const sessionMap = {
    pre_market:  'worth tracking before the opening bell',
    market_live: 'active during live session',
    post_market: 'worth reviewing after the close',
    closed:      'worth carrying into the next session',
  }
  return `${sentimentMap[sentiment] || sentimentMap.neutral} — ${sessionMap[session] || sessionMap.closed}`
}

/* ─────────────────────────────────────────────
   PRICE ENRICHMENT
───────────────────────────────────────────── */
async function safeQuote(symbol) {
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('price timeout')), PRICE_FETCH_TIMEOUT_MS)
    )
    return await Promise.race([fetchQuoteBasic(symbol), timeoutPromise])
  } catch {
    return { currentPrice: null, previousClose: null, dayChangePct: null }
  }
}

async function enrichWithPrices(items) {
  const quotes = await Promise.all(items.map((item) => safeQuote(item.symbol)))
  return items.map((item, i) => ({
    ...item,
    currentPrice: quotes[i].currentPrice,
    dayChangePct: quotes[i].dayChangePct,
  }))
}

/* ─────────────────────────────────────────────
   WATCHLIST BUILD
───────────────────────────────────────────── */
async function fetchCompanyNewsSafe(company, marketState) {
  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve(null), COMPANY_FETCH_TIMEOUT_MS)
  )
  const fetchPromise = (async () => {
    try {
      const items = await fetchCompanyNews(company.symbol, {
        includeMeta: false,
        companyName: company.companyName,
        aliases: company.aliases,
        // Open-web RSS fetch — no domain restriction (handled in newsService).
        // trustedOnly filters the *results* by source name so watchlist only
        // surfaces credible outlets, without limiting which sources we search.
        trustedOnly: true,
        strictEntity: true,
        requireHeadlineAlias: true,
        requireCatalyst: true,
        maxAgeHours: 72,           // tightened: 3 days matches scorer's primary window
      })
      const topNews = items[0]
      if (!topNews) return null

      const sentiment = classifySentiment(`${topNews.headline} ${topNews.summary || ''}`)
      const text = `${topNews.headline} ${topNews.summary || ''}`
      const score =
        calculateRecencyPoints(topNews.datetime) +
        calculateCatalystPoints(text, marketState.session) +
        calculateSentimentPoints(sentiment) +
        Math.min(items.length, 5)

      return { symbol: company.symbol, companyName: company.companyName, score, sentiment, newsCount: items.length, topNews }
    } catch (err) {
      console.warn(`[newsWatchlist] skipped ${company.symbol}: ${err.message}`)
      return null
    }
  })()

  return Promise.race([fetchPromise, timeoutPromise])
}

async function buildNewsWatchlist(marketState) {
  const candidates = await Promise.all(
    WATCHLIST_UNIVERSE.map((company) => fetchCompanyNewsSafe(company, marketState))
  )

  const ranked = candidates
    .filter(Boolean)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return (b.topNews?.datetime || 0) - (a.topNews?.datetime || 0)
    })
    .slice(0, 5)

  const items = ranked.map((entry, index) => ({
    rank: index + 1,
    symbol: entry.symbol,
    companyName: entry.companyName,
    sentiment: entry.sentiment,
    score: entry.score,
    newsCount: entry.newsCount,
    reason: buildWatchReason(entry.sentiment, marketState.session),
    // Prices will be enriched below
    currentPrice: null,
    dayChangePct: null,
    headline: entry.topNews.headline,
    summary: entry.topNews.summary,
    source: entry.topNews.source,
    url: entry.topNews.url,
    datetime: entry.topNews.datetime,
  }))

  // Enrich with live prices (non-blocking — failures return null gracefully)
  const enriched = await enrichWithPrices(items)

  console.log(`[newsWatchlist] built ${enriched.length} items, session=${marketState.session}, refreshMs=${marketState.refreshMs}`)

  return {
    marketState,
    updatedAt: new Date().toISOString(),
    items: enriched,
  }
}

/* ─────────────────────────────────────────────
   CACHE  (stale-while-revalidate)
───────────────────────────────────────────── */
const watchlistCache = {
  value: null,
  expiresAt: 0,
  sessionKey: null,
}
let watchlistInFlight = null

function cacheIsValid(marketState, now = Date.now()) {
  return (
    watchlistCache.value !== null &&
    watchlistCache.sessionKey === marketState.session &&
    watchlistCache.expiresAt > now
  )
}

function cacheIsStale(marketState) {
  // Stale = we have something, but it's expired or from a different session
  return watchlistCache.value !== null && !cacheIsValid(marketState)
}

function triggerBackgroundRefresh(marketState) {
  if (watchlistInFlight) return // already rebuilding
  watchlistInFlight = buildNewsWatchlist(marketState)
    .then((payload) => {
      watchlistCache.value = payload
      watchlistCache.sessionKey = marketState.session
      watchlistCache.expiresAt = Date.now() + marketState.refreshMs
    })
    .catch((err) => {
      console.error('[newsWatchlist] background refresh failed:', err.message)
    })
    .finally(() => {
      watchlistInFlight = null
    })
}

/* ─────────────────────────────────────────────
   ROUTES
───────────────────────────────────────────── */

// GET /api/news?symbol=RELIANCE
router.get('/', async (req, res) => {
  const { symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol is required' })
  try {
    const items = await fetchCompanyNews(symbol)
    const top = items[0]
    const sentiment = top ? classifySentiment(`${top.headline} ${top.summary || ''}`) : 'neutral'
    res.json({ symbol, count: items.length, items, sentiment })
  } catch (e) {
    res.status(500).json({ error: e.message || 'failed to fetch news' })
  }
})

// GET /api/news/watchlist?force=true  → busts cache, waits for fresh build
// GET /api/news/watchlist             → stale-while-revalidate (normal path)
router.get('/watchlist', async (req, res) => {
  const marketState = getIndianMarketState()
  const now = Date.now()
  const force = req.query.force === 'true'

  // Force-refresh: invalidate cache and rebuild synchronously
  if (force) {
    watchlistCache.value = null
    watchlistCache.expiresAt = 0
    watchlistCache.sessionKey = null
    if (watchlistInFlight) {
      // A rebuild is already running — wait for it rather than spawning another
      try {
        const payload = await watchlistInFlight
        return res.json({ ...payload, stale: false, forced: true })
      } catch (e) {
        return res.status(500).json({ error: e.message || 'Refresh failed' })
      }
    }
  }

  // ① Fresh cache — serve immediately
  if (!force && cacheIsValid(marketState, now)) {
    return res.json({ ...watchlistCache.value, stale: false })
  }

  // ② Stale cache — serve stale immediately and rebuild in background
  if (!force && cacheIsStale(marketState)) {
    triggerBackgroundRefresh(marketState)
    return res.json({ ...watchlistCache.value, stale: true })
  }

  // ③ No cache (or force=true) — build now
  try {
    if (!watchlistInFlight) {
      watchlistInFlight = buildNewsWatchlist(marketState).finally(() => {
        watchlistInFlight = null
      })
    }
    const payload = await watchlistInFlight
    watchlistCache.value = payload
    watchlistCache.sessionKey = marketState.session
    watchlistCache.expiresAt = now + marketState.refreshMs
    res.json({ ...payload, stale: false, ...(force && { forced: true }) })
  } catch (e) {
    console.error('[newsWatchlist] cold build failed:', e.message)
    res.status(500).json({ error: e.message || 'failed to build watchlist' })
  }
})

export default router
