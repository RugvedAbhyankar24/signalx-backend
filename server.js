import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import newsRouter from './routes/news.js';
import scanRouter from './routes/scan.js';
import tickerRouter from './routes/ticker.js';
import marketRoutes from './routes/market.js';
import intradayRouter from './routes/intraday.js';
import swingRouter from './routes/swing.js';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Smart Gap Trade Backend' });
});

app.use('/api/scan', scanRouter);
app.use('/api/news', newsRouter);
app.use('/api/ticker', tickerRouter);
app.use('/api/market', marketRoutes);
app.use('/api/intraday', intradayRouter);
app.use('/api/swing', swingRouter);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
