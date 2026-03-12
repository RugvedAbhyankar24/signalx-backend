import fetch from 'node-fetch'

const ZERODHA_EQUITY_MARGIN_URL = 'https://zerodha.com/margin-calculator/Equity/'
const CACHE_TTL_MS = Math.max(60_000, Number(process.env.ZERODHA_LEVERAGE_CACHE_TTL_MS || 15 * 60 * 1000))

const leverageCache = {
  fetchedAt: 0,
  symbols: new Map(),
}

function normalizeSymbol(symbol) {
  return String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\.NS$|\.BO$/g, '')
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2f;/gi, '/')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function parseLeverageTable(html) {
  const stripped = decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(tr|td|th|p|div|li|section|article|br|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')

  const normalizedText = stripped.replace(/\n+/g, '\n')
  const rows = normalizedText
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean)

  const parsed = new Map()
  const rowPattern = /\b([A-Z][A-Z0-9&.-]{1,24})\b\s+(\d{1,3}(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)x\b/g

  for (const row of rows) {
    rowPattern.lastIndex = 0
    let match
    while ((match = rowPattern.exec(row)) !== null) {
      const symbol = normalizeSymbol(match[1])
      const marginPct = Number(match[2])
      const leverageMultiplier = Number(match[3])

      if (!symbol || !Number.isFinite(marginPct) || !Number.isFinite(leverageMultiplier)) continue
      if (marginPct <= 0 || marginPct > 100 || leverageMultiplier < 1 || leverageMultiplier > 20) continue

      parsed.set(symbol, {
        symbol,
        marginPct,
        leverageMultiplier,
        source: 'zerodha',
      })
    }
  }

  if (parsed.size > 0) return parsed

  rowPattern.lastIndex = 0
  let fallbackMatch
  while ((fallbackMatch = rowPattern.exec(normalizedText)) !== null) {
    const symbol = normalizeSymbol(fallbackMatch[1])
    const marginPct = Number(fallbackMatch[2])
    const leverageMultiplier = Number(fallbackMatch[3])

    if (!symbol || !Number.isFinite(marginPct) || !Number.isFinite(leverageMultiplier)) continue
    if (marginPct <= 0 || marginPct > 100 || leverageMultiplier < 1 || leverageMultiplier > 20) continue

    parsed.set(symbol, {
      symbol,
      marginPct,
      leverageMultiplier,
      source: 'zerodha',
    })
  }

  return parsed
}

async function refreshLeverageCache() {
  const response = await fetch(ZERODHA_EQUITY_MARGIN_URL, {
    headers: {
      'user-agent': 'SignalX/1.0 (+paper-trading leverage fetch)',
      accept: 'text/html,application/xhtml+xml',
    },
  })

  if (!response.ok) {
    throw new Error(`Zerodha leverage fetch failed (${response.status})`)
  }

  const html = await response.text()
  const parsed = parseLeverageTable(html)
  if (parsed.size === 0) {
    throw new Error('No leverage rows parsed from Zerodha margin page')
  }

  leverageCache.fetchedAt = Date.now()
  leverageCache.symbols = parsed
  return leverageCache.symbols
}

async function getLeverageDataset() {
  const isFresh = leverageCache.symbols.size > 0 && Date.now() - leverageCache.fetchedAt < CACHE_TTL_MS
  if (isFresh) return leverageCache.symbols

  try {
    return await refreshLeverageCache()
  } catch (error) {
    if (leverageCache.symbols.size > 0) {
      console.error('Using stale Zerodha leverage cache:', error.message)
      return leverageCache.symbols
    }
    throw error
  }
}

export async function getIntradayLeverageForSymbols(symbols = []) {
  const dataset = await getLeverageDataset()
  const results = new Map()

  for (const rawSymbol of symbols) {
    const symbol = normalizeSymbol(rawSymbol)
    if (!symbol) continue

    const record = dataset.get(symbol)
    results.set(symbol, {
      symbol,
      marginPct: record?.marginPct ?? 100,
      leverageMultiplier: record?.leverageMultiplier ?? 1,
      source: record?.source || 'fallback',
      asOf: new Date(leverageCache.fetchedAt || Date.now()).toISOString(),
    })
  }

  return results
}
