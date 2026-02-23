import mongoose from 'mongoose';

const intradayPickEntrySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    scanId: { type: String, required: true, index: true },
    createdAt: { type: Date, required: true, default: Date.now, index: true },
    istDate: { type: String, required: true, index: true },
    istTime: { type: String, required: true },
    scanType: { type: String, default: 'two-stage-institutional' },
    marketStateReason: { type: String, default: 'market_open' },
    symbol: { type: String, required: true, index: true },
    normalizedSymbol: { type: String, default: null },
    resolvedSymbol: { type: String, default: null },
    companyName: { type: String, default: null },
    entryPrice: { type: Number, required: true },
    entryType: { type: String, default: null },
    entryReason: { type: String, default: null }
  },
  {
    versionKey: false,
    collection: 'intraday_pick_entries'
  }
);

export const IntradayPickEntry =
  mongoose.models.IntradayPickEntry ||
  mongoose.model('IntradayPickEntry', intradayPickEntrySchema);
