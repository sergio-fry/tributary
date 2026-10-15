import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ParticipantInfo } from "./api";
import { buildSwitchConstraints, selectedDevices, type CaptureSettings } from "./media";
import { RecordingEngine, type QualityPreset } from "./recorder/recorder";
import type { UploadHealth } from "./recorder/upload-manager";
import { fetchRtcConfig, PeerManager, type RemoteMedia } from "./rtc/peers";
import { LiveKitManager } from "./rtc/livekit";
import { ProgramStreamer, type ProgramSource } from "./streaming";
import { Signaling, type ChatMessage, type Peer, type PeerDevices, type PeerState } from "./rtc/signaling";

export type RoomPeer = Peer & { media: RemoteMedia };

export type RoomConfig = {
  sessionId: string;
  participant: ParticipantInfo;
  token: string;
  isHost: boolean;
  preset: QualityPreset;
  recordWav: boolean;
  cameraStream: MediaStream;
  /** Capture settings from the lobby — reused when switching devices mid-session. */
  settings: CaptureSettings;
};

export type RecordingState = { recordingId: string; startedAtMs: number } | null;

export function useRoom(config: RoomConfig) {
  const [peers, setPeers] = useState<Map<string, RoomPeer>>(new Map());
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [recording, setRecording] = useState<RecordingState>(null);
  const [countdownEndsAt, setCountdownEndsAt] = useState<number | null>(null);
  const [uploadsPaused, setUploadsPaused] = useState(false);
  const [myUpload, setMyUpload] = useState<UploadHealth | null>(null);
  const [connected, setConnected] = useState(false);
  const [replaced, setReplaced] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [waitingGuests, setWaitingGuests] = useState<Peer[]>([]);
  const [myDevices, setMyDevices] = useState<PeerDevices>({ mic: null, cam: null });
  const [teleprompter, setTeleprompter] = useState("");
  const [live, setLive] = useState(false);
  const [watchToken, setWatchToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every device switch: the camera stream object stays the same, so
  // this is how consumers (level meters, previews) learn to rebind tracks.
  const [deviceRev, setDeviceRev] = useState(0);

  const signalingRef = useRef<Signaling | null>(null);
  const peerManagerRef = useRef<PeerManager | null>(null);
  const livekitRef = useRef<LiveKitManager | null>(null);
  const streamerRef = useRef<ProgramStreamer | null>(null);
  const sourcesRef = useRef<ProgramSource[]>([]);
  const engineRef = useRef<RecordingEngine | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const recordingRef = useRef<RecordingState>(null);
  const lastHealthSentAt = useRef(0);

  const updatePeer = useCallback((participantId: string, patch: Partial<RoomPeer>) => {
    setPeers((prev) => {
      const existing = prev.get(participantId);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(participantId, { ...existing, ...patch });
      return next;
    });
  }, []);

  useEffect(() => {
    const engine = new RecordingEngine({
      sessionId: config.sessionId,
      participantToken: config.token,
      preset: config.preset,
      videoBitrateBps: config.settings.videoBitrateMbps
        ? Math.round(config.settings.videoBitrateMbps * 1_000_000)
        : null,
      onAggregateHealth: (health) => {
        setMyUpload(health);
        const now = Date.now();
        if (now - lastHealthSentAt.current > 1000 || health.state === "complete") {
          lastHealthSentAt.current = now;
          signalingRef.current?.sendUploadHealth(health);
        }
      },
      onError: (message) => setError(message),
    });
    engineRef.current = engine;

    const rtcConfigPromise = fetchRtcConfig();
    const signaling = new Signaling(config.token, {
      onWelcome: async (_self, existingPeers, activeRecording, extras) => {
        setWaiting(false);
        setTeleprompter(extras.teleprompter ?? "");
        if (extras.waiting) setWaitingGuests(extras.waiting);
        const transportConfig = await rtcConfigPromise;
        const onMedia = (pid: string, media: RemoteMedia) => updatePeer(pid, { media });

        if (transportConfig.mode === "livekit" && transportConfig.livekitUrl && !livekitRef.current) {
          // SFU mode: LiveKit carries media; everything else stays on our WS.
          const lk = new LiveKitManager(transportConfig.livekitUrl, config.token, onMedia);
          livekitRef.current = lk;
          lk.setCameraStream(config.cameraStream);
          if (screenStreamRef.current) void lk.setScreenStream(screenStreamRef.current);
          lk.connect().catch((err) =>
            setError(`Live call (SFU) failed: ${err instanceof Error ? err.message : err}`)
          );
        } else if (transportConfig.mode === "mesh") {
          const pm = new PeerManager(signaling, config.participant.id, onMedia, transportConfig.rtc);
          peerManagerRef.current = pm;
          pm.setCameraStream(config.cameraStream);
          if (screenStreamRef.current) pm.setScreenStream(screenStreamRef.current);
        }

        setPeers(() => {
          const map = new Map<string, RoomPeer>();
          for (const peer of existingPeers) {
            map.set(peer.participantId, {
              ...peer,
              devices: peer.devices ?? null,
              media: { camera: null, screen: null },
            });
            peerManagerRef.current?.addPeer(peer.participantId); // mesh: newcomer initiates offers
          }
          return map;
        });
        signaling.sendState(currentState());
        // Announce our devices — the WebSocket may not have been open when the
        // initial label state was computed, so (re)send on every welcome.
        signaling.sendDevices(selectedDevices(config.cameraStream));

        if (activeRecording && !recordingRef.current) {
          beginLocalRecording(activeRecording.recordingId, activeRecording.startedAtMs);
        }
      },
      onPeerJoined: (peer) => {
        setPeers((prev) => {
          const next = new Map(prev);
          next.set(peer.participantId, {
            ...peer,
            devices: peer.devices ?? null,
            media: { camera: null, screen: null },
          });
          return next;
        });
      },
      onPeerLeft: (participantId) => {
        peerManagerRef.current?.removePeer(participantId);
        setPeers((prev) => {
          const next = new Map(prev);
          next.delete(participantId);
          return next;
        });
      },
      onSignal: (from, data) => {
        void peerManagerRef.current?.handleSignal(from, data);
      },
      onPeerState: (participantId, state: PeerState) => updatePeer(participantId, { state }),
      onPeerDevices: (participantId, devices) => updatePeer(participantId, { devices }),
      onPeerUpload: (participantId, health) => updatePeer(participantId, { upload: health }),
      onChat: (msg) => setChat((prev) => [...prev.slice(-199), msg]),
      onRecordingStarted: (recordingId, startedAtMs) => {
        setCountdownEndsAt(null);
        beginLocalRecording(recordingId, startedAtMs);
      },
      onRecordingStopped: () => {
        engineRef.current?.stopAll();
        recordingRef.current = null;
        setRecording(null);
      },
      onRecordingCountdown: (_seconds, startsAtMs) => setCountdownEndsAt(startsAtMs),
      onRecordingCountdownCancelled: () => setCountdownEndsAt(null),
      onWaitingRoom: () => setWaiting(true),
      onDeclined: () => setDeclined(true),
      onWaitingGuest: (peer) =>
        setWaitingGuests((prev) =>
          prev.some((p) => p.participantId === peer.participantId) ? prev : [...prev, peer]
        ),
      onWaitingLeft: (participantId) =>
        setWaitingGuests((prev) => prev.filter((p) => p.participantId !== participantId)),
      onForceMute: () => {
        for (const track of config.cameraStream.getAudioTracks()) track.enabled = false;
        setMicOn(false);
        signalingRef.current?.sendState({
          mic: false,
          cam: config.cameraStream.getVideoTracks().some((t) => t.enabled),
          sharing: Boolean(screenStreamRef.current),
        });
        setError("The host muted your microphone.");
      },
      onTeleprompter: (script) => setTeleprompter(script),
      onLiveChanged: setLive,
      onReplaced: () => setReplaced(true),
      onConnectionChange: setConnected,
    });
    signalingRef.current = signaling;
    signaling.connect();

    function currentState(): PeerState {
      return {
        mic: config.cameraStream.getAudioTracks().some((t) => t.enabled),
        cam: config.cameraStream.getVideoTracks().some((t) => t.enabled),
        sharing: Boolean(screenStreamRef.current),
      };
    }

    function beginLocalRecording(recordingId: string, startedAtMs: number) {
      const state = { recordingId, startedAtMs };
      recordingRef.current = state;
      setRecording(state);
      void engine.startTrack(
        recordingId,
        startedAtMs,
        signaling.clockOffsetMs,
        "camera",
        config.cameraStream
      );
      if (config.recordWav) {
        void engine.startPcmTrack(recordingId, startedAtMs, signaling.clockOffsetMs, config.cameraStream);
      }
      if (screenStreamRef.current) {
        void engine.startTrack(
          recordingId,
          startedAtMs,
          signaling.clockOffsetMs,
          "screen",
          screenStreamRef.current
        );
      }
    }

    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (engineRef.current?.isRecording || engineRef.current?.hasPendingUploads()) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);

    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      engine.stopAll();
      signaling.close();
      peerManagerRef.current?.closeAll();
      livekitRef.current?.close();
      streamerRef.current?.stop();
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.sessionId, config.token]);

  // Track the devices behind the camera stream (labels change on mid-session
  // switches) and announce them so the people panel can show what everyone is
  // capturing with. The welcome handler re-sends them once the WS is up.
  useEffect(() => {
    const next = selectedDevices(config.cameraStream);
    setMyDevices((prev) =>
      prev.mic === next.mic && prev.cam === next.cam ? prev : next
    );
  }, [config.cameraStream, deviceRev]);

  useEffect(() => {
    if (myDevices.mic === null && myDevices.cam === null) return;
    signalingRef.current?.sendDevices(myDevices);
  }, [myDevices]);

  const sendState = useCallback(() => {
    signalingRef.current?.sendState({
      mic: config.cameraStream.getAudioTracks().some((t) => t.enabled),
      cam: config.cameraStream.getVideoTracks().some((t) => t.enabled),
      sharing: Boolean(screenStreamRef.current),
    });
  }, [config.cameraStream]);

  const toggleMic = useCallback(() => {
    for (const track of config.cameraStream.getAudioTracks()) track.enabled = !track.enabled;
    setMicOn(config.cameraStream.getAudioTracks().some((t) => t.enabled));
    sendState();
  }, [config.cameraStream, sendState]);

  const toggleCam = useCallback(() => {
    for (const track of config.cameraStream.getVideoTracks()) track.enabled = !track.enabled;
    setCamOn(config.cameraStream.getVideoTracks().some((t) => t.enabled));
    sendState();
  }, [config.cameraStream, sendState]);

  /**
   * Switch the camera or microphone mid-session: replace the track inside the
   * live camera stream (same MediaStream object, so previews and senders keep
   * working) and, while recording, continue capture as a fresh local segment —
   * MediaRecorder only records tracks present at start, so the old segment is
   * finalized and a new one begins on the new device.
   */
  const switchDevice = useCallback(
    async (kind: "audio" | "video", deviceId: string) => {
      const stream = config.cameraStream;
      const oldTracks = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
      try {
        const media = await navigator.mediaDevices.getUserMedia(
          buildSwitchConstraints(config.settings, kind, deviceId)
        );
        const newTrack =
          kind === "audio" ? media.getAudioTracks()[0] : media.getVideoTracks()[0];
        if (!newTrack) throw new Error("The selected device did not provide a track");

        // Carry the current mute/camera-off state onto the new device.
        newTrack.enabled = oldTracks[0]?.enabled ?? true;

        for (const t of oldTracks) stream.removeTrack(t);
        stream.addTrack(newTrack);

        const rec = recordingRef.current;
        const engine = engineRef.current;
        const signaling = signalingRef.current;
        if (rec && engine && signaling) {
          engine.stopTracksOfKind("camera");
          engine.stopTracksOfKind("pcm");
          void engine.startTrack(
            rec.recordingId,
            rec.startedAtMs,
            signaling.clockOffsetMs,
            "camera",
            stream
          );
          if (config.recordWav) {
            void engine.startPcmTrack(rec.recordingId, rec.startedAtMs, signaling.clockOffsetMs, stream);
          }
        }

        // Mesh renegotiates around the new track; the SFU republishes it.
        peerManagerRef.current?.setCameraStream(stream);
        void livekitRef.current?.setCameraStream(stream);

        for (const t of oldTracks) t.stop();
        setDeviceRev((v) => v + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not switch device");
      }
    },
    [config.cameraStream, config.settings, config.recordWav]
  );

  const stopShare = useCallback(() => {
    engineRef.current?.stopTracksOfKind("screen");
    const stream = screenStreamRef.current;
    screenStreamRef.current = null;
    setScreenStream(null);
    peerManagerRef.current?.setScreenStream(null);
    void livekitRef.current?.setScreenStream(null);
    stream?.getTracks().forEach((t) => t.stop());
    sendState();
  }, [sendState]);

  const startShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
      });
      screenStreamRef.current = stream;
      setScreenStream(stream);
      peerManagerRef.current?.setScreenStream(stream);
      void livekitRef.current?.setScreenStream(stream);
      sendState();
      stream.getVideoTracks()[0]?.addEventListener("ended", () => stopShare());
      const rec = recordingRef.current;
      if (rec && engineRef.current && signalingRef.current) {
        void engineRef.current.startTrack(
          rec.recordingId,
          rec.startedAtMs,
          signalingRef.current.clockOffsetMs,
          "screen",
          stream
        );
      }
    } catch {
      // user cancelled the picker
    }
  }, [sendState, stopShare]);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      await api(`/api/sessions/${config.sessionId}/recording/start`, { body: {} });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start recording");
    }
  }, [config.sessionId]);

  const stopRecording = useCallback(async () => {
    try {
      await api(`/api/sessions/${config.sessionId}/recording/stop`, { body: {} });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop recording");
    }
  }, [config.sessionId]);

  const sendChat = useCallback((text: string) => {
    signalingRef.current?.sendChat(text);
  }, []);

  const admitGuest = useCallback((participantId: string) => {
    signalingRef.current?.sendAdmit(participantId);
  }, []);

  const declineGuest = useCallback((participantId: string) => {
    signalingRef.current?.sendDecline(participantId);
  }, []);

  const muteGuest = useCallback((participantId: string) => {
    signalingRef.current?.sendForceMute(participantId);
  }, []);

  const saveTeleprompter = useCallback((script: string) => {
    setTeleprompter(script);
    signalingRef.current?.sendTeleprompter(script);
  }, []);

  const toggleUploadsPaused = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const next = !engine.isUploadsPaused;
    engine.setUploadsPaused(next);
    setUploadsPaused(next);
  }, []);

  const peerList = useMemo(() => [...peers.values()], [peers]);

  // Keep the program-out source list current for the live-stream compositor.
  useEffect(() => {
    const sources: ProgramSource[] = [
      { name: config.participant.name, stream: config.cameraStream, kind: "camera" },
    ];
    if (screenStream) sources.push({ name: "Screen", stream: screenStream, kind: "screen" });
    for (const p of peerList) {
      if (p.media.camera) sources.push({ name: p.name, stream: p.media.camera, kind: "camera" });
      if (p.media.screen) sources.push({ name: `${p.name} — screen`, stream: p.media.screen, kind: "screen" });
    }
    sourcesRef.current = sources;
  }, [peerList, screenStream, config.cameraStream, config.participant.name]);

  const goLive = useCallback(
    async (rtmpUrl: string | null) => {
      setError(null);
      try {
        const streamer = new ProgramStreamer(() => sourcesRef.current);
        streamer.onStatus = (isLive, err) => {
          setLive(isLive);
          if (err) setError(`Live stream: ${err}`);
        };
        streamerRef.current = streamer;
        await streamer.start(config.token, rtmpUrl);
        const status = await api<{ watchToken: string }>("/api/live-status", { token: config.token });
        setWatchToken(status.watchToken);
      } catch (err) {
        streamerRef.current = null;
        setError(err instanceof Error ? err.message : "Could not start live stream");
      }
    },
    [config.token]
  );

  const stopLive = useCallback(() => {
    streamerRef.current?.stop();
    streamerRef.current = null;
  }, []);

  return {
    peers: peerList,
    chat,
    sendChat,
    micOn,
    camOn,
    myDevices,
    toggleMic,
    toggleCam,
    switchDevice,
    deviceRev,
    screenStream,
    startShare,
    stopShare,
    recording,
    countdownEndsAt,
    startRecording,
    stopRecording,
    uploadsPaused,
    toggleUploadsPaused,
    myUpload,
    connected,
    replaced,
    waiting,
    declined,
    waitingGuests,
    admitGuest,
    declineGuest,
    muteGuest,
    teleprompter,
    saveTeleprompter,
    live,
    watchToken,
    goLive,
    stopLive,
    error,
    dismissError: () => setError(null),
  };
}
