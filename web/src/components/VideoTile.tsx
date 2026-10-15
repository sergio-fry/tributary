import { useEffect, useRef, useState } from "react";
import type { UploadHealth } from "../lib/recorder/upload-manager";
import { watchMicLevel } from "../lib/media";
import { Badge } from "./ui";
import { MicIcon, MicOffIcon } from "./icons";

/** Raw sample peak at or above this reads as full scale — digital clipping. */
const CLIP_THRESHOLD = 0.99;
/** How long the CLIP warning stays lit after the last full-scale sample. */
const CLIP_LINGER_MS = 2500;
/** Meter repaint rate; rAF is 60fps, meters don't need more than ~12. */
const METER_INTERVAL_MS = 80;
/** Peak-hold fall speed, in fraction of full scale per second. */
const PEAK_HOLD_DECAY = 0.35;

/**
 * Per-person sound level meter: green bar = current loudness (RMS), thin
 * marker = recent peak (falls slowly), red = clipping (full-scale samples).
 */
function LevelMeter({ level, peakHold, clipping }: { level: number; peakHold: number; clipping: boolean }) {
  const peakPct = Math.min(100, Math.round(peakHold * 100));
  return (
    <div
      className="absolute bottom-0 left-0 right-0 flex h-1.5 items-center bg-black/40"
      title={
        clipping
          ? "Clipping — input is too loud / too close to the mic. Lower the guest's gain."
          : "Sound level — marker follows the recent peak; red means clipping."
      }
    >
      <div
        className={`h-full transition-[width] duration-75 ${
          clipping ? "bg-rec" : level > 0.66 ? "bg-amber-400" : "bg-emerald-400"
        }`}
        style={{ width: `${Math.round(level * 100)}%` }}
      />
      <div
        className={`absolute top-0 h-full w-0.5 ${peakHold >= CLIP_THRESHOLD ? "bg-rec" : "bg-white/80"}`}
        style={{ left: `calc(${peakPct}% - 1px)` }}
      />
    </div>
  );
}

export function VideoTile({
  stream,
  name,
  muted,
  micOn,
  camOn,
  isSelf,
  micLabel,
  upload,
  large,
  onHostMute,
}: {
  stream: MediaStream | null;
  name: string;
  muted?: boolean;
  micOn?: boolean;
  camOn?: boolean;
  isSelf?: boolean;
  /** Selected microphone label (announced over signaling) — shown under the name. */
  micLabel?: string | null;
  upload?: UploadHealth | null;
  large?: boolean;
  /** Present when the local user is a host viewing a guest tile. */
  onHostMute?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [volume, setVolume] = useState(1);
  const [meter, setMeter] = useState<{ level: number; peakHold: number } | null>(null);
  const [clipping, setClipping] = useState(false);
  const clipTimer = useRef<number>(0);

  // Live sound level for this participant (local stream or remote WebRTC one).
  // Keyed on the audio track identity: mid-session device switches replace the
  // track inside the same MediaStream, and the meter must rebind to it.
  const audioTrack = stream?.getAudioTracks()[0] ?? null;
  const hasAudio = !!audioTrack;
  useEffect(() => {
    if (!stream || !hasAudio || micOn === false) {
      setMeter(null);
      setClipping(false);
      return;
    }
    let level = 0;
    let peakHold = 0;
    let lastTick = performance.now();
    let lastPaint = 0;
    const stop = watchMicLevel(stream, (lv, peak) => {
      const now = performance.now();
      const dt = Math.min(0.5, (now - lastTick) / 1000);
      lastTick = now;
      if (peak >= CLIP_THRESHOLD) {
        setClipping(true);
        window.clearTimeout(clipTimer.current);
        clipTimer.current = window.setTimeout(() => setClipping(false), CLIP_LINGER_MS);
      }
      level = lv;
      peakHold = Math.max(peak, peakHold - PEAK_HOLD_DECAY * dt);
      if (now - lastPaint >= METER_INTERVAL_MS) {
        lastPaint = now;
        setMeter({ level, peakHold });
      }
    });
    return () => {
      stop();
      window.clearTimeout(clipTimer.current);
    };
  }, [stream, audioTrack, hasAudio, micOn]);

  const attachVideo = (el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  };

  useEffect(() => {
    if (videoRef.current && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume, stream]);

  return (
    <div
      className={`group relative overflow-hidden rounded-2xl bg-panel-2 ring-1 ring-edge ${
        large ? "col-span-full" : ""
      }`}
      style={{ aspectRatio: "16 / 9" }}
    >
      {stream && (
        <video
          ref={attachVideo}
          autoPlay
          playsInline
          muted={muted || isSelf}
          className={`h-full w-full object-cover ${isSelf ? "scale-x-[-1]" : ""} ${
            camOn === false ? "hidden" : ""
          }`}
        />
      )}
      {(!stream || camOn === false) && (
        <div className="flex h-full w-full items-center justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-accent to-accent-2/60 text-3xl font-semibold text-white">
            {name.slice(0, 1).toUpperCase()}
          </div>
        </div>
      )}
      <div className="absolute bottom-2.5 left-2.5 flex max-w-[calc(100%-1.25rem)] flex-col items-start gap-1">
        <div className="flex items-center gap-1.5">
          {clipping && (
            <span
              title="Full-scale samples detected — this input is clipping. Ask to lower gain or move back from the mic."
              className="animate-pulse rounded-full bg-rec px-2 py-1 text-[10px] font-bold leading-none tracking-wide text-white"
            >
              CLIP
            </span>
          )}
          {micOn === false && (
            <span
              role="img"
              aria-label={`${name} is muted`}
              title={`${name} is muted`}
              className="flex h-6 w-6 items-center justify-center rounded-full bg-rec text-white"
            >
              <MicOffIcon width={13} height={13} />
            </span>
          )}
          <span className="rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm">
            {name}
            {isSelf ? " (you)" : ""}
          </span>
        </div>
        {micLabel && (
          <span
            title={micLabel}
            className="flex max-w-full items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-gray-300 backdrop-blur-sm"
          >
            <MicIcon width={10} height={10} className="shrink-0 text-gray-400" />
            <span className="truncate">{micLabel}</span>
          </span>
        )}
      </div>
      {meter && <LevelMeter level={meter.level} peakHold={meter.peakHold} clipping={clipping} />}
      {upload && upload.state !== "complete" && (
        <div className="absolute top-2 right-2">
          <Badge tone={upload.state === "delayed" || upload.state === "failed" ? "red" : "blue"}>
            ⇡ {upload.percent}%
          </Badge>
        </div>
      )}
      {!isSelf && (
        <div className="absolute bottom-2 right-2 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
          {onHostMute && micOn !== false && (
            <button
              onClick={onHostMute}
              title={`Mute ${name} for everyone`}
              className="rounded-md bg-black/60 px-2 py-0.5 text-xs text-white hover:bg-rec/80"
            >
              Mute
            </button>
          )}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            title="Your local volume for this person"
            onChange={(e) => setVolume(Number(e.target.value))}
            className="w-20 accent-[#4f7cff]"
          />
        </div>
      )}
    </div>
  );
}
