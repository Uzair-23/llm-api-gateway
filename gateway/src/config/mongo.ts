import mongoose from 'mongoose';
import { env } from './env';

/**
 * Mongoose connection singleton.
 * Tests use mongodb-memory-server and call `connectMongo(uri)` directly with
 * the in-memory URI, so this module does NOT auto-connect on import.
 */
export async function connectMongo(uri: string = env.MONGO_URI): Promise<typeof mongoose> {
  return mongoose.connect(uri);
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

export default mongoose;
