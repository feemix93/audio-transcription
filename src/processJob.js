import path from "node:path";
import {
  getJob,
  setJobStatus,
  saveChunkStarted,
  saveChunkCompleted,
  saveChunkFailed,
  getCompletedChunks,
  completeJob,
} from "./db.js";
import { resolveAudioKey } from "./storage/localStorage.js";
import { prepareAudioChunks, removeWorkDir } from "./audio/media.js";
import { transcribeChunk } from "./transcription/openaiTranscriber.js";

export async function processTranscriptionJob(jobId) {
  const job = await getJob(jobId);
  if (!job) throw new Error(`Transcription job ${jobId} was not found.`);
  if (job.status === "completed") return;

  await setJobStatus(jobId, "processing");
  let prepared;

  try {
    const inputPath = resolveAudioKey(job.audio_key);
    prepared = await prepareAudioChunks(inputPath, jobId);

    const completedRows = await getCompletedChunks(jobId);
    const completedIndices = new Set(completedRows.map((row) => Number(row.chunk_index)));

    for (const chunk of prepared.chunks) {
      if (completedIndices.has(chunk.index)) continue;

      await saveChunkStarted(jobId, chunk.index, chunk.offsetSeconds);

      try {
        const result = await transcribeChunk(chunk.path);
        const adjustedSegments = result.segments.map((segment) => ({
          start: Number((segment.start + chunk.offsetSeconds).toFixed(3)),
          end: Number((segment.end + chunk.offsetSeconds).toFixed(3)),
          text: segment.text,
        }));

        await saveChunkCompleted(
          jobId,
          chunk.index,
          chunk.offsetSeconds,
          result.text,
          adjustedSegments,
        );
      } catch (error) {
        await saveChunkFailed(
          jobId,
          chunk.index,
          chunk.offsetSeconds,
          error.message || "Unknown transcription error",
        );
        throw error;
      }
    }

    const allChunks = await getCompletedChunks(jobId);
    const transcript = allChunks.map((chunk) => chunk.transcript ?? "").filter(Boolean).join("\n");
    const segments = allChunks
      .flatMap((chunk) => Array.isArray(chunk.segments) ? chunk.segments : [])
      .sort((a, b) => a.start - b.start);

    await completeJob(jobId, transcript, segments);
  } catch (error) {
    await setJobStatus(jobId, "failed", error.message || "Transcription failed");
    throw error; // BullMQ retries the job according to queue policy.
  } finally {
    if (prepared?.workDir) {
      await removeWorkDir(prepared.workDir).catch(() => {});
    }
  }
}
