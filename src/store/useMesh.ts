import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LatLon } from '../geo';
import type { NodeUpdate } from '../mesh/protocol';
import type { TransportKind, TransportStatus } from '../mesh/transport';
import { FRIEND_COLORS, MAX_FRIENDS } from '../theme';
import { createThrottledStorage } from './throttledStorage';

/** Their app beaconed this recently, so their phone is open right now. */
export const PRESENCE_TTL_MS = 5 * 60 * 1000; // two beacons (every 2 min) plus slack for one lost packet
/**
 * Their app beaconed within this window, so they use the app and can be messaged even while
 * their phone is locked (iOS pauses the app, so beacons stop). Their radio holds the DM until they open it.
 */
export const APP_USER_MS = 12 * 60 * 60 * 1000;
/**
 * Positions older than this are drawn as "last known" (breathing). Radios still send every 2 min
 * when standing still (festival setup), so this allows one lost update before a friend looks stale.
 */
export const FRESH_MS = 5 * 60 * 1000;
/**
 * A friend who usually sends often (walking: every 15–30 s) is "last known" once they've been
 * silent for this many of their usual gaps, so a radio that dies or walks out of range shows
 * within a minute or two instead of waiting the full FRESH_MS.
 */
const MISSED_GAPS = 3;
/** Never flag sooner than this: covers a friend who just stopped walking (their next update comes 2 min later). */
const MIN_SILENCE_MS = 90 * 1000;
/** Packets closer together than this are one burst (position + app beacon), not their rhythm. */
const MIN_GAP_MS = 5 * 1000;
/** A longer gap means we lost contact (or our phone was off), so the rhythm is learned again. */
const MAX_GAP_MS = 10 * 60 * 1000;
/** Nodes from the radio's stored list only become friends if heard this recently. */
const NODEDB_FRIEND_WINDOW_MS = 2 * 60 * 60 * 1000;

export type MeshNode = {
  num: number;
  longName?: string;
  shortName?: string;
  nickname?: string;
  position?: { lat: number; lon: number; time: number };
  lastHeard?: number;
  /** Their usual time between packets, averaged over recent ones. */
  gapMs?: number;
  battery?: number;
  snr?: number;
  hopsAway?: number;
  unmessagable?: boolean;
  presenceAt?: number;
  /** A meeting point they sent in a message ("📍 lat,lon"), shown on the compass. */
  pin?: { lat: number; lon: number; at: number };
  /** Index into FRIEND_COLORS; set when the node becomes a friend. */
  colorIdx?: number;
  hidden?: boolean;
};

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'failed' | 'received';
export type ChatMessage = {
  key: string;
  packetId: number;
  peer: number;
  fromMe: boolean;
  text: string;
  at: number;
  status: MessageStatus;
  error?: string;
};

export type Settings = {
  transport: TransportKind;
  bridgeUrl: string;
  bleDeviceId?: string;
  bleDeviceName?: string;
  units: 'metric' | 'imperial';
  keepAwake: boolean;
  myColor: string;
  myLongName: string;
  myShortName: string;
};

type State = {
  settings: Settings;
  nodes: Record<number, MeshNode>;
  messages: ChatMessage[];
  unread: Record<number, number>;
  // runtime only (not persisted)
  status: TransportStatus;
  statusDetail?: string;
  myNodeNum?: number;
  firmware?: string;
  configReady: boolean;
  /** Bumped whenever the radio's channel/config changes, so screens reading MeshClient re-render. */
  radioRev: number;
  myLocation: (LatLon & { accuracy?: number; at: number }) | null;
};

type Actions = {
  updateSettings: (s: Partial<Settings>) => void;
  setStatus: (status: TransportStatus, detail?: string) => void;
  setRadioInfo: (info: { myNodeNum?: number; firmware?: string; configReady?: boolean; bumpRadioRev?: boolean }) => void;
  upsertNode: (u: NodeUpdate, opts: { live: boolean; befriend: boolean }) => void;
  markPresence: (num: number, at: number, battery?: number) => void;
  updateFriend: (num: number, patch: Pick<MeshNode, 'nickname' | 'colorIdx' | 'hidden'>) => void;
  /** Makes a radio heard nearby a friend. False when all 8 colors are taken. */
  addFriend: (num: number) => boolean;
  forgetNode: (num: number) => void;
  setPin: (num: number, pin: MeshNode['pin']) => void;
  addMessage: (m: ChatMessage) => void;
  /** With `peer`, only updates that peer's message (used for late ACKs). */
  setMessageStatus: (packetId: number, status: MessageStatus, error?: string, peer?: number) => void;
  removeMessage: (key: string) => void;
  markRead: (peer: number) => void;
  setMyLocation: (l: State['myLocation']) => void;
};

