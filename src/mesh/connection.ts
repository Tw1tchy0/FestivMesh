import { AppState } from 'react-native';
import { notifyMessage } from '../notifications';
import { friendName, useMesh } from '../store/useMesh';
import { BleTransport } from './bleTransport';
import { BridgeTransport } from './bridgeTransport';
import { MeshClient, type MeshSink } from './meshClient';
import { parsePin } from './pins';
import { SimTransport, SIM_DEFAULT_CENTER, SIM_MY_NUM } from './simTransport';
import type { Transport } from './transport';

/** Retry quickly at first, then back off so a radio with a dead battery doesn't drain the phone too. */
const RECONNECT_MS = 5000;
const RECONNECT_MAX_MS = 60_000;

let client: MeshClient | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MS;
let wantConnected = false;

// iOS freezes the app in the background (no presence beacons, retries paused), so catch up on return.
AppState.addEventListener('change', (s) => {
  if (s !== 'active' || !wantConnected) return;
  const st = useMesh.getState().status;
  if (client?.ready) void client.sendPresence().catch(() => {});
  else if (st === 'error' || st === 'disconnected') {
    reconnectDelay = RECONNECT_MS;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    void connect().catch(() => {});
  }
});

const sink: MeshSink = {
  setStatus: (status, detail) => {
    useMesh.getState().setStatus(status, detail);
    if (status === 'error' && wantConnected) scheduleReconnect();
  },
  setRadioInfo: (info) => useMesh.getState().setRadioInfo(info),
  upsertNode: (u, opts) => useMesh.getState().upsertNode(u, opts),
  markPresence: (num, at, battery) => useMesh.getState().markPresence(num, at, battery),
  onText: (e) => {
    const s = useMesh.getState();
    // Only direct messages to us belong in a chat; channel broadcasts are ignored for now.
    if (e.to !== s.myNodeNum) return;
    if (s.messages.some((m) => !m.fromMe && m.packetId === e.id && m.peer === e.from)) return; // radio re-delivery
    // A DM is deliberate, so its sender becomes a friend even when heard on the public channel.
    s.upsertNode({ num: e.from, lastHeard: e.rxTime }, { live: true, befriend: true });
    const pin = parsePin(e.text);
    if (pin) s.setPin(e.from, { lat: pin.lat, lon: pin.lon, at: e.rxTime });
    s.addMessage({
      key: `${e.from}-${e.id}`,
      packetId: e.id,
      peer: e.from,
      fromMe: false,
      text: e.text,
      at: e.rxTime,
      status: 'received',
    });
    const sender = useMesh.getState().nodes[e.from];
    notifyMessage(e.from, sender ? friendName(sender) : 'New message', pin ? '📍 Shared a meeting point' : e.text);
  },
  onAck: (requestId, state, error) => useMesh.getState().setMessageStatus(requestId, state, error),
  onLateAck: (from, requestId) => useMesh.getState().setMessageStatus(requestId, 'delivered', undefined, from),
};

function makeTransport(): Transport {
  const { settings } = useMesh.getState();
  switch (settings.transport) {
    case 'bridge':
      return new BridgeTransport(settings.bridgeUrl);
    case 'ble':
      if (!settings.bleDeviceId) throw new Error('Pick a radio first');
      return new BleTransport(settings.bleDeviceId);
    default:
      return new SimTransport(() => useMesh.getState().myLocation);
  }
}

/** Removes simulator friends when switching to a real radio, so they don't linger on the compass. */
function dropSimNodes() {
  const s = useMesh.getState();
  for (const n of Object.values(s.nodes)) if ((n.num & 0xffffff00) === (SIM_MY_NUM & 0xffffff00)) s.forgetNode(n.num);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (wantConnected) void connect().catch(() => {});
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

export async function connect() {
  wantConnected = true;
  await teardown();
  const s = useMesh.getState();
  if (s.settings.transport !== 'sim') {
    dropSimNodes();
    if (s.myLocation?.lat === SIM_DEFAULT_CENTER.lat && s.myLocation.lon === SIM_DEFAULT_CENTER.lon) s.setMyLocation(null);
  }
  // Demo without GPS (simulator, browser preview): stand in the simulated park until a real fix arrives.
  else if (!s.myLocation) s.setMyLocation({ ...SIM_DEFAULT_CENTER, at: Date.now() });
  const c = new MeshClient(makeTransport(), sink);
  client = c;
  try {
    await c.start();
    reconnectDelay = RECONNECT_MS;
  } catch (e) {
    useMesh.getState().setStatus('error', (e as Error).message);
    scheduleReconnect();
    throw e;
  }
}

async function teardown() {
  const old = client;
  client = null;
  useMesh.getState().setRadioInfo({ configReady: false });
  if (old) await old.stop().catch(() => {});
}

export async function disconnect() {
  wantConnected = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  await teardown();
  useMesh.getState().setStatus('disconnected');
}

export function getClient(): MeshClient | null {
  return client;
}

/** Sends a DM and records it in the chat with live delivery status. */
export async function sendMessage(peer: number, text: string) {
  const s = useMesh.getState();
  const c = client;
  const at = Date.now();
  if (!c || !c.ready) {
    s.addMessage({ key: `me-${at}`, packetId: 0, peer, fromMe: true, text, at, status: 'failed', error: 'Radio not connected' });
    return;
  }
  try {
    const packetId = await c.sendText(peer, text);
    s.addMessage({ key: `me-${packetId}`, packetId, peer, fromMe: true, text, at, status: 'sending' });
  } catch (e) {
    s.addMessage({ key: `me-${at}`, packetId: 0, peer, fromMe: true, text, at, status: 'failed', error: (e as Error).message });
  }
}
