import mongoose from 'mongoose';

const intradaySignalSnapshotSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    createdAt: { type: Date, required: true, default: Date.now, index: true },
    istDate: { type: String, required: true, index: true },
    istTime: { type: String, required: true },
    totalScanned: { type: Number, default: 0 },
    positiveCount: { type: Number, default: 0 },
    qualityScore: { type: Number, default: 0, index: true },
    picks: { type: [mongoose.Schema.Types.Mixed], default: [] },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    rawPayload: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  {
    versionKey: false,
    collection: 'intraday_signal_snapshots'
  }
);

export const IntradaySignalSnapshot =
  mongoose.models.IntradaySignalSnapshot ||
  mongoose.model('IntradaySignalSnapshot', intradaySignalSnapshotSchema);
