import "dotenv/config";
import path from "node:path";

const numberFromEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: numberFromEnv("PORT", 3000),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://transcriber:transcriber_password@localhost:5432/transcriptions",
  redis: {
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: numberFromEnv("REDIS_PORT", 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  openAiApiKey: process.env.OPENAI_API_KEY ?? "",
  transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL ?? "whisper-1",
  apiKey: process.env.API_KEY ?? "",
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  uploadMaxBytes: numberFromEnv("UPLOAD_MAX_MB", 100) * 1024 * 1024,
  chunkSeconds: numberFromEnv("CHUNK_SECONDS", 300),
  workerConcurrency: numberFromEnv("WORKER_CONCURRENCY", 2),
  transcriptionMaxAttempts: numberFromEnv("TRANSCRIPTION_MAX_ATTEMPTS", 3),
  queueMaxAttempts: numberFromEnv("QUEUE_MAX_ATTEMPTS", 3),
  retryBaseDelayMs: numberFromEnv("RETRY_BASE_DELAY_MS", 1000),
};

if (config.nodeEnv === "production" && !config.apiKey) {
  throw new Error("API_KEY must be set in production.");
}
