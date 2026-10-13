import type { TrackRow } from "./db.js";

export type VoiceTrack = TrackRow & { participant_name: string };

/**
 * Voice tracks to use for mixing, transcription, and timeline exports.
 *
 * A participant can produce several contiguous voice tracks in one recording:
 * switching the microphone or camera mid-take finalizes the old local segment
 * and starts a new one. Pick every PCM segment plus camera audio for the time
 * ranges no PCM segment covers (PCM capture may fail or be disabled while the
 * compressed camera audio still records).
 */
export function pickVoiceTracks<T extends VoiceTrack>(tracks: T[]): T[] {
  const byParticipant = new Map<string, T[]>();
  for (const track of tracks) {
    if (track.type === "screen") continue;
    const list = byParticipant.get(track.participant_id) ?? [];
    list.push(track);
    byParticipant.set(track.participant_id, list);
  }

  const picked: T[] = [];
  for (const list of byParticipant.values()) {
    const pcm = list.filter((t) => t.type === "pcm");
    if (pcm.length === 0) {
      picked.push(...list);
      continue;
    }
    picked.push(...pcm);
    const ranges = pcm.map((t) => ({
      start: t.start_offset_ms,
      end: t.start_offset_ms + (t.duration_ms ?? 0),
    }));
    for (const track of list) {
      if (track.type === "pcm") continue;
      const start = track.start_offset_ms;
      const end = track.start_offset_ms + (track.duration_ms ?? 0);
      // Overlap with ±1s tolerance — clock drift must not duplicate speech.
      const covered = ranges.some((r) => start < r.end - 1000 && end > r.start + 1000);
      if (!covered) picked.push(track);
    }
  }
  return picked;
}
