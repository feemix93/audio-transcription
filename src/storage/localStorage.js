import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const audioDir = path.join(config.dataDir, "audio");
const tempDir = path.join(config.dataDir, "tmp");

export async function initStorage() {
  await fs.mkdir(audioDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });
}

export function getTempDir() {
  return tempDir;
}

export async function storeUpload(tempPath, jobId, extension) {
  const safeExtension = extension.toLowerCase();
  const key = `${jobId}${safeExtension}`;
  const destination = path.join(audioDir, key);
  await fs.rename(tempPath, destination);
  return key;
}

export function resolveAudioKey(key) {
  // Only allow a single filename, never an arbitrary path from a request.
  if (path.basename(key) !== key || key.includes("..")) {
    throw new Error("Invalid stored audio key");
  }
  return path.join(audioDir, key);
}

export async function deleteStoredAudio(key) {
  await fs.unlink(resolveAudioKey(key)).catch(() => {});
}
