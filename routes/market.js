import express from 'express'
import { createRateLimiter } from '../middleware/rateLimit.js'
import { fetchGapData, fetchIndexOHLC, resolveNSESymbol } from '../services/marketData.js'

const router = express.Router()
const resolvedSymbolCache = new Map()
const RESOLVED_SYMBOL_TTL_MS = 6 * 60 * 60 * 1000
const quotesLimiter = createRateLimiter({
  windowMs: Number(process.env.QUOTE_RATE_LIMIT_WINDOW_MS || 10_000),
  max: Number(process.env.QUOTE_RATE_LIMIT_MAX || 30),
  keyFn: (req) => `${req.ip}:market:quotes`,
  message: 'Too many quote refresh requests.',
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
  try {
    const [nifty, bankNifty, sensex] = await Promise.all([
      fetchIndexOHLC('NIFTY 50'),
      fetchIndexOHLC('NIFTY BANK'),
      fetchIndexOHLC('SENSEX')
    ])

    res.json({
      nifty50: nifty,
      bankNifty,
      sensex,
      timestamp: new Date()
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Market data unavailable' })
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


export default router
