import { Worker } from "bullmq";
import { config } from "./config.js";
import { initDatabase, closeDatabase, setJobStatus } from "./db.js";
import { initStorage } from "./storage/localStorage.js";
import { redisConnection } from "./queue.js";
import { processTranscriptionJob } from "./processJob.js";

await initDatabase();
await initStorage();

const worker = new Worker(
  "audio-transcriptions",
  async (queueJob) => {
    await processTranscriptionJob(queueJob.data.jobId);
  },
  {
    connection: redisConnection,
    concurrency: config.workerConcurrency,
  },
);

worker.on("completed", (job) => {
  console.log(`Queue job ${job.id} completed.`);
});

worker.on("failed", async (job, error) => {
  console.error(`Queue job ${job?.id} failed: ${error.message}`);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await setJobStatus(job.data.jobId, "failed", error.message).catch(console.error);
  }
});

async function shutdown() {
  console.log("Shutting down transcription worker...");
  await worker.close();
  await redisConnection.quit();
  await closeDatabase();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Transcription worker started (concurrency=${config.workerConcurrency}).`);
