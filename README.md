# Audio Transcription API

A Node.js REST API that accepts audio uploads, normalizes common audio formats with FFmpeg, transcribes long recordings in chunks, returns segment-level timestamps, limits concurrent transcription workers, retries transient failures, and persists job state in PostgreSQL.

## Features

- REST API for upload, status, result retrieval, and manual retry.
- Supports common audio extensions: MP3, WAV, M4A, WebM, MP4, MPEG/MPGA, OGA/OGG, and FLAC, subject to FFmpeg being able to decode the actual file.
- File-size limits and audio validation with `ffprobe`.
- Audio normalization to mono 16 kHz MP3 using FFmpeg.
- Long audio split into configurable chunks; segment timestamps are offset to match the original recording timeline.
- OpenAI transcription API with segment timestamps.
- Bounded worker concurrency through BullMQ.
- Explicit exponential-backoff retries for transient transcription API errors, plus queue-level retries.
- PostgreSQL job and per-chunk persistence. Successfully transcribed chunks are reused after a retry.
- API-key authentication when `API_KEY` is configured.
- Local disk storage adapter for development and single-server deployments.

## Requirements

- Node.js 20+
- Docker / Docker Compose
- FFmpeg (`ffmpeg` and `ffprobe`) installed and available on `PATH`
- OpenAI API key with access to audio transcription

Install FFmpeg:
- macOS: `brew install ffmpeg`
- Ubuntu/Debian: `sudo apt-get update && sudo apt-get install -y ffmpeg`

## Run locally

1. Copy the environment template:

   ```bash
   cp .env.example .env
   ```

2. Add your OpenAI API key to `.env`:

   ```env
   OPENAI_API_KEY=your_real_key
   ```

3. Start PostgreSQL and Redis:

   ```bash
   docker compose up -d
   ```

4. Install packages:

   ```bash
   npm install
   ```

5. Start the API in terminal 1:

   ```bash
   npm run dev:api
   ```

6. Start the transcription worker in terminal 2:

   ```bash
   npm run dev:worker
   ```

API base URL: `http://localhost:3000`

Health check:

```bash
curl http://localhost:3000/health
```

## API usage

If you configured `API_KEY`, send `x-api-key: your_key` with every `/api` request. Do not use a real secret in source control.

### 1. Upload audio

The multipart form field must be named `audio`.

```bash
curl -X POST http://localhost:3000/api/transcriptions \
  -F "audio=@./sample.mp3"
```

Authenticated example:

```bash
curl -X POST http://localhost:3000/api/transcriptions \
  -H "x-api-key: your_key" \
  -F "audio=@./sample.mp3"
```

Response (`202 Accepted`):

```json
{
  "id": "generated-job-uuid",
  "status": "queued",
  "statusUrl": "/api/transcriptions/generated-job-uuid",
  "resultUrl": "/api/transcriptions/generated-job-uuid/result"
}
```

### 2. Check status

```bash
curl http://localhost:3000/api/transcriptions/JOB_ID
```

Possible states: `queued`, `processing`, `completed`, `failed`.

### 3. Retrieve transcript and timestamps

```bash
curl http://localhost:3000/api/transcriptions/JOB_ID/result
```

Example response:

```json
{
  "id": "generated-job-uuid",
  "text": "Hello, how are you?",
  "segments": [
    { "start": 0, "end": 2.1, "text": "Hello, how are you?" }
  ],
  "completedAt": "2026-01-01T12:00:00.000Z"
}
```

Timestamps are seconds from the start of the original audio, not from each individual chunk.

If the job is not complete, the result endpoint returns `409 Conflict` and its current status.

### 4. Manually retry a failed job

```bash
curl -X POST http://localhost:3000/api/transcriptions/JOB_ID/retry
```

Only jobs in the `failed` state can be manually retried. Completed chunks are stored in PostgreSQL and skipped when the job is retried.

## How concurrency and recovery work

- HTTP uploads are handled independently and written to temporary disk files instead of being buffered fully in memory.
- BullMQ workers process at most `WORKER_CONCURRENCY` jobs simultaneously.
- Each transcription chunk retries retryable failures up to `TRANSCRIPTION_MAX_ATTEMPTS`, using exponential backoff and jitter.
- The queue retries failed jobs up to `QUEUE_MAX_ATTEMPTS`.
- Job state and chunk results are persisted in PostgreSQL. On retry, completed chunks are reused.
- For long recordings, the worker normalizes the audio, splits it into `CHUNK_SECONDS` chunks, transcribes each chunk, offsets timestamps, and merges results in chronological order.

Chunking uses fixed-duration FFmpeg segments. A speech boundary can fall between chunks, so a word or sentence near a boundary may be less accurate. A more advanced pipeline can use voice-activity detection, overlapping chunks, and duplicate-segment reconciliation.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | API port | `3000` |
| `DATABASE_URL` | PostgreSQL connection | local Compose URL |
| `REDIS_HOST` / `REDIS_PORT` | Redis connection | `127.0.0.1:6379` |
| `OPENAI_API_KEY` | OpenAI API key | unset |
| `OPENAI_TRANSCRIPTION_MODEL` | Transcription model | `whisper-1` |
| `API_KEY` | API key for `/api` routes | unset in development |
| `DATA_DIR` | Local audio/temp/work directory | `./data` |
| `UPLOAD_MAX_MB` | Maximum upload size | `100` |
| `CHUNK_SECONDS` | Long-audio chunk length | `300` |
| `WORKER_CONCURRENCY` | Concurrent transcription jobs | `2` |
| `TRANSCRIPTION_MAX_ATTEMPTS` | API retry attempts per chunk | `3` |
| `QUEUE_MAX_ATTEMPTS` | BullMQ job attempts | `3` |
| `RETRY_BASE_DELAY_MS` | Initial API retry delay | `1000` |

## Project structure

```text
audio-transcription-api/
├── src/
│   ├── audio/media.js
│   ├── storage/localStorage.js
│   ├── transcription/openaiTranscriber.js
│   ├── config.js
│   ├── db.js
│   ├── processJob.js
│   ├── queue.js
│   ├── server.js
│   └── worker.js
├── test/audio.test.js
├── .env.example
├── .gitignore
├── docker-compose.yml
├── package.json
└── README.md
```

## Production notes

This repository is an assessment-ready reference implementation, not a fully hardened public service. Before production use:

1. Replace local disk storage with private S3/GCS/Azure Blob storage if deploying multiple API/worker instances. Local disk only works when API and workers share the same persistent filesystem.
2. Add authorization and ownership checks so a client can only access its own job IDs; the optional shared API key is a simple starter control.
3. Add request quotas, monitoring, structured logs, retention/deletion policies, and malware/content scanning as appropriate.
4. Consider direct-to-object-storage uploads for very large files.
5. Review the provider's current file size, format, rate, and model limits before deployment.
6. For highly accurate chunk timing, use speech-aware chunking or overlap with duplicate reconciliation.

## Tests

```bash
npm test
```

The included tests cover basic extension validation. Integration tests should additionally exercise FFmpeg, PostgreSQL, Redis, and the transcription API using test fixtures and mocked provider responses.
