import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

export const ALLOWED_EXTENSIONS = new Set([
  ".mp3", ".wav", ".m4a", ".webm", ".mp4", ".mpeg",
  ".mpga", ".oga", ".ogg", ".flac",
]);

export function extensionOf(filename) {
  return path.extname(filename).toLowerCase();
}

export async function probeAudio(filePath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration,format_name",
      "-of", "json",
      filePath,
    ]);
    const parsed = JSON.parse(stdout);
    const duration = Number(parsed.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Audio duration could not be determined.");
    }
    return { duration, formatName: parsed.format?.format_name ?? "unknown" };
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("ffprobe is not installed. Install FFmpeg to process audio.");
    }
    throw new Error(`Invalid or unreadable audio file: ${error.message}`);
  }
}

async function runFfmpeg(args) {
  try {
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("ffmpeg is not installed. Install FFmpeg to process audio.");
    }
    throw new Error(`Audio conversion failed: ${error.stderr || error.message}`);
  }
}

export async function prepareAudioChunks(inputPath, jobId) {
  const workDir = path.join(config.dataDir, "work", jobId);
  await fs.mkdir(workDir, { recursive: true });

  const probe = await probeAudio(inputPath);
  const normalizedPath = path.join(workDir, "normalized.mp3");

  // Normalize formats/codecs to a predictable MP3 format for transcription.
  await runFfmpeg([
    "-i", inputPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "64k",
    normalizedPath,
  ]);

  const chunkSeconds = config.chunkSeconds;
  if (probe.duration <= chunkSeconds) {
    const stat = await fs.stat(normalizedPath);
    if (stat.size === 0) throw new Error("Normalized audio file is empty.");
    return {
      workDir,
      duration: probe.duration,
      chunks: [{ index: 0, offsetSeconds: 0, path: normalizedPath }],
    };
  }

  const pattern = path.join(workDir, "chunk_%05d.mp3");
  await runFfmpeg([
    "-i", normalizedPath,
    "-f", "segment",
    "-segment_time", String(chunkSeconds),
    "-reset_timestamps", "1",
    "-c:a", "libmp3lame",
    "-b:a", "64k",
    pattern,
  ]);

  const names = (await fs.readdir(workDir))
    .filter((name) => /^chunk_\d{5}\.mp3$/.test(name))
    .sort();

  if (!names.length) throw new Error("FFmpeg did not produce any audio chunks.");

  return {
    workDir,
    duration: probe.duration,
    chunks: names.map((name, index) => ({
      index,
      offsetSeconds: index * chunkSeconds,
      path: path.join(workDir, name),
    })),
  };
}

export async function removeWorkDir(workDir) {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true });
}
