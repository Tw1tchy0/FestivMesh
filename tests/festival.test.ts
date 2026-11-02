// Festival scenarios, run against the real store, connection manager and bridge transport.
// A fake WebSocket plays the T-Beam; "relaunching" reloads the app's modules from what was saved to disk.
import { create, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import { Mesh, Portnums } from '@meshtastic/protobufs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  writes: 0,
  appState: [] as ((s: string) => void)[],
  appNow: 'active',
  alerts: [] as { title: string; body: string; peer: number }[],
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => h.disk.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      h.writes++;
      h.disk.set(k, v);
    },
    removeItem: async (k: string) => void h.disk.delete(k),
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    get currentState() {
      return h.appNow;
    },
    addEventListener: (_: string, cb: (s: string) => void) => {
      h.appState.push(cb);
      return { remove() {} };
    },
  },
}));
vi.mock('expo-notifications', () => ({
  setNotificationHandler: () => {},
  scheduleNotificationAsync: async (r: { content: { title: string; body: string; data: { peer: number } } }) => {
    h.alerts.push({ title: r.content.title, body: r.content.body, peer: r.content.data.peer });
    return 'id';
  },
}));
vi.mock('expo-constants', () => ({
  default: { executionEnvironment: 'storeClient' },
  ExecutionEnvironment: { StoreClient: 'storeClient' },
}));

const ME = 0x1f9fe9bc;
const FRIEND = 0x1f9ff5fc;
const BRIDGE = 'ws://test:8787';

type FromRadioInit = MessageInitShape<typeof Mesh.FromRadioSchema>;

/** Stands in for the PC bridge + T-Beam: answers the config handshake and lets tests inject packets. */
class FakeSocket {
  static current: FakeSocket | null = null;
  static reachable = true;
  static attempts = 0;
  /** 32 random bytes = a private festival channel; [1] = Meshtastic's public default key. */
  static psk = new Uint8Array(32).fill(9);
  /** The radio's stored node list, sent before its channels like real firmware. */
  static nodeDb: FromRadioInit[] = [];
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  sent: Mesh.ToRadio[] = [];

  constructor(readonly url: string) {
    FakeSocket.attempts++;
    setTimeout(() => {
      if (!FakeSocket.reachable) {
        this.onerror?.();
        this.onclose?.();
        return;
      }
      FakeSocket.current = this;
      this.onopen?.();
    }, 10);
  }
  send(buf: ArrayBuffer) {
    const msg = fromBinary(Mesh.ToRadioSchema, new Uint8Array(buf));
    this.sent.push(msg);
    if (msg.payloadVariant.case === 'wantConfigId') {
      const id = msg.payloadVariant.value;
      queueMicrotask(() => {
        this.push({ payloadVariant: { case: 'myInfo', value: { myNodeNum: ME } } });
        FakeSocket.nodeDb.forEach((n) => this.push(n));
        this.push({ payloadVariant: { case: 'channel', value: { index: 0, role: 1, settings: { name: 'festival', psk: FakeSocket.psk } } } });
        this.push({ payloadVariant: { case: 'configCompleteId', value: id } });
      });
    }
  }
  /** Like a real socket, the close event arrives later (after the close handshake), here after a new socket opened. */
  close() {
    setTimeout(() => this.onclose?.(), 30);
  }
  /** The link drops from the radio's side (Bluetooth out of range, USB pulled, bridge stopped). */
  drop() {
    if (FakeSocket.current === this) FakeSocket.current = null;
    this.onclose?.();
  }
  push(init: FromRadioInit) {
    this.onmessage?.({ data: toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, init)).slice().buffer });
  }
  sentTexts() {
    return this.sent
      .map((m) => (m.payloadVariant.case === 'packet' ? m.payloadVariant.value : null))
      .filter((p) => p?.payloadVariant.case === 'decoded' && p.payloadVariant.value.portnum === Portnums.PortNum.TEXT_MESSAGE_APP);
  }
}
vi.stubGlobal('WebSocket', FakeSocket);

const radio = () => {
  if (!FakeSocket.current) throw new Error('not connected');
  return FakeSocket.current;
};

