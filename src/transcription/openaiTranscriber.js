import fs from "node:fs";
import OpenAI from "openai";
import { config } from "../config.js";

if (!config.openAiApiKey) {
  console.warn("OPENAI_API_KEY is not set. Transcription jobs will fail until it is configured.");
}

const client = new OpenAI({
  apiKey: config.openAiApiKey || "missing-api-key",
  maxRetries: 0, // We implement retries explicitly below.
  timeout: 10 * 60 * 1000,
});

function isRetryable(error) {
  const status = error.status ?? error.statusCode;
  return !status || status === 408 || status === 409 || status === 429 || status >= 500;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function transcribeChunk(filePath) {
  let lastError;

  for (let attempt = 1; attempt <= config.transcriptionMaxAttempts; attempt++) {
    try {
      const response = await client.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: config.transcriptionModel,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
      });

      const segments = (response.segments ?? []).map((segment) => ({
        start: Number(segment.start),
        end: Number(segment.end),
        text: String(segment.text ?? "").trim(),
      }));

      return {
        text: String(response.text ?? "").trim(),
        segments,
      };
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === config.transcriptionMaxAttempts) {
        throw error;
      }

      const exponentialDelay = config.retryBaseDelayMs * (2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 500);
      const retryAfter = Number(error.headers?.["retry-after"]);
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : exponentialDelay + jitter;

      console.warn(`Transcription attempt ${attempt} failed; retrying in ${delay}ms.`);
      await sleep(delay);
    }
  }

  throw lastError;
}
