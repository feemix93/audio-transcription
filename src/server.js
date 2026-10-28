import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "./config.js";
import { initDatabase, createJob, getJob, setJobStatus, pool, closeDatabase } from "./db.js";
import { initStorage, getTempDir, storeUpload } from "./storage/localStorage.js";
import { ALLOWED_EXTENSIONS, extensionOf } from "./audio/media.js";
import { redisConnection, transcriptionQueue } from "./queue.js";

await initDatabase();
await initStorage();
await fs.mkdir(getTempDir(), { recursive: true });

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  dest: getTempDir(),
  limits: { fileSize: config.uploadMaxBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    const extension = extensionOf(file.originalname);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return cb(new Error(`Unsupported audio extension: ${extension || "(none)"}`));
    }
    cb(null, true);
  },
});

app.use("/api", (req, res, next) => {
  if (!config.apiKey) return next();
  const supplied = req.header("x-api-key");
  if (supplied !== config.apiKey) {
    return res.status(401).json({ error: "Missing or invalid API key." });
  }
  next();
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    await redisConnection.ping();
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});

// POST /api/transcriptions (multipart/form-data, field name: audio)
app.post("/api/transcriptions", upload.single("audio"), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: "Upload one audio file in the 'audio' field." });
  }

  const id = crypto.randomUUID();
  const extension = extensionOf(req.file.originalname);

  try {
    const audioKey = await storeUpload(req.file.path, id, extension);
    await createJob({
      id,
      audioKey,
      originalFilename: path.basename(req.file.originalname),
    });

    try {
      await transcriptionQueue.add(
        "transcribe",
        { jobId: id },
        { jobId: `${id}-${Date.now()}` },
      );
    } catch (queueError) {
      await setJobStatus(id, "failed", "Could not enqueue transcription job.");
      throw queueError;
    }

    return res.status(202).json({
      id,
      status: "queued",
      statusUrl: `/api/transcriptions/${id}`,
      resultUrl: `/api/transcriptions/${id}/result`,
    });
  } catch (error) {
    await fs.unlink(req.file.path).catch(() => {});
    return next(error);
  }
});

// GET /api/transcriptions/:id
app.get("/api/transcriptions/:id", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Transcription job not found." });

    res.json({
      id: job.id,
      filename: job.original_filename,
      status: job.status,
      attempts: job.attempts,
      error: job.status === "failed" ? job.error_message : undefined,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      completedAt: job.completed_at,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/transcriptions/:id/result
app.get("/api/transcriptions/:id/result", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Transcription job not found." });

    if (job.status !== "completed") {
      return res.status(409).json({
        error: "Transcript is not ready.",
        status: job.status,
      });
    }

    res.json({
      id: job.id,
      text: job.transcript,
      segments: job.segments,
      completedAt: job.completed_at,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/transcriptions/:id/retry
app.post("/api/transcriptions/:id/retry", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Transcription job not found." });
    if (job.status !== "failed") {
      return res.status(409).json({
        error: "Only failed jobs can be manually retried.",
        status: job.status,
      });
    }

    await setJobStatus(job.id, "queued");
    await transcriptionQueue.add(
      "transcribe",
      { jobId: job.id },
      { jobId: `${job.id}-manual-${Date.now()}` },
    );

    res.status(202).json({ id: job.id, status: "queued" });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ error: error.message });
  }

  console.error(error);
  res.status(500).json({
    error: "Internal server error.",
    ...(config.nodeEnv === "development" ? { details: error.message } : {}),
  });
});

const server = app.listen(config.port, () => {
  console.log(`Audio transcription API listening on http://localhost:${config.port}`);
});

async function shutdown() {
  console.log("Shutting down API...");
  server.close();
  await transcriptionQueue.close().catch(() => {});
  await redisConnection.quit().catch(() => {});
  await closeDatabase().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
