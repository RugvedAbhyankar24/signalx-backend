import express from 'express'
import { fetchIndicesSnapshot, fetchTopMovers } from '../services/tickerService.js'

const router = express.Router()

router.get('/', async (req, res) => {
  const [indicesRes, moversRes] = await Promise.allSettled([
    fetchIndicesSnapshot(),
    fetchTopMovers()
  ])

  const indices = indicesRes.status === 'fulfilled' ? (indicesRes.value ?? []) : []
  const movers  = moversRes.status  === 'fulfilled' ? (moversRes.value  ?? {}) : {}

  if (indicesRes.status === 'rejected') console.warn('[ticker] indices failed:', indicesRes.reason?.message)
  if (moversRes.status  === 'rejected') console.warn('[ticker] movers failed:',  moversRes.reason?.message)

  res.json({
    indices,
    gainers: movers.gainers ?? [],
    losers:  movers.losers  ?? []
  })
})

export default router