function packet(from: number, portnum: Portnums.PortNum, payload: Uint8Array, extra: object = {}): FromRadioInit {
  return {
    payloadVariant: {
      case: 'packet',
      value: { from, to: ME, ...extra, payloadVariant: { case: 'decoded', value: { portnum, payload, ...('requestId' in extra ? { requestId: extra.requestId as number } : {}) } } },
    },
  };
}
const ackFrom = (from: number, requestId: number) =>
  packet(from, Portnums.PortNum.ROUTING_APP, toBinary(Mesh.RoutingSchema, create(Mesh.RoutingSchema, { variant: { case: 'errorReason', value: 0 } })), { requestId });
const textFrom = (from: number, id: number, text: string) =>
  packet(from, Portnums.PortNum.TEXT_MESSAGE_APP, new TextEncoder().encode(text), { id });
const positionFrom = (from: number, lat: number, lon: number, rxTime = 0) =>
  packet(
    from,
    Portnums.PortNum.POSITION_APP,
    toBinary(Mesh.PositionSchema, create(Mesh.PositionSchema, { latitudeI: Math.round(lat * 1e7), longitudeI: Math.round(lon * 1e7) })),
    { to: 0xffffffff, rxTime },
  );
const presenceFrom = (from: number) => packet(from, Portnums.PortNum.PRIVATE_APP, new Uint8Array([0x46, 0x43, 1, 80]), { to: 0xffffffff });

async function launchApp() {
  vi.resetModules();
  h.appState.length = 0;
  const { useMesh, selectFriends, selectNearbyRadios } = await import('../src/store/useMesh');
  const connection = await import('../src/mesh/connection');
  await vi.waitFor(() => expect(useMesh.persist.hasHydrated()).toBe(true));
  return { useMesh, selectFriends, selectNearbyRadios, connection };
}
type App = Awaited<ReturnType<typeof launchApp>>;

async function connectRadio(app: App) {
  app.useMesh.getState().updateSettings({ transport: 'bridge', bridgeUrl: BRIDGE });
  const p = app.connection.connect();
  await vi.advanceTimersByTimeAsync(20);
  await p;
  await vi.advanceTimersByTimeAsync(0);
  expect(app.useMesh.getState()).toMatchObject({ status: 'connected', configReady: true });
}

/** The OS kills the process: timers stop, unsaved state is lost, the radio link goes away. */
function killApp() {
  vi.clearAllTimers();
  FakeSocket.current = null;
}
const appGoesTo = async (s: 'active' | 'background') => {
  h.appNow = s;
  h.appState.forEach((cb) => cb(s));
  await vi.advanceTimersByTimeAsync(0);
};
const myMessages = (app: App) => app.useMesh.getState().messages;

