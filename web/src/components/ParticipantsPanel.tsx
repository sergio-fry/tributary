import type { ReactNode } from "react";
import type { UploadHealth } from "../lib/recorder/upload-manager";
import type { PeerDevices } from "../lib/rtc/signaling";
import { Badge } from "./ui";
import { CamIcon, CamOffIcon, MicIcon, MicOffIcon } from "./icons";

export type PanelParticipant = {
  id: string;
  name: string;
  role: "host" | "guest";
  isSelf: boolean;
  micOn: boolean;
  camOn: boolean;
  /** Self joined with the audio preset — there is no camera track at all. */
  audioOnly: boolean;
  devices: PeerDevices | null;
  upload: UploadHealth | null;
};

function DeviceLine({
  icon,
  label,
  off,
  offNote,
}: {
  icon: ReactNode;
  label: string;
  /** Muted / camera-off: dim the line and say so next to the label. */
  off?: boolean;
  offNote?: string;
}) {
  return (
    <div
      className={`flex items-center gap-2 text-xs ${off ? "text-gray-500" : "text-gray-300"}`}
      title={label}
    >
      <span className={off ? "text-rec" : "text-gray-400"}>{icon}</span>
      <span className="truncate">{label}</span>
      {off && offNote && <span className="shrink-0 font-medium text-amber-400/90">{offNote}</span>}
    </div>
  );
}

function ParticipantRow({ p }: { p: PanelParticipant }) {
  const micLabel = p.devices?.mic?.trim() || "Unknown microphone";
  const camLabel = p.audioOnly
    ? "Audio only — no camera"
    : !p.camOn
      ? p.devices?.cam?.trim() || "Camera off"
      : p.devices?.cam?.trim() || (p.devices ? "No camera" : "Unknown camera");
  return (
    <div className="rounded-xl bg-panel-2 p-3">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent to-accent-2/60 text-sm font-semibold text-white">
          {p.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <span className="truncate text-sm font-medium text-gray-100">
            {p.name}
            {p.isSelf ? " (you)" : ""}
          </span>
          {p.role === "host" && (
            <span className="ml-2 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-2">
              Host
            </span>
          )}
        </div>
        {p.upload && p.upload.state !== "complete" && (
          <Badge tone={p.upload.state === "delayed" || p.upload.state === "failed" ? "red" : "blue"}>
            ⇡ {p.upload.percent}%
          </Badge>
        )}
      </div>
      <div className="mt-2 flex flex-col gap-1.5 pl-10">
        <DeviceLine
          icon={p.micOn ? <MicIcon width={14} height={14} /> : <MicOffIcon width={14} height={14} />}
          label={micLabel}
          off={!p.micOn}
          offNote="muted"
        />
        {!p.audioOnly && (
          <DeviceLine
            icon={p.camOn ? <CamIcon width={14} height={14} /> : <CamOffIcon width={14} height={14} />}
            label={camLabel}
            off={!p.camOn}
            offNote="off"
          />
        )}
      </div>
    </div>
  );
}

/**
 * People panel: the in-call roster with everyone's selected microphone and
 * camera. Device labels are announced by each participant over signaling and
 * update live, including mid-session device switches.
 */
export function ParticipantsPanel({
  participants,
  onClose,
}: {
  participants: PanelParticipant[];
  onClose: () => void;
}) {
  return (
    <div className="flex h-full w-80 flex-col border-l border-edge bg-panel">
      <div className="flex items-center justify-between border-b border-edge px-4 py-3">
        <h2 className="text-sm font-semibold">
          People <span className="ml-1 text-gray-500">{participants.length}</span>
        </h2>
        <button onClick={onClose} className="text-gray-400 hover:text-white">
          ✕
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
        {participants.map((p) => (
          <ParticipantRow key={p.id} p={p} />
        ))}
      </div>
    </div>
  );
}
