import express from 'express'
import { fetchIndexOHLC } from '../services/marketData.js'

const router = express.Router()

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


export default router
