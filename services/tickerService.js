import { fetchNSE, fetchIndexOHLC } from './marketData.js'

const INDICES = [
  'NIFTY 50',
  'SENSEX',
  'NIFTY BANK',
  'NIFTY FINANCIAL SERVICES',
  'NIFTY MIDCAP SELECT',
  'INDIA VIX',
  'NIFTY TOTAL MARKET',
  'NIFTY NEXT 50',
  'NIFTY 100',
  'NIFTY MIDCAP 100',
  'NIFTY AUTO',
  'NIFTY SMALLCAP 100',
  'NIFTY FMCG',
  'NIFTY METAL',
  'NIFTY PSU BANK',
  'NIFTY PHARMA',
  'NIFTY SMALLCAP 250',
  'NIFTY MIDCAP 150',
  'NIFTY COMMODITIES'
]

/* ============================
   INDICES SNAPSHOT
============================ */
export async function fetchIndicesSnapshot() {
  try {
    // Fetch NSE indices
    const nseRes = await fetchNSE('/allIndices')
    const nseRows = nseRes?.data || []

    // Fetch Sensex data separately
    let sensexData = null
    try {
      sensexData = await fetchIndexOHLC('SENSEX')
    } catch (sensexError) {
      console.log('Sensex data fetch failed:', sensexError.message)
    }

    // Process NSE indices (excluding SENSEX since we handle it separately)
    const nseIndices = nseRows
      .filter(i => INDICES.includes(i.index) && i.index !== 'SENSEX')
      .map(i => {
        const last = Number(i.last)
        const prev = Number(i.previousClose)

        let changePct = null
        let direction = 'neutral'

        if (Number.isFinite(last) && Number.isFinite(prev) && prev > 0) {
          changePct = ((last - prev) / prev) * 100
          direction =
            changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'neutral'
        }

        return {
          name: i.index,
          last,
          changePct,
          direction
        }
      })

    // Add Sensex data if available
    const allIndices = [...nseIndices]
    if (sensexData) {
      const sensexChangePct = sensexData.changePct
      const sensexDirection = sensexChangePct > 0 ? 'up' : sensexChangePct < 0 ? 'down' : 'neutral'
      
      allIndices.push({
        name: 'SENSEX',
        last: sensexData.last,
        changePct: sensexChangePct,
        direction: sensexDirection
      })
    }

    // Sort indices according to INDICES array order
    allIndices.sort((a, b) => {
      const indexA = INDICES.indexOf(a.name)
      const indexB = INDICES.indexOf(b.name)
      return indexA - indexB
    })

    return allIndices
  } catch (error) {
    console.error('Error fetching indices snapshot:', error)
    return []
  }
}


/* ============================
   TOP GAINERS / LOSERS (NIFTY 500)
============================ */
export async function fetchTopMovers() {
  const res = await fetchNSE('/equity-stockIndices?index=NIFTY%20500')
  const rows = res?.data || []

  const stocks = rows
    .map(s => {
      const last = Number(s.lastPrice)
      const prev = Number(s.previousClose)

      if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) {
        return null
      }

      const changePct = ((last - prev) / prev) * 100

      return {
        symbol: s.symbol,
        price: last,
        changePct
      }
    })
    .filter(Boolean)

  if (!stocks.length) {
    return { gainers: [], losers: [] }
  }

  const sorted = [...stocks].sort(
    (a, b) => b.changePct - a.changePct
  )

  return {
    gainers: sorted.slice(0, 5),
    losers: sorted.slice(-5).reverse()
  }
}


