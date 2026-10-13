import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import {
  db,
  type ExportRow,
  type RecordingRow,
  type TrackRow,
  type TranscriptRow,
  type TranscriptSegment,
} from "../lib/db.js";
import { newId, requireUser } from "../lib/auth.js";
import {
  chunkPath,
  enhancedWavPath,
  exportPath,
  mp4TrackPath,
  rawTrackPath,
  wavTrackPath,
} from "../lib/storage.js";
import { queueEnhanceTrack, queueMixedExport, reprocessTrack } from "../jobs/pipeline.js";
import { queueTranscription, renderTranscript } from "../jobs/transcribe.js";
import { buildFcpXml } from "../lib/fcpxml.js";
import { trackDownloadBase } from "../lib/filenames.js";

function trackOwnedByUser(trackId: string, userId: string): (TrackRow & { participant_name: string }) | null {
  const row = db
    .prepare(
      `SELECT t.*, p.name AS participant_name FROM tracks t
       JOIN sessions s ON s.id = t.session_id
       JOIN studios st ON st.id = s.studio_id
       JOIN studio_members mem ON mem.studio_id = st.id AND mem.user_id = ?
       JOIN participants p ON p.id = t.participant_id
       WHERE t.id = ?`
    )
    .get(userId, trackId) as (TrackRow & { participant_name: string }) | undefined;
  return row ?? null;
}


function streamFile(
  req: any,
  reply: any,
  filePath: string,
  downloadName: string,
  contentType: string,
  inline = false
): unknown {
  if (!fs.existsSync(filePath)) {
    return reply.code(404).send({ error: "File not available yet" });
  }
  const stat = fs.statSync(filePath);
  reply.header("Content-Type", contentType);
  reply.header("Accept-Ranges", "bytes");
  if (!inline) {
    reply.header("Content-Disposition", `attachment; filename="${downloadName}"`);
  }

  // Range support so <video> preview elements can seek.
  const range = typeof req.headers?.range === "string" ? req.headers.range : null;
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (match && (match[1] || match[2])) {
    const start = match[1] ? parseInt(match[1], 10) : Math.max(0, stat.size - parseInt(match[2], 10));
    const end = match[1] && match[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) {
      reply.header("Content-Range", `bytes */${stat.size}`);
      return reply.code(416).send();
    }
    reply.code(206);
    reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    reply.header("Content-Length", end - start + 1);
    return reply.send(fs.createReadStream(filePath, { start, end }));
  }

  reply.header("Content-Length", stat.size);
  return reply.send(fs.createReadStream(filePath));
}

// ---- Original (pre-processing) track downloads ----
//
// A finished-and-uploaded take must be downloadable immediately, even while
// ffmpeg is still queued/running (or has failed): stream the assembled raw
// file when it exists, else concatenate the uploaded chunks on the fly.
// Chunks are written atomically (tmp + rename) and indexed in the `chunks`
// table, so anything listed there is complete and safe to serve.

type Part = { buf?: Buffer; file?: string };

/** List this track's fully-received chunk files, in recording order. */
function receivedChunkParts(trackId: string): { parts: Part[]; bytes: number } {
  const rows = db
    .prepare("SELECT idx FROM chunks WHERE track_id = ? ORDER BY idx ASC")
    .all(trackId) as { idx: number }[];
  const parts: Part[] = [];
  let bytes = 0;
  for (const { idx } of rows) {
    try {
      const size = fs.statSync(chunkPath(trackId, idx)).size;
      if (size > 0) {
        parts.push({ file: chunkPath(trackId, idx) });
        bytes += size;
      }
    } catch {
      // file vanished between listing and stat (e.g. post-processing chunk GC)
    }
  }
  return { parts, bytes };
}

