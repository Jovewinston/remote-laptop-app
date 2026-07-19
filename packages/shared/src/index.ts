export type AgentKind = "claude" | "codex";

export type SharingState = "off" | "available" | "busy";
export type SandboxState =
  | "idle"
  | "preparing"
  | "ready"
  | "cleaning"
  | "error";
export type ReservationStatus =
  | "upcoming"
  | "starting"
  | "connected"
  | "ended"
  | "cancelled";

export type SandboxBackend = "folder" | "vm";

export interface HostSnapshot {
  chip: string;
  modelName: string;
  ramGb: number;
  diskFreeGb: number;
  cpuLoad: number;
  batteryPercent: number | null;
  onPower: boolean;
  tailscaleConnected: boolean;
  tailscaleHostname: string | null;
  tailscaleIp: string | null;
  /** Login user on the lender Mac for SSH tunnels */
  sshUser: string | null;
  sharing: SharingState;
  sandbox: SandboxState;
  /** folder = ~/.bay/sandbox jobs; vm = Tart Linux sealed guest */
  sandboxBackend?: SandboxBackend;
  tartAvailable?: boolean;
  goldenImageReady?: boolean;
  /** Live prepare progress while sandbox === preparing */
  preparePhase?: string | null;
  prepareDetail?: string | null;
  collectedAt: string;
}

export interface HostPublic {
  id: string;
  displayName: string;
  ownerName: string;
  online: boolean;
  lastSeenAt: string | null;
  snapshot: HostSnapshot | null;
  nextFreeLabel: string | null;
}

export interface AvailabilityWindow {
  id: string;
  hostId: string;
  /** 0=Sun … 6=Sat */
  dayOfWeek: number;
  startHour: number;
  endHour: number;
}

/** Renter API-key handoff status (never includes the secret). */
export type GuestCredentialsStatus = "none" | "pending" | "applied";

export type ClaudeAuthStatus =
  | "none"
  | "requested"
  | "starting"
  | "awaiting_code"
  | "code_pending"
  | "done"
  | "error";

export interface ClaudeAuthPublic {
  status: ClaudeAuthStatus;
  loginUrl: string | null;
  error: string | null;
  detail?: string | null;
}

export interface Reservation {
  id: string;
  hostId: string;
  renterId: string;
  agent: AgentKind;
  startsAt: string;
  endsAt: string;
  status: ReservationStatus;
  repoUrl: string | null;
  cockpitPort: number | null;
  connectToken: string | null;
  hostDisplayName?: string;
  /** Whether renter API key was deposited / applied into the guest */
  guestCredentialsStatus?: GuestCredentialsStatus;
  /** Claude Pro/Max OAuth relay status (loginUrl is safe to show) */
  claudeAuth?: ClaudeAuthPublic;
}

export interface SessionConnectInfo {
  reservationId: string;
  localPort: number;
  remoteHost: string;
  remoteUser: string;
  remotePort: number;
  agent: AgentKind;
  sshTarget: string;
}

export const DEFAULT_COCKPIT_PORT = 3400;
export const HEARTBEAT_STALE_MS = 90_000;
