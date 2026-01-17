import express from 'express'
import { fetchIndicesSnapshot, fetchTopMovers } from '../services/tickerService.js'

const router = express.Router()

router.get('/', async (req, res) => {
  try {
    const indices = await fetchIndicesSnapshot()
    const { gainers, losers } = await fetchTopMovers()

    res.json({
      indices,
      gainers,
      losers
    })
  } catch (e) {
    res.status(500).json({ error: 'Ticker fetch failed' })
  }
})

export default router
