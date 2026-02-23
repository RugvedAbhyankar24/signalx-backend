import mongoose from 'mongoose';

const intradayBacktestRunSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    createdAt: { type: Date, required: true, default: Date.now, index: true },
    tradeDate: { type: String, required: true, index: true },
    capital: { type: Number, required: true },
    allocationMode: { type: String, required: true },
    snapshotMode: { type: String, required: true },
    snapshotId: { type: String, required: true, index: true },
    snapshotCreatedAt: { type: Date, required: true },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
    trades: { type: [mongoose.Schema.Types.Mixed], default: [] }
  },
  {
    versionKey: false,
    collection: 'intraday_backtest_runs'
  }
);

export const IntradayBacktestRun =
  mongoose.models.IntradayBacktestRun ||
  mongoose.model('IntradayBacktestRun', intradayBacktestRunSchema);
