import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcription_jobs (
      id UUID PRIMARY KEY,
      audio_key TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
      transcript TEXT,
      segments JSONB NOT NULL DEFAULT '[]'::jsonb,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS transcription_jobs_created_at_idx
      ON transcription_jobs (created_at DESC);

    CREATE TABLE IF NOT EXISTS transcription_chunks (
      job_id UUID NOT NULL REFERENCES transcription_jobs(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      start_offset_seconds NUMERIC NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
      transcript TEXT,
      segments JSONB NOT NULL DEFAULT '[]'::jsonb,
      error_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (job_id, chunk_index)
    );
  `);
}

export async function createJob({ id, audioKey, originalFilename }) {
  await pool.query(
    `INSERT INTO transcription_jobs
       (id, audio_key, original_filename, status)
     VALUES ($1, $2, $3, 'queued')`,
    [id, audioKey, originalFilename],
  );
}

export async function getJob(id) {
  const { rows } = await pool.query(
    `SELECT id, audio_key, original_filename, status, transcript, segments,
            error_message, attempts, created_at, updated_at, completed_at
       FROM transcription_jobs WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function setJobStatus(id, status, errorMessage = null) {
  await pool.query(
    `UPDATE transcription_jobs
        SET status = $2, error_message = $3, updated_at = NOW(),
            attempts = attempts + CASE WHEN $2 = 'processing' THEN 1 ELSE 0 END,
            completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE NULL END
      WHERE id = $1`,
    [id, status, errorMessage],
  );
}

export async function saveChunkStarted(jobId, index, offset) {
  await pool.query(
    `INSERT INTO transcription_chunks
       (job_id, chunk_index, start_offset_seconds, status, error_message)
     VALUES ($1, $2, $3, 'processing', NULL)
     ON CONFLICT (job_id, chunk_index) DO UPDATE
       SET start_offset_seconds = EXCLUDED.start_offset_seconds,
           status = 'processing', error_message = NULL, updated_at = NOW()`,
    [jobId, index, offset],
  );
}

export async function saveChunkCompleted(
  jobId,
  index,
  offset,
  transcript,
  segments,
) {
  await pool.query(
    `INSERT INTO transcription_chunks
       (job_id, chunk_index, start_offset_seconds, status, transcript, segments, error_message)
     VALUES ($1, $2, $3, 'completed', $4, $5::jsonb, NULL)
     ON CONFLICT (job_id, chunk_index) DO UPDATE
       SET start_offset_seconds = EXCLUDED.start_offset_seconds,
           status = 'completed', transcript = EXCLUDED.transcript,
           segments = EXCLUDED.segments, error_message = NULL, updated_at = NOW()`,
    [jobId, index, offset, transcript, JSON.stringify(segments)],
  );
}

export async function saveChunkFailed(jobId, index, offset, errorMessage) {
  await pool.query(
    `INSERT INTO transcription_chunks
       (job_id, chunk_index, start_offset_seconds, status, error_message)
     VALUES ($1, $2, $3, 'failed', $4)
     ON CONFLICT (job_id, chunk_index) DO UPDATE
       SET status = 'failed', error_message = EXCLUDED.error_message, updated_at = NOW()`,
    [jobId, index, offset, errorMessage],
  );
}

export async function getCompletedChunks(jobId) {
  const { rows } = await pool.query(
    `SELECT chunk_index, start_offset_seconds, transcript, segments
       FROM transcription_chunks
      WHERE job_id = $1 AND status = 'completed'
      ORDER BY chunk_index`,
    [jobId],
  );
  return rows;
}

export async function completeJob(id, transcript, segments) {
  await pool.query(
    `UPDATE transcription_jobs
        SET status = 'completed', transcript = $2, segments = $3::jsonb,
            error_message = NULL, completed_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [id, transcript, JSON.stringify(segments)],
  );
}

export async function closeDatabase() {
  await pool.end();
}
