import { fetchNSE, fetchIndexOHLC, fetchAllIndicesCached } from './marketData.js'

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
    const nseRes = await fetchAllIndicesCached()
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


function normalizeMover(row) {
  const symbol = row?.symbol
  const price = Number(row?.ltp ?? row?.lastPrice)
  const changePct = Number(row?.perChange ?? row?.net_price ?? row?.pChange)

  if (!symbol || !Number.isFinite(price) || !Number.isFinite(changePct)) {
    return null
  }

  return {
    symbol,
    price,
    changePct
  }
}

/* ============================
   TOP GAINERS / LOSERS
   Uses NSE's stable live movers feed.
============================ */
export async function fetchTopMovers() {
  try {
    const [gainersRes, losersRes] = await Promise.all([
      fetchNSE('/live-analysis-variations?index=gainers'),
      fetchNSE('/live-analysis-variations?index=losers')
    ])

    const gainers = (gainersRes?.allSec?.data || [])
      .map(normalizeMover)
      .filter(Boolean)
      .slice(0, 5)

    const losers = (losersRes?.allSec?.data || [])
      .map(normalizeMover)
      .filter(Boolean)
      .slice(0, 5)

    return { gainers, losers }
  } catch (error) {
    console.error('Error fetching top movers:', error)
    return { gainers: [], losers: [] }
  }
}
