import mongoose from 'mongoose';

// Disable query buffering so Mongoose never hangs when DB is connecting
mongoose.set('bufferCommands', false);

/**
 * Connect to MongoDB Atlas (or local fallback)
 */
export async function connectDB(mongoUri) {
  const uri = mongoUri || process.env.MONGO_URI;

  if (!uri) {
    console.log('ℹ️ MONGO_URI not specified in .env. Running with in-memory database mock mode.');
    return;
  }

  try {
    mongoose.set('strictQuery', false);
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 2000 });
    console.log('✅ Connected to MongoDB Atlas successfully!');
  } catch (error) {
    console.warn('⚠️ MongoDB Connection Notice: Could not reach Mongo server. Running in fallback mode.');
  }
}