beforeEach(() => {
  vi.useFakeTimers();
  h.disk.clear();
  h.writes = 0;
  FakeSocket.current = null;
  FakeSocket.reachable = true;
  FakeSocket.attempts = 0;
  FakeSocket.psk = new Uint8Array(32).fill(9);
  FakeSocket.nodeDb = [];
  h.appNow = 'active';
  h.alerts = [];
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('festival scenarios', () => {
  it('phone dies mid-send: after relaunch the message says failed, then flips to delivered when the late ACK arrives', async () => {
    let app = await launchApp();
    await connectRadio(app);
    await app.connection.sendMessage(FRIEND, 'meet at the ferris wheel');
    const id = radio().sentTexts()[0]!.id;
    expect(myMessages(app)[0].status).toBe('sending');
    await vi.advanceTimersByTimeAsync(3000); // throttled save lands

    killApp();
    app = await launchApp();
    expect(myMessages(app)[0]).toMatchObject({ status: 'failed', error: 'App closed before their radio confirmed' });

    await connectRadio(app);
    radio().push(ackFrom(FRIEND, id)); // their radio's ACK, queued on ours while the phone was off
    expect(myMessages(app)[0].status).toBe('delivered');
  });

  it('swiped out of the app: messages and unread counts are saved immediately, not after the save delay', async () => {
    let app = await launchApp();
    await connectRadio(app);
    radio().push(textFrom(FRIEND, 501, 'by the main stage'));
    await appGoesTo('background'); // flushes without waiting
    killApp();

    app = await launchApp();
    expect(myMessages(app).map((m) => m.text)).toEqual(['by the main stage']);
    expect(app.useMesh.getState().unread[FRIEND]).toBe(1);
  });

  it('radio link drops mid-send: message fails, app reconnects, re-delivered DMs are not duplicated, late ACK lands', async () => {
    const app = await launchApp();
    await connectRadio(app);
    await app.connection.sendMessage(FRIEND, 'coming to you');
    const id = radio().sentTexts()[0]!.id;

    radio().drop();
    expect(app.useMesh.getState().status).toBe('error');

    await vi.advanceTimersByTimeAsync(5100); // automatic retry replaces the old connection
    expect(app.useMesh.getState()).toMatchObject({ status: 'connected', configReady: true });
    expect(myMessages(app)[0]).toMatchObject({ status: 'failed', error: 'Disconnected before their radio confirmed' });

    radio().push(textFrom(FRIEND, 77, 'ok'));
    radio().push(textFrom(FRIEND, 77, 'ok')); // radio hands the same packet over again
    radio().push(ackFrom(FRIEND, id));
    expect(myMessages(app).filter((m) => !m.fromMe)).toHaveLength(1);
    expect(myMessages(app).find((m) => m.fromMe)!.status).toBe('delivered');
  });

  it('reconnecting to the bridge keeps the new connection status (old socket closing late used to show Disconnected)', async () => {
    const app = await launchApp();
    await connectRadio(app);
    const p = app.connection.connect(); // e.g. tapping Connect again or changing the bridge URL
    await vi.advanceTimersByTimeAsync(50);
    await p;
    expect(app.useMesh.getState().status).toBe('connected');
  });

  it("radio battery dies: retries back off instead of every 5 s, then reconnect right away when you open the app", async () => {
    const app = await launchApp();
    await connectRadio(app);
    FakeSocket.reachable = false;
    radio().drop();
    FakeSocket.attempts = 0;
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(FakeSocket.attempts).toBeLessThanOrEqual(6); // 5, 10, 20, 40, 60 s… (was 36 at a fixed 5 s)
    expect(app.useMesh.getState().status).toBe('error');

    FakeSocket.reachable = true; // swapped the battery
    await appGoesTo('active');
    await vi.advanceTimersByTimeAsync(50);
    expect(app.useMesh.getState()).toMatchObject({ status: 'connected', configReady: true });
  });

  it('opening the app again tells friends right away that you can be messaged', async () => {
    const app = await launchApp();
    await connectRadio(app);
    const presences = () =>
      radio().sent.filter((m) => {
        const d = m.payloadVariant.case === 'packet' ? m.payloadVariant.value.payloadVariant : null;
        return d?.case === 'decoded' && d.value.portnum === Portnums.PortNum.PRIVATE_APP;
      }).length;
    const before = presences();
    await appGoesTo('active');
    expect(presences()).toBe(before + 1);
  });

  it("friend's phone locks or dies but their T-Beam stays on: still on the compass and messageable, shown as phone away", async () => {
    const app = await launchApp();
    await connectRadio(app);
    radio().push(positionFrom(FRIEND, 40.7681, -73.9819));
    radio().push(presenceFrom(FRIEND));
    const friend = () => app.selectFriends(app.useMesh.getState().nodes, ME, Date.now())[0];
    expect(friend()).toMatchObject({ canMessage: true, phoneActive: true, fresh: true });

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    radio().push(positionFrom(FRIEND, 40.769, -73.982)); // radio keeps reporting, no app beacon
    await vi.advanceTimersByTimeAsync(150_000);
    expect(friend()).toMatchObject({ canMessage: true, phoneActive: false, fresh: true });

    await vi.advanceTimersByTimeAsync(10 * 60_000); // their radio's battery dies too
    expect(friend()).toMatchObject({ canMessage: true, phoneActive: false, fresh: false });
    expect(friend().position?.lat).toBeCloseTo(40.769);

    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000); // no app beacon all day: treated as radio only again
    expect(friend().canMessage).toBe(false);
  });

  it('a radio-only friend (never ran the app) can be tracked but not messaged', async () => {
    const app = await launchApp();
    await connectRadio(app);
    radio().push(positionFrom(FRIEND, 40.7681, -73.9819));
    const friend = app.selectFriends(app.useMesh.getState().nodes, ME, Date.now())[0];
    expect(friend).toMatchObject({ canMessage: false, phoneActive: false, fresh: true });
  });

  it('the radio restarts (low battery brown-out, settings change): the app downloads its config again', async () => {
    const app = await launchApp();
    await connectRadio(app);
    const configRequests = () => radio().sent.filter((m) => m.payloadVariant.case === 'wantConfigId').length;
    radio().push({ payloadVariant: { case: 'rebooted', value: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(configRequests()).toBe(2);
    expect(app.useMesh.getState().configReady).toBe(true);
  });

  it("an old position from the radio's stored node list never replaces a newer live one", async () => {
    const app = await launchApp();
    await connectRadio(app);
    radio().push(positionFrom(FRIEND, 40.77, -73.98));
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    radio().push({
      payloadVariant: {
        case: 'nodeInfo',
        value: { num: FRIEND, lastHeard: hourAgo, position: { latitudeI: 407000000, longitudeI: -739000000, time: hourAgo } },
      },
    });
    expect(app.useMesh.getState().nodes[FRIEND].position?.lat).toBeCloseTo(40.77);
  });

  it('a radio without a GPS clock yet (cold start) still shows friends as live', async () => {
    const app = await launchApp();
    await connectRadio(app);
    radio().push(positionFrom(FRIEND, 40.77, -73.98, 0)); // rxTime 0 = radio has no time
    expect(app.selectFriends(app.useMesh.getState().nodes, ME, Date.now())[0].fresh).toBe(true);
  });

  it('a 9th radio on the channel is hidden instead of taking a color', async () => {
    const app = await launchApp();
    await connectRadio(app);
    for (let i = 1; i <= 9; i++) radio().push(positionFrom(0x1000 + i, 40.77, -73.98));
    const nodes = app.useMesh.getState().nodes;
    expect(app.selectFriends(nodes, ME)).toHaveLength(8);
    expect(nodes[0x1009].hidden).toBe(true);
  });

  it('GPS updates every second do not rewrite the saved data; a new message is saved once', async () => {
    const app = await launchApp();
    await connectRadio(app);
    await vi.advanceTimersByTimeAsync(3000);
    const writes = h.writes;
    for (let i = 0; i < 30; i++) {
      app.useMesh.getState().setMyLocation({ lat: 40.77 + i * 1e-5, lon: -73.98, at: Date.now() });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(h.writes).toBe(writes);

    radio().push(textFrom(FRIEND, 9, 'hi'));
    radio().push(positionFrom(FRIEND, 40.77, -73.98));
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.writes).toBe(writes + 1);
  });

  it('on the public channel, strangers are not auto-added: they wait under Nearby radios until you add them', async () => {
    FakeSocket.psk = new Uint8Array([1]);
    const app = await launchApp();
    await connectRadio(app);
    for (let i = 1; i <= 5; i++) radio().push(positionFrom(0x2000 + i, 40.77, -73.98));
    const st = () => app.useMesh.getState();
    expect(app.selectFriends(st().nodes, ME)).toHaveLength(0);
    expect(app.selectNearbyRadios(st().nodes, ME, Date.now())).toHaveLength(5);

    expect(st().addFriend(0x2003)).toBe(true);
    expect(app.selectFriends(st().nodes, ME).map((f) => f.num)).toEqual([0x2003]);
    expect(app.selectNearbyRadios(st().nodes, ME, Date.now())).toHaveLength(4);
  });

  it('on the public channel, someone who DMs you becomes a friend so the chat shows up', async () => {
    FakeSocket.psk = new Uint8Array([1]);
    const app = await launchApp();
    await connectRadio(app);
    radio().push(textFrom(FRIEND, 3, 'hey its sam'));
    expect(app.selectFriends(app.useMesh.getState().nodes, ME).map((f) => f.num)).toEqual([FRIEND]);
  });

  it("the radio's stored node list arrives before its channels and still adds friends on a private channel", async () => {
    const now = Math.floor(Date.now() / 1000);
    FakeSocket.nodeDb = [
      {
        payloadVariant: {
          case: 'nodeInfo',
          value: { num: FRIEND, channel: 0, lastHeard: now, user: { longName: 'Maya' }, position: { latitudeI: 407700000, longitudeI: -739800000, time: now } },
        },
      },
    ];
    const app = await launchApp();
    await connectRadio(app);
    expect(app.selectFriends(app.useMesh.getState().nodes, ME).map((f) => f.name)).toEqual(['Maya']);
  });

  it('a new message pops an alert with their name, except while you are looking at that chat', async () => {
    const app = await launchApp();
    await connectRadio(app);
    const { setOpenChat } = await import('../src/notifications');
    const user = toBinary(Mesh.UserSchema, create(Mesh.UserSchema, { longName: 'Maya' }));
    radio().push(packet(FRIEND, Portnums.PortNum.NODEINFO_APP, user, { to: 0xffffffff }));

    setOpenChat(FRIEND);
    radio().push(textFrom(FRIEND, 1, 'here'));
    expect(h.alerts).toHaveLength(0);

    await appGoesTo('background'); // phone locked with the chat open (the Bluetooth build keeps receiving)
    radio().push(textFrom(FRIEND, 2, 'at the gate'));
    radio().push(textFrom(FRIEND, 3, '\u{1F4CD} 40.77001,-73.98002 Meet me here'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.alerts).toEqual([
      { title: 'Maya', body: 'at the gate', peer: FRIEND },
      { title: 'Maya', body: '\u{1F4CD} Shared a meeting point', peer: FRIEND },
    ]);
  });

  describe('noticing a friend has gone quiet', () => {
    const friendAfter = async (app: App, ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      return app.selectFriends(app.useMesh.getState().nodes, ME, Date.now())[0];
    };

    it('a walking friend (update every 20 s) who walks out of range shows as last known after 90 s, not 5 min', async () => {
      const app = await launchApp();
      await connectRadio(app);
      for (let i = 0; i < 6; i++) {
        radio().push(positionFrom(FRIEND, 40.77 + i * 2e-4, -73.98));
        await vi.advanceTimersByTimeAsync(20_000);
      }
      // Last update was 20 s ago; nothing more arrives.
      expect((await friendAfter(app, 50_000)).fresh).toBe(true); // 70 s of silence
      expect((await friendAfter(app, 25_000)).fresh).toBe(false); // 95 s
    });

    it('a friend standing still (update every 2 min) survives one lost update, and shows as last known after 5 min', async () => {
      const app = await launchApp();
      await connectRadio(app);
      for (let i = 0; i < 4; i++) {
        radio().push(positionFrom(FRIEND, 40.77, -73.98));
        if (i < 3) await vi.advanceTimersByTimeAsync(120_000);
      }
      expect((await friendAfter(app, 4 * 60_000)).fresh).toBe(true); // one update lost
      expect((await friendAfter(app, 70_000)).fresh).toBe(false); // 5 min 10 s
    });

    it('a friend who stops walking is back to live as soon as their 2-minute update arrives', async () => {
      const app = await launchApp();
      await connectRadio(app);
      for (let i = 0; i < 6; i++) {
        radio().push(positionFrom(FRIEND, 40.77 + i * 2e-4, -73.98));
        if (i < 5) await vi.advanceTimersByTimeAsync(20_000);
      }
      expect((await friendAfter(app, 80_000)).fresh).toBe(true);
      expect((await friendAfter(app, 30_000)).fresh).toBe(false); // 110 s: could be gone, could have stopped
      radio().push(positionFrom(FRIEND, 40.771, -73.98)); // 2 min after their last walking update
      expect((await friendAfter(app, 10_000)).fresh).toBe(true);
      expect((await friendAfter(app, 110_000)).fresh).toBe(true); // rhythm has slowed to match
    });
  });
});
