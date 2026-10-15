import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { CHUNKS_DIR, EXPORTS_DIR, MEDIA_DIR, trackChunksDir } from "./storage.js";
import { hlsDirFor } from "./streaming.js";

/**
 * Remove every on-disk artifact the given sessions can own:
 * uploaded track chunk dirs, assembled/transcoded media files, exports
 * (prefix match, so the .srt caption sidecar goes too), and the
 * live-stream HLS directory. Best-effort: missing paths are ignored, so it
 * is safe to call for sessions that never recorded or streamed.
 */
export function removeSessionFiles(
  sessionIds: string[],
  trackIds: string[],
  exportIds: string[]
): void {
  let mediaNames: string[] = [];
  let exportNames: string[] = [];
  try {
    mediaNames = fs.readdirSync(MEDIA_DIR);
  } catch {
    // media dir missing — nothing to clean
  }
  try {
    exportNames = fs.readdirSync(EXPORTS_DIR);
  } catch {
    // exports dir missing — nothing to clean
  }
  for (const trackId of trackIds) {
    fs.rmSync(trackChunksDir(trackId), { recursive: true, force: true });
    for (const entry of mediaNames) {
      if (entry.startsWith(`${trackId}.`)) fs.rmSync(path.join(MEDIA_DIR, entry), { force: true });
    }
  }
  for (const exportId of exportIds) {
    for (const entry of exportNames) {
      if (entry.startsWith(`${exportId}.`)) fs.rmSync(path.join(EXPORTS_DIR, entry), { force: true });
    }
  }
  for (const sessionId of sessionIds) {
    fs.rmSync(hlsDirFor(sessionId), { recursive: true, force: true });
  }
}

// Ids are 14-char lowercase alphanumeric nanoids; file names are
// `<id>.<suffix>`. Anything else is not ours — leave it alone.
const ID_RE = /^[0-9a-z]{14}$/;

function idPrefixOf(entry: string): string | null {
  const prefix = entry.split(".")[0];
  return ID_RE.test(prefix) ? prefix : null;
}

/**
 * Startup sweep: delete on-disk artifacts whose database rows no longer
 * exist — garbage left by sessions deleted before cleanup was complete, or
 * by interrupted uploads/processing. Temp `.tmp` files (atomic-write
 * leftovers) are removed even for live tracks: no valid state uses them.
 */
export function sweepOrphanFiles(): void {
  const trackIds = new Set(
    (db.prepare("SELECT id FROM tracks").all() as { id: string }[]).map((r) => r.id)
  );
  const exportIds = new Set(
    (db.prepare("SELECT id FROM exports").all() as { id: string }[]).map((r) => r.id)
  );
  let removed = 0;

  // chunks/<trackId>/ dirs of tracks that no longer exist.
  try {
    for (const entry of fs.readdirSync(CHUNKS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = idPrefixOf(entry.name);
      if (id && !trackIds.has(id)) {
        fs.rmSync(path.join(CHUNKS_DIR, entry.name), { recursive: true, force: true });
        removed++;
      } else if (id) {
        // Stale chunk-upload temp files inside a live track's dir.
        for (const f of fs.readdirSync(path.join(CHUNKS_DIR, entry.name))) {
          if (f.endsWith(".tmp")) {
            fs.rmSync(path.join(CHUNKS_DIR, entry.name, f), { force: true });
            removed++;
          }
        }
      }
    }
  } catch {
    // chunks dir missing — nothing to sweep
  }

  // media/<trackId>.<…> files of tracks that no longer exist, plus any .tmp.
  try {
    for (const entry of fs.readdirSync(MEDIA_DIR)) {
      const id = idPrefixOf(entry);
      if (entry.endsWith(".tmp") || (id && !trackIds.has(id))) {
        fs.rmSync(path.join(MEDIA_DIR, entry), { force: true });
        removed++;
      }
    }
  } catch {
    // media dir missing — nothing to sweep
  }

  // exports/<exportId>.<…> files (incl. .srt sidecars) of deleted exports.
  try {
    for (const entry of fs.readdirSync(EXPORTS_DIR)) {
      const id = idPrefixOf(entry);
      if (id && !exportIds.has(id)) {
        fs.rmSync(path.join(EXPORTS_DIR, entry), { force: true });
        removed++;
      }
    }
  } catch {
    // exports dir missing — nothing to sweep
  }

  if (removed > 0) console.log(`[cleanup] startup sweep removed ${removed} orphaned file(s)`);
}