/** 44-byte canonical RIFF/WAV header for an s16le PCM payload. */
function wavHeader(dataBytes: number, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** rate/channels/format parsed out of an `audio/pcm;rate=…;channels=…` mime. */
function pcmParams(mime: string): { rate: number; channels: number } {
  const params = new Map(
    mime
      .split(";")
      .slice(1)
      .map((p) => p.split("=") as [string, string])
  );
  return {
    rate: Number(params.get("rate")) || 48000,
    channels: Number(params.get("channels")) || 2,
  };
}

/** Stream parts (buffers and files) as one attachment with a known length. */
function streamParts(
  reply: any,
  parts: Part[],
  bytes: number,
  downloadName: string,
  contentType: string,
  headerFor?: (dataBytes: number) => Buffer
): unknown {
  if (headerFor) {
    const header = headerFor(bytes);
    parts = [{ buf: header }, ...parts];
    bytes += header.length;
  }
  reply.header("Content-Type", contentType);
  reply.header("Content-Disposition", `attachment; filename="${downloadName}"`);
  reply.header("Content-Length", String(bytes));

  const out = new PassThrough();
  let i = 0;
  const next = (): void => {
    while (i < parts.length) {
      const part = parts[i++];
      if (part.buf) {
        if (!out.write(part.buf)) {
          out.once("drain", next);
          return;
        }
        continue;
      }
      const read = fs.createReadStream(part.file!);
      read.on("error", (err) => out.destroy(err));
      read.on("end", next);
      read.pipe(out, { end: false });
      return;
    }
    out.end();
  };
  next();
  return reply.send(out);
}

/**
 * Stream the track's original recording — what was uploaded, before ffmpeg.
 * Prefers the assembled raw file; falls back to concatenating uploaded chunks
 * ("whatever is there" — works mid-upload too). PCM tracks get a WAV header
 * so the uncompressed original is playable anywhere.
 */
function streamOriginal(
  req: any,
  reply: any,
  track: TrackRow,
  base: string,
  nameBase?: string
): unknown {
  const stem = nameBase ?? `${base}.raw`;
  const isPcm = track.mime_type.startsWith("audio/pcm");
  const ext = isPcm ? "pcm" : track.mime_type.includes("mp4") ? "mp4" : "webm";
  const rawPath = rawTrackPath(track.id, ext);

  if (!isPcm) {
    const contentType = track.mime_type.split(";")[0] || "video/webm";
    if (fs.existsSync(rawPath)) {
      return streamFile(req, reply, rawPath, `${stem}.${ext}`, contentType);
    }
    const { parts, bytes } = receivedChunkParts(track.id);
    if (bytes === 0) return reply.code(404).send({ error: "No uploaded data yet" });
    return streamParts(reply, parts, bytes, `${stem}.${ext}`, contentType);
  }

  const { rate, channels } = pcmParams(track.mime_type);
  const headerFor = (dataBytes: number): Buffer => wavHeader(dataBytes, rate, channels);
  if (fs.existsSync(rawPath)) {
    const stat = fs.statSync(rawPath);
    return streamParts(
      reply,
      [{ file: rawPath }],
      stat.size,
      `${stem}.wav`,
      "audio/wav",
      headerFor
    );
  }
  const { parts, bytes } = receivedChunkParts(track.id);
  if (bytes === 0) return reply.code(404).send({ error: "No uploaded data yet" });
  return streamParts(reply, parts, bytes, `${stem}.wav`, "audio/wav", headerFor);
}

export function registerMediaRoutes(app: FastifyInstance): void {
  app.get("/api/tracks/:trackId/download", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { trackId } = req.params as { trackId: string };
    const { kind } = req.query as { kind?: string };
    const track = trackOwnedByUser(trackId, user.id);
    if (!track) return reply.code(404).send({ error: "Track not found" });

    const base = trackDownloadBase(track.participant_name, track.type, trackId);
    switch (kind ?? "mp4") {
      case "raw":
        return streamOriginal(req, reply, track, base);
      case "wav": {
        const wavPath = wavTrackPath(trackId);
        if (fs.existsSync(wavPath)) {
          return streamFile(req, reply, wavPath, `${base}.wav`, "audio/wav");
        }
        // PCM tracks: the WAV is just the uploaded PCM wrapped in a header —
        // serve the original before processing finishes.
        if (track.mime_type.startsWith("audio/pcm")) {
          return streamOriginal(req, reply, track, base, `${base}`);
        }
        return streamFile(req, reply, wavPath, `${base}.wav`, "audio/wav");
      }
      case "enhanced":
        return streamFile(req, reply, enhancedWavPath(trackId), `${base}.enhanced.wav`, "audio/wav");
      case "mp4":
      default:
        return streamFile(req, reply, mp4TrackPath(trackId), `${base}.mp4`, "video/mp4",
          (req.query as { inline?: string }).inline === "1");
    }
  });

  app.post("/api/tracks/:trackId/enhance", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { trackId } = req.params as { trackId: string };
    const track = trackOwnedByUser(trackId, user.id);
    if (!track) return reply.code(404).send({ error: "Track not found" });
    if (!queueEnhanceTrack(trackId)) {
      return reply.code(409).send({ error: "Track has no ready audio to enhance" });
    }
    return { ok: true };
  });

  app.post("/api/tracks/:trackId/reprocess", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { trackId } = req.params as { trackId: string };
    const track = trackOwnedByUser(trackId, user.id);
    if (!track) return reply.code(404).send({ error: "Track not found" });
    if (!reprocessTrack(trackId)) {
      return reply.code(409).send({ error: "Track was never finalized; nothing to process" });
    }
    return { ok: true };
  });

  app.post("/api/recordings/:recordingId/exports", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { recordingId } = req.params as { recordingId: string };
    const body = (req.body ?? {}) as {
      type?: string;
      trimStartMs?: number;
      trimEndMs?: number;
      cuts?: { startMs: number; endMs: number }[];
      aspect?: string;
      captions?: boolean;
    };
    const type = body.type === "mixed_audio" ? "mixed_audio" : "mixed_video";

    // Optional edit decision list / render options from the editor
    let paramsJson: string | null = null;
    const cuts = Array.isArray(body.cuts)
      ? body.cuts
          .filter((c) => Number.isFinite(c?.startMs) && Number.isFinite(c?.endMs))
          .map((c) => ({ startMs: Math.round(c.startMs), endMs: Math.round(c.endMs) }))
      : [];
    const aspect = ["16:9", "1:1", "9:16"].includes(body.aspect ?? "") ? body.aspect : undefined;
    if (
      Number.isFinite(body.trimStartMs) ||
      Number.isFinite(body.trimEndMs) ||
      cuts.length > 0 ||
      aspect ||
      body.captions
    ) {
      paramsJson = JSON.stringify({
        trimStartMs: Number.isFinite(body.trimStartMs) ? Math.round(body.trimStartMs!) : undefined,
        trimEndMs: Number.isFinite(body.trimEndMs) ? Math.round(body.trimEndMs!) : undefined,
        cuts,
        aspect,
        captions: body.captions === true || undefined,
      });
    }

    const recording = db
      .prepare(
        `SELECT r.* FROM recordings r
         JOIN sessions s ON s.id = r.session_id
         JOIN studios st ON st.id = s.studio_id
         JOIN studio_members mem ON mem.studio_id = st.id AND mem.user_id = ?
         WHERE r.id = ?`
      )
      .get(user.id, recordingId) as RecordingRow | undefined;
    if (!recording) return reply.code(404).send({ error: "Recording not found" });

    const exportRow: ExportRow = {
      id: newId(),
      session_id: recording.session_id,
      recording_id: recordingId,
      type,
      status: "queued",
      format: type === "mixed_video" ? "mp4" : "wav",
      size_bytes: null,
      duration_ms: null,
      error: null,
      created_at: Date.now(),
      params_json: paramsJson,
    };
    db.prepare(
      `INSERT INTO exports (id, session_id, recording_id, type, status, format, created_at, params_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      exportRow.id,
      exportRow.session_id,
      exportRow.recording_id,
      exportRow.type,
      exportRow.status,
      exportRow.format,
      exportRow.created_at,
      exportRow.params_json
    );
    queueMixedExport(exportRow);
    return { export: exportRow };
  });

  // Editor data: recording + ready tracks + transcript in one call.
  app.get("/api/recordings/:recordingId", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { recordingId } = req.params as { recordingId: string };
    const recording = db
      .prepare(
        `SELECT r.*, s.title AS session_title, s.id AS session_id FROM recordings r
         JOIN sessions s ON s.id = r.session_id
         JOIN studios st ON st.id = s.studio_id
         JOIN studio_members mem ON mem.studio_id = st.id AND mem.user_id = ?
         WHERE r.id = ?`
      )
      .get(user.id, recordingId) as (RecordingRow & { session_title: string }) | undefined;
    if (!recording) return reply.code(404).send({ error: "Recording not found" });

    const tracks = db
      .prepare(
        `SELECT t.*, p.name AS participant_name FROM tracks t
         JOIN participants p ON p.id = t.participant_id
         WHERE t.recording_id = ? ORDER BY t.created_at ASC`
      )
      .all(recordingId);
    const transcript = db
      .prepare(
        "SELECT segments_json, words_json FROM transcripts WHERE recording_id = ? AND status = 'ready'"
      )
      .get(recordingId) as { segments_json: string | null; words_json: string | null } | undefined;
    return {
      recording,
      tracks,
      transcriptSegments: transcript?.segments_json ? JSON.parse(transcript.segments_json) : null,
      transcriptWords: transcript?.words_json ? JSON.parse(transcript.words_json) : null,
    };
  });

  // ---- Transcription ----
  const recordingOwnedByUser = (recordingId: string, userId: string): RecordingRow | null =>
    (db
      .prepare(
        `SELECT r.* FROM recordings r
         JOIN sessions s ON s.id = r.session_id
         JOIN studios st ON st.id = s.studio_id
         JOIN studio_members mem ON mem.studio_id = st.id AND mem.user_id = ?
         WHERE r.id = ?`
      )
      .get(userId, recordingId) as RecordingRow | undefined) ?? null;

  app.post("/api/recordings/:recordingId/transcribe", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { recordingId } = req.params as { recordingId: string };
    const recording = recordingOwnedByUser(recordingId, user.id);
    if (!recording) return reply.code(404).send({ error: "Recording not found" });
    const transcript = queueTranscription(recordingId, recording.session_id);
    return { transcript };
  });

  app.get("/api/recordings/:recordingId/transcript", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { recordingId } = req.params as { recordingId: string };
    if (!recordingOwnedByUser(recordingId, user.id)) {
      return reply.code(404).send({ error: "Recording not found" });
    }
    const transcript = db
      .prepare("SELECT * FROM transcripts WHERE recording_id = ?")
      .get(recordingId) as TranscriptRow | undefined;
    if (!transcript) return reply.code(404).send({ error: "No transcript" });
    return {
      transcript: {
        ...transcript,
        segments: transcript.segments_json ? JSON.parse(transcript.segments_json) : [],
        segments_json: undefined,
      },
    };
  });

  // Premiere/FCP-compatible timeline referencing the downloaded track files.
  app.get("/api/recordings/:recordingId/xml", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { recordingId } = req.params as { recordingId: string };
    const recording = recordingOwnedByUser(recordingId, user.id);
    if (!recording) return reply.code(404).send({ error: "Recording not found" });

    const tracks = db
      .prepare(
        `SELECT t.*, p.name AS participant_name FROM tracks t
         JOIN participants p ON p.id = t.participant_id
         WHERE t.recording_id = ? ORDER BY t.created_at ASC`
      )
      .all(recordingId) as (TrackRow & { participant_name: string })[];
    if (!tracks.some((t) => t.status === "ready")) {
      return reply.code(409).send({ error: "No ready tracks yet" });
    }
    const session = db
      .prepare("SELECT title FROM sessions WHERE id = ?")
      .get(recording.session_id) as { title: string } | undefined;

    const xml = buildFcpXml(session?.title ?? "Tributary recording", tracks);
    reply.header("Content-Type", "application/xml; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="timeline-${recordingId.slice(0, 6)}.xml"`
    );
    return reply.send(xml);
  });

  app.get("/api/recordings/:recordingId/transcript/download", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { recordingId } = req.params as { recordingId: string };
    const { format } = req.query as { format?: string };
    if (!recordingOwnedByUser(recordingId, user.id)) {
      return reply.code(404).send({ error: "Recording not found" });
    }
    const transcript = db
      .prepare("SELECT * FROM transcripts WHERE recording_id = ? AND status = 'ready'")
      .get(recordingId) as TranscriptRow | undefined;
    if (!transcript?.segments_json) return reply.code(404).send({ error: "Transcript not ready" });

    const segments = JSON.parse(transcript.segments_json) as TranscriptSegment[];
    const fmt = format === "srt" ? "srt" : format === "vtt" ? "vtt" : "txt";
    const body = renderTranscript(segments, fmt);
    const contentTypes = { txt: "text/plain", srt: "application/x-subrip", vtt: "text/vtt" };
    reply.header("Content-Type", `${contentTypes[fmt]}; charset=utf-8`);
    reply.header("Content-Disposition", `attachment; filename="transcript-${recordingId.slice(0, 6)}.${fmt}"`);
    return reply.send(body);
  });

  app.get("/api/exports/:exportId/download", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { exportId } = req.params as { exportId: string };
    const exp = db
      .prepare(
        `SELECT e.* FROM exports e
         JOIN sessions s ON s.id = e.session_id
         JOIN studios st ON st.id = s.studio_id
         JOIN studio_members mem ON mem.studio_id = st.id AND mem.user_id = ?
         WHERE e.id = ?`
      )
      .get(user.id, exportId) as ExportRow | undefined;
    if (!exp) return reply.code(404).send({ error: "Export not found" });
    const contentType = exp.format === "mp4" ? "video/mp4" : "audio/wav";
    return streamFile(req, reply, exportPath(exportId, exp.format), `mixed-${exp.type}-${exportId.slice(0, 6)}.${exp.format}`, contentType);
  });

  // Re-timed caption sidecar generated alongside an export (if captions were on).
  app.get("/api/exports/:exportId/captions", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { exportId } = req.params as { exportId: string };
    const exp = db
      .prepare(
        `SELECT e.* FROM exports e
         JOIN sessions s ON s.id = e.session_id
         JOIN studios st ON st.id = s.studio_id
         JOIN studio_members mem ON mem.studio_id = st.id AND mem.user_id = ?
         WHERE e.id = ?`
      )
      .get(user.id, exportId) as ExportRow | undefined;
    if (!exp) return reply.code(404).send({ error: "Export not found" });
    return streamFile(req, reply, exportPath(exportId, "srt"), `captions-${exportId.slice(0, 6)}.srt`, "application/x-subrip");
  });
}
