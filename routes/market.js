import express from 'express'
import { createRateLimiter } from '../middleware/rateLimit.js'
import { fetchGapData, fetchIndexOHLC, fetchNSE, resolveNSESymbol } from '../services/marketData.js'
import { getIntradayLeverageForSymbols } from '../services/leverageService.js'
import { fetchStructuredEventCalendar } from '../services/eventCalendarService.js'
import { fetchInstitutionalFlowSnapshot, fetchMarketActivityProfile } from '../services/marketActivityService.js'

const router = express.Router()

// ── Holiday cache ─────────────────────────────────────────────────────────────
let _holidayCache = null      // { holidays: ['YYYY-MM-DD', ...], fetchedAt: number }
const HOLIDAY_CACHE_TTL_MS = 12 * 60 * 60 * 1000  // 12 hours

/**
 * Parse NSE tradingDate string ("26-Jan-2026") → "2026-01-26".
 * Returns null if the string can't be parsed.
 */
function parseTradingDate(str) {
  if (!str || typeof str !== 'string') return null
  const MON = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5,
                Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 }
  const parts = str.trim().split('-')
  if (parts.length !== 3) return null
  const [dd, mon, yyyy] = parts
  const m = MON[mon]
  if (m === undefined) return null
  const d = new Date(Date.UTC(parseInt(yyyy, 10), m, parseInt(dd, 10)))
  if (isNaN(d)) return null
  return d.toISOString().slice(0, 10)   // "YYYY-MM-DD"
}

router.get('/holidays', async (req, res) => {
  const now = Date.now()

  // Serve from cache if still fresh
  if (_holidayCache && now - _holidayCache.fetchedAt < HOLIDAY_CACHE_TTL_MS) {
    return res.json(_holidayCache)
  }

  try {
    const raw = await fetchNSE('/holiday-master?type=trading')

    // NSE response shape: { CM: [...], FO: [...], CD: [...], ... }
    // CM = Capital Market segment — the one that governs equity trading
    const cmRows = Array.isArray(raw?.CM) ? raw.CM : []

    const holidays = cmRows
      .map(row => parseTradingDate(row?.tradingDate))
      .filter(Boolean)
      .sort()

    _holidayCache = { holidays, fetchedAt: now }
    res.json(_holidayCache)
  } catch (err) {
    console.error('[market/holidays] NSE fetch failed:', err.message)
    // Return whatever we have cached (even if stale) so the frontend isn't empty-handed
    if (_holidayCache) return res.json({ ..._holidayCache, stale: true })
    // Absolute fallback — empty list (weekend guard still works)
    res.json({ holidays: [], fetchedAt: now, error: 'NSE unavailable' })
  }
})

const resolvedSymbolCache = new Map()
const RESOLVED_SYMBOL_TTL_MS = 6 * 60 * 60 * 1000
const quotesLimiter = createRateLimiter({
  windowMs: Number(process.env.QUOTE_RATE_LIMIT_WINDOW_MS || 10_000),
  max: Number(process.env.QUOTE_RATE_LIMIT_MAX || 30),
  keyFn: (req) => `${req.ip}:market:quotes`,
  message: 'Too many quote refresh requests.',
})
const leverageLimiter = createRateLimiter({
  windowMs: Number(process.env.LEVERAGE_RATE_LIMIT_WINDOW_MS || 15_000),
  max: Number(process.env.LEVERAGE_RATE_LIMIT_MAX || 24),
  keyFn: (req) => `${req.ip}:market:leverage`,
  message: 'Too many leverage refresh requests.',
})

async function resolveCachedSymbol(symbol) {
  const key = String(symbol || '').trim().toUpperCase()
  const cached = resolvedSymbolCache.get(key)
  const now = Date.now()

  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const resolved = await resolveNSESymbol(key)
  resolvedSymbolCache.set(key, {
    value: resolved,
    expiresAt: now + RESOLVED_SYMBOL_TTL_MS,
  })
  return resolved
}

