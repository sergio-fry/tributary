import type { QualityPreset } from "./recorder/recorder";

export type DeviceInfo = { deviceId: string; label: string };

export async function listDevices(): Promise<{
  cameras: DeviceInfo[];
  microphones: DeviceInfo[];
  speakers: DeviceInfo[];
}> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const pick = (kind: MediaDeviceKind, fallback: string) =>
    devices
      .filter((d) => d.kind === kind)
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
  return {
    cameras: pick("videoinput", "Camera"),
    microphones: pick("audioinput", "Microphone"),
    speakers: pick("audiooutput", "Speaker"),
  };
}

export type CaptureSettings = {
  cameraId: string | null;
  microphoneId: string | null;
  preset: QualityPreset;
  echoCancellation: boolean; // "are you wearing headphones?" → off
  recordWav: boolean; // extra uncompressed 48kHz PCM audio track
};

export function buildConstraints(settings: CaptureSettings): MediaStreamConstraints {
  const dims =
    settings.preset === "ultra"
      ? { width: 3840, height: 2160 }
      : settings.preset === "high"
        ? { width: 1920, height: 1080 }
        : { width: 1280, height: 720 };
  const video: MediaTrackConstraints | boolean =
    settings.preset === "audio"
      ? false
      : {
          ...(settings.cameraId ? { deviceId: { exact: settings.cameraId } } : {}),
          width: { ideal: dims.width },
          height: { ideal: dims.height },
          frameRate: { ideal: 30 },
        };
  const audio: MediaTrackConstraints = {
    ...(settings.microphoneId ? { deviceId: { exact: settings.microphoneId } } : {}),
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.echoCancellation,
    autoGainControl: true,
    sampleRate: 48000,
    channelCount: 2,
  };
  return { video, audio };
}

/**
 * Constraints to (re)acquire just one device kind — a mid-session switch must
 * not touch the other track (it would blink the preview and the recording).
 */
export function buildSwitchConstraints(
  settings: CaptureSettings,
  kind: "audio" | "video",
  deviceId: string
): MediaStreamConstraints {
  const full = buildConstraints({
    ...settings,
    cameraId: kind === "video" ? deviceId : settings.cameraId,
    microphoneId: kind === "audio" ? deviceId : settings.microphoneId,
  });
  return kind === "audio"
    ? { audio: full.audio as MediaTrackConstraints, video: false }
    : { audio: false, video: full.video };
}

/**
 * Shared AudioContext for level meters. Browsers cap the number of contexts per
 * page (~6 in Chrome), so one meter per video tile must not create its own.
 */
let meterCtx: AudioContext | null = null;
function meterContext(): AudioContext {
  if (!meterCtx || meterCtx.state === "closed") meterCtx = new AudioContext();
  if (meterCtx.state === "suspended") void meterCtx.resume();
  return meterCtx;
}

/**
 * Poll sound level from a stream (local or remote). Calls onLevel(level, peak)
 * per animation frame:
 * - level — display level 0..1: RMS boosted ×3 so normal speech is visible;
 * - peak — loudest raw sample 0..1 in the window; ~1.0 means full-scale
 *   samples, i.e. digital clipping.
 * Returns a cleanup function.
 */
export function watchMicLevel(
  stream: MediaStream,
  onLevel: (level: number, peak: number) => void
): () => void {
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) return () => {};
  const ctx = meterContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let raf = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    let peak = 0;
    for (const v of data) {
      const centered = (v - 128) / 128;
      sum += centered * centered;
      const abs = Math.abs(centered);
      if (abs > peak) peak = abs;
    }
    onLevel(Math.min(1, Math.sqrt(sum / data.length) * 3), Math.min(1, peak));
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(raf);
    source.disconnect();
    analyser.disconnect();
  };
}