const DEFAULT_SETTINGS: Settings = {
  transport: 'sim',
  bridgeUrl: 'ws://192.168.1.10:8787',
  units: 'metric',
  keepAwake: true,
  myColor: '#c9b6ff',
  myLongName: '',
  myShortName: '',
};

type Persisted = Pick<State, 'settings' | 'nodes' | 'messages' | 'unread'>;
const SAVE_EVERY_MS = 2000;
const saved = createThrottledStorage<Persisted>(AsyncStorage, SAVE_EVERY_MS);
// Save right away when the app is swiped away or the screen locks: it may never come back.
AppState.addEventListener('change', (s) => {
  if (s !== 'active') void saved.flush().catch(() => {});
});

function nextColor(nodes: Record<number, MeshNode>, myNum?: number): number | undefined {
  const used = new Set(
    Object.values(nodes)
      .filter((n) => n.num !== myNum && n.colorIdx !== undefined && !n.hidden)
      .map((n) => n.colorIdx!),
  );
  if (used.size >= MAX_FRIENDS) return undefined;
  for (let i = 0; i < FRIEND_COLORS.length; i++) if (!used.has(i)) return i;
  return undefined;
}

export const useMesh = create<State & Actions>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      nodes: {},
      messages: [],
      unread: {},
      status: 'disconnected',
      configReady: false,
      radioRev: 0,
      myLocation: null,

      updateSettings: (s) => set({ settings: { ...get().settings, ...s } }),
      setStatus: (status, statusDetail) => set({ status, statusDetail }),
      setRadioInfo: ({ bumpRadioRev, ...info }) => set((st) => ({ ...info, radioRev: st.radioRev + (bumpRadioRev ? 1 : 0) })),

      upsertNode: (u, { live, befriend }) =>
        set((st) => {
          const prev = st.nodes[u.num] ?? { num: u.num };
          const next: MeshNode = { ...prev };
          for (const [k, v] of Object.entries(u)) if (v !== undefined) (next as Record<string, unknown>)[k] = v;
          // Never let an older stored position replace a newer live one.
          if (u.position && prev.position && u.position.time < prev.position.time) next.position = prev.position;
          if (u.lastHeard && prev.lastHeard && u.lastHeard < prev.lastHeard) next.lastHeard = prev.lastHeard;
          if (live && u.lastHeard && prev.lastHeard) {
            const gap = u.lastHeard - prev.lastHeard;
            if (gap >= MAX_GAP_MS) next.gapMs = undefined;
            else if (gap >= MIN_GAP_MS) next.gapMs = prev.gapMs ? (prev.gapMs + gap) / 2 : gap;
          }

          const isMe = u.num === st.myNodeNum;
          const recent = (next.lastHeard ?? 0) > Date.now() - NODEDB_FRIEND_WINDOW_MS;
          if (!isMe && befriend && next.colorIdx === undefined && !next.hidden && (live || (recent && next.position))) {
            const c = nextColor(st.nodes, st.myNodeNum);
            if (c === undefined) next.hidden = true;
            else next.colorIdx = c;
          }
          return { nodes: { ...st.nodes, [u.num]: next } };
        }),

      markPresence: (num, at, battery) =>
        set((st) => {
          const n = st.nodes[num] ?? { num };
          return { nodes: { ...st.nodes, [num]: { ...n, presenceAt: at, battery: battery ?? n.battery } } };
        }),

      updateFriend: (num, patch) =>
        set((st) => {
          const n = st.nodes[num];
          if (!n) return {};
          const next = { ...n, ...patch };
          if (patch.hidden === false && next.colorIdx === undefined) next.colorIdx = nextColor(st.nodes, st.myNodeNum);
          return { nodes: { ...st.nodes, [num]: next } };
        }),

      addFriend: (num) => {
        const st = get();
        const n = st.nodes[num];
        if (!n) return false;
        if (n.colorIdx !== undefined && !n.hidden) return true;
        const free = nextColor(st.nodes, st.myNodeNum);
        if (free === undefined) return false; // 8 friends already
        // A friend shown again keeps their old color if nobody took it meanwhile.
        const taken = Object.values(st.nodes).some((o) => o.num !== num && !o.hidden && o.colorIdx === n.colorIdx);
        const colorIdx = n.colorIdx !== undefined && !taken ? n.colorIdx : free;
        set({ nodes: { ...st.nodes, [num]: { ...n, colorIdx, hidden: false } } });
        return true;
      },

      forgetNode: (num) =>
        set((st) => {
          const nodes = { ...st.nodes };
          delete nodes[num];
          return { nodes, messages: st.messages.filter((m) => m.peer !== num) };
        }),

      setPin: (num, pin) =>
        set((st) => (st.nodes[num] ? { nodes: { ...st.nodes, [num]: { ...st.nodes[num], pin } } } : {})),

      addMessage: (m) =>
        set((st) => ({
          messages: [...st.messages.slice(-999), m],
          unread: m.fromMe ? st.unread : { ...st.unread, [m.peer]: (st.unread[m.peer] ?? 0) + 1 },
        })),

      setMessageStatus: (packetId, status, error, peer) =>
        set((st) => ({
          messages: st.messages.map((m) =>
            m.fromMe && m.packetId === packetId && m.status !== 'delivered' && (peer === undefined || m.peer === peer)
              ? { ...m, status, error }
              : m,
          ),
        })),

      removeMessage: (key) => set((st) => ({ messages: st.messages.filter((m) => m.key !== key) })),
      markRead: (peer) => set((st) => ({ unread: { ...st.unread, [peer]: 0 } })),
      setMyLocation: (myLocation) => set({ myLocation }),
    }),
    {
      // Storage key from the app's first name; renaming it would lose saved friends and chats.
      name: 'festival-compass',
      storage: saved.storage,
      partialize: (s): Persisted => ({ settings: s.settings, nodes: s.nodes, messages: s.messages, unread: s.unread }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>; // undefined on first launch
        // ACK tracking doesn't survive the app closing, so anything still waiting would wait forever.
        // A late ACK from the recipient can still flip these to delivered.
        const messages = p.messages?.map((m) =>
          m.fromMe && (m.status === 'sending' || m.status === 'sent')
            ? { ...m, status: 'failed' as const, error: 'App closed before their radio confirmed' }
            : m,
        );
        return { ...current, ...p, ...(messages && { messages }), settings: { ...DEFAULT_SETTINGS, ...p.settings } };
      },
    },
  ),
);

