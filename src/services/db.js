import mongoose from 'mongoose';

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
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB Atlas successfully!');
  } catch (error) {
    console.warn('⚠️ MongoDB Connection Notice: Could not reach Mongo server. Running in fallback mode.');
  }
}
