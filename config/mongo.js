import mongoose from 'mongoose';

let connectAttempted = false;

export async function connectMongo() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || '';

  if (!mongoUri) {
    console.log('MongoDB disabled: MONGODB_URI not set. Using file storage fallback.');
    return false;
  }
  if (mongoose.connection.readyState === 1) return true;
  if (connectAttempted && mongoose.connection.readyState !== 2) {
    return mongoose.connection.readyState === 1;
  }

  connectAttempted = true;
  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 7000)
    });
    console.log('MongoDB connected');
    return true;
  } catch (error) {
    console.error('MongoDB connection failed, using file storage fallback:', error?.message || error);
    return false;
  }
}

export function isMongoConnected() {
  return mongoose.connection.readyState === 1;
}
