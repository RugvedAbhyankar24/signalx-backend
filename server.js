import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import newsRouter from './routes/news.js';
import scanRouter from './routes/scan.js';
import tickerRouter from './routes/ticker.js';
import marketRoutes from './routes/market.js';
import intradayRouter from './routes/intraday.js';
import swingRouter from './routes/swing.js';
import { startIntradayAutoUploader } from './services/intradayAutoUploader.js';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://signalxfrontend.vercel.app'
];

const configuredOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const allowedOrigins = configuredOrigins.length ? configuredOrigins : DEFAULT_ALLOWED_ORIGINS;

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser requests (curl/postman/server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
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
  if (err?.message === 'Origin not allowed by CORS') {
    return res.status(403).json({ error: 'Forbidden origin' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const server = app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  startIntradayAutoUploader({ port: PORT });
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the existing process or set a different PORT.`);
    process.exit(1);
  }

  console.error('Server startup failed:', error);
  process.exit(1);
});
