import IORedis from "ioredis";
import { Queue } from "bullmq";
import { config } from "./config.js";

export const redisConnection = new IORedis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

export const transcriptionQueue = new Queue("audio-transcriptions", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: config.queueMaxAttempts,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});
