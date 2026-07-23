import mongoose from 'mongoose';

const botSchema = new mongoose.Schema({
  botId: { type: String, required: true, unique: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['zip', 'github'], default: 'zip' },
  sourceUrl: { type: String }, // Zip filename or Github repo URL
  envVars: { type: Map, of: String, default: {} },
  ramLimitMB: { type: Number, default: 128 }, // Default 128MB RAM tier
  status: { type: String, enum: ['STOPPED', 'BUILDING', 'RUNNING', 'ERROR'], default: 'STOPPED' },
  securityStatus: { type: String, enum: ['CLEAN', 'SCANNING', 'INFECTED'], default: 'SCANNING' },
  securityHash: { type: String },
  securityMessage: { type: String, default: 'Pending scan' },
  logs: [{ type: String }],
  createdAt: { type: Date, default: Date.now }
});

export const Bot = mongoose.model('Bot', botSchema);