// ---------- derived helpers ----------

export type FriendView = MeshNode & {
  name: string;
  color: string;
  /** Uses the app (beaconed today); radio-only friends can't read DMs. */
  canMessage: boolean;
  /** Their app is open right now. */
  phoneActive: boolean;
  fresh: boolean;
};

export function friendName(n: MeshNode): string {
  return n.nickname || n.longName || n.shortName || `!${n.num.toString(16).padStart(8, '0')}`;
}

export function toFriendView(n: MeshNode, now = Date.now()): FriendView {
  return {
    ...n,
    name: friendName(n),
    color: FRIEND_COLORS[n.colorIdx ?? 0],
    canMessage: !n.unmessagable && (n.presenceAt ?? 0) > now - APP_USER_MS,
    phoneActive: (n.presenceAt ?? 0) > now - PRESENCE_TTL_MS,
    fresh: (n.position?.time ?? 0) > now - FRESH_MS && (n.lastHeard ?? n.position?.time ?? 0) > now - silenceLimit(n),
  };
}

/** How long a friend can be silent before their dot shows "last known", based on how often they usually send. */
export function silenceLimit(n: Pick<MeshNode, 'gapMs'>): number {
  return n.gapMs === undefined ? FRESH_MS : Math.min(FRESH_MS, Math.max(MIN_SILENCE_MS, MISSED_GAPS * n.gapMs));
}

/** Radios heard recently that aren't friends: strangers on a public channel, or friends who haven't set up yet. */
export function selectNearbyRadios(nodes: Record<number, MeshNode>, myNum?: number, now = Date.now()): MeshNode[] {
  return Object.values(nodes)
    .filter((n) => n.num !== myNum && n.colorIdx === undefined && !n.hidden && (n.lastHeard ?? 0) > now - NODEDB_FRIEND_WINDOW_MS)
    .sort((a, b) => (b.lastHeard ?? 0) - (a.lastHeard ?? 0))
    .slice(0, 20);
}

export function selectFriends(nodes: Record<number, MeshNode>, myNum?: number, now = Date.now()): FriendView[] {
  return Object.values(nodes)
    .filter((n) => n.num !== myNum && n.colorIdx !== undefined && !n.hidden)
    .sort((a, b) => a.colorIdx! - b.colorIdx!)
    .map((n) => toFriendView(n, now));
}
