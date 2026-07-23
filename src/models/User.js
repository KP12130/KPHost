import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String }, // Optional if logged in via OAuth
  discordId: { type: String },
  googleId: { type: String },
  avatar: { type: String, default: 'https://cdn.discordapp.com/embed/avatars/0.png' },
  walletBalance: { type: Number, default: 5.00 }, // $5.00 free starting credit
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  createdAt: { type: Date, default: Date.now }
});

export const User = mongoose.model('User', userSchema);