router.get('/indices', async (req, res) => {
  const [niftyRes, bankNiftyRes, sensexRes] = await Promise.allSettled([
    fetchIndexOHLC('NIFTY 50'),
    fetchIndexOHLC('NIFTY BANK'),
    fetchIndexOHLC('SENSEX')
  ])

  const unwrap = (r, label) => {
    if (r.status === 'fulfilled') return r.value
    console.warn(`[market/indices] ${label} failed:`, r.reason?.message)
    return null
  }

  res.json({
    nifty50:   unwrap(niftyRes,    'NIFTY 50'),
    bankNifty: unwrap(bankNiftyRes,'NIFTY BANK'),
    sensex:    unwrap(sensexRes,   'SENSEX'),
    timestamp: new Date()
  })
})

router.get('/events', async (req, res) => {
  const symbol = String(req.query?.symbol || '').trim().toUpperCase()

  try {
    const calendar = await fetchStructuredEventCalendar(symbol || null)
    res.json(calendar)
  } catch (error) {
    console.error('market event calendar error', error)
    res.status(500).json({ error: 'Failed to fetch event calendar' })
  }
})

router.get('/activity', async (req, res) => {
  const symbol = String(req.query?.symbol || '').trim().toUpperCase()
  const biasDirection = String(req.query?.biasDirection || 'long').trim().toLowerCase() === 'short' ? 'short' : 'long'

  try {
    if (!symbol) {
      const flow = await fetchInstitutionalFlowSnapshot()
      return res.json({
        symbol: null,
        flow,
        updatedAt: new Date().toISOString(),
      })
    }

    const activity = await fetchMarketActivityProfile(symbol, { biasDirection })
    res.json({
      ...activity,
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('market activity error', error)
    res.status(500).json({ error: 'Failed to fetch market activity' })
  }
})

router.post('/quotes', quotesLimiter, async (req, res) => {
  const inputSymbols = Array.isArray(req.body?.symbols) ? req.body.symbols : []
  const symbols = Array.from(
    new Set(
      inputSymbols
        .map((symbol) => String(symbol || '').trim().toUpperCase())
        .filter(Boolean)
    )
  ).slice(0, 25)

  if (symbols.length === 0) {
    return res.status(400).json({ error: 'symbols array is required' })
  }

  try {
    const results = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const resolvedSymbol = await resolveCachedSymbol(symbol)
          const gapData = await fetchGapData(resolvedSymbol)

          return {
            symbol,
            resolvedSymbol,
            companyName: gapData.companyName || symbol,
            currentPrice: gapData.currentPrice,
            priceSource: gapData.priceSource,
            updatedAt: new Date().toISOString(),
          }
        } catch (error) {
          return {
            symbol,
            error: error.message || 'Failed to fetch quote',
          }
        }
      })
    )

    res.json({
      results,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('quote refresh error', error)
    res.status(500).json({ error: 'Failed to refresh quotes' })
  }
})

router.post('/leverage', leverageLimiter, async (req, res) => {
  const inputSymbols = Array.isArray(req.body?.symbols) ? req.body.symbols : []
  const symbols = Array.from(
    new Set(
      inputSymbols
        .map((symbol) => String(symbol || '').trim().toUpperCase())
        .filter(Boolean)
    )
  ).slice(0, 50)

  if (symbols.length === 0) {
    return res.status(400).json({ error: 'symbols array is required' })
  }

  try {
    const leverageMap = await getIntradayLeverageForSymbols(symbols)
    const results = symbols.map((symbol) => leverageMap.get(symbol) || {
      symbol,
      marginPct: 100,
      leverageMultiplier: 1,
      source: 'fallback',
      asOf: new Date().toISOString(),
    })

    res.json({
      results,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('leverage refresh error', error)
    res.status(500).json({ error: 'Failed to refresh leverage data' })
  }
})


export default router
