import express from 'express'
import { fetchCompanyNews, classifySentiment } from '../services/newsService.js'

const router = express.Router()

// GET /api/news?symbol=RELIANCE
router.get('/', async (req, res) => {
  const { symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol is required' })
  try {
    const items = await fetchCompanyNews(symbol)
    const top = items[0]
    const sentiment = top ? classifySentiment(`${top.headline} ${top.summary || ''}`) : 'neutral'
    res.json({ symbol, count: items.length,items, sentiment })
  } catch (e) {
    res.status(500).json({ error: e.message || 'failed to fetch news' })
  }
})

export default router
