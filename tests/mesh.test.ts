import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { Admin, Channel, Config, Mesh, Portnums } from '@meshtastic/protobufs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Deframer, frame } from '../bridge/framing.mjs';
import { fromBase64, toBase64 } from '../src/mesh/base64';
import { MeshClient, type MeshSink } from '../src/mesh/meshClient';
import {
  decodeChannelUrl,
  decodeFromRadio,
  encodeChannelUrl,
  encodePresence,
  encodeText,
  newFestivalChannel,
} from '../src/mesh/protocol';
import { SimTransport } from '../src/mesh/simTransport';
import { BaseTransport } from '../src/mesh/transport';

describe('base64', () => {
  it('round-trips arbitrary bytes in both alphabets', () => {
    const bytes = new Uint8Array(Array.from({ length: 257 }, (_, i) => (i * 37) & 0xff));
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(fromBase64(toBase64(bytes, true))).toEqual(bytes);
    expect(toBase64(new Uint8Array([0xfb, 0xff]), true)).toBe('-_8');
  });
});

describe('serial framing', () => {
  it('extracts frames split across chunks and keeps log text', () => {
    const frames: Uint8Array[] = [];
    const logs: string[] = [];
    const d = new Deframer((f: Uint8Array) => frames.push(f), (l: string) => logs.push(l));
    const a = frame(new Uint8Array([1, 2, 3]));
    const b = frame(new Uint8Array(300).fill(9));
    const log = new TextEncoder().encode('INFO | GPS fix\r\n');
    const stream = new Uint8Array([...log, ...a, ...b]);
    for (let i = 0; i < stream.length; i += 7) d.feed(stream.slice(i, i + 7));
    expect(frames).toHaveLength(2);
    expect([...frames[0]]).toEqual([1, 2, 3]);
    expect(frames[1].length).toBe(300);
    expect(logs).toEqual(['INFO | GPS fix']);
  });
});

describe('protocol', () => {
  it('encodes a DM as a TEXT_MESSAGE_APP packet that wants an ACK', () => {
    const tr = fromBinary(Mesh.ToRadioSchema, encodeText(0xabc, 'meet at the ferris wheel', 77));
    expect(tr.payloadVariant.case).toBe('packet');
    const p = tr.payloadVariant.value as Mesh.MeshPacket;
    expect(p.to).toBe(0xabc);
    expect(p.id).toBe(77);
    expect(p.wantAck).toBe(true);
    const d = p.payloadVariant.value as Mesh.Data;
    expect(d.portnum).toBe(Portnums.PortNum.TEXT_MESSAGE_APP);
    expect(new TextDecoder().decode(d.payload)).toBe('meet at the ferris wheel');
  });

  it('decodes positions from packets and scales lat/lon', () => {
    const pos = create(Mesh.PositionSchema, { latitudeI: 407681000, longitudeI: -739819000, time: 1_700_000_000 });
    const fr = create(Mesh.FromRadioSchema, {
      payloadVariant: {
        case: 'packet',
        value: {
          from: 5,
          to: 0xffffffff,
          rxTime: 1_800_000_000,
          hopStart: 3,
          hopLimit: 1,
          payloadVariant: {
            case: 'decoded',
            value: { portnum: Portnums.PortNum.POSITION_APP, payload: toBinary(Mesh.PositionSchema, pos) },
          },
        },
      },
    });
    const [e] = decodeFromRadio(toBinary(Mesh.FromRadioSchema, fr));
    expect(e.kind).toBe('node');
    if (e.kind !== 'node') return;
    expect(e.live).toBe(true);
    expect(e.node.position!.lat).toBeCloseTo(40.7681, 6);
    expect(e.node.position!.lon).toBeCloseTo(-73.9819, 6);
    expect(e.node.position!.time).toBe(1_800_000_000_000); // receive time, not sender clock
    expect(e.node.hopsAway).toBe(2);
  });

  it('round-trips presence beacons', () => {
    const tr = fromBinary(Mesh.ToRadioSchema, encodePresence(1, 64));
    const p = tr.payloadVariant.value as Mesh.MeshPacket;
    const fr = create(Mesh.FromRadioSchema, { payloadVariant: { case: 'packet', value: { ...p, from: 9 } } });
    const events = decodeFromRadio(toBinary(Mesh.FromRadioSchema, fr));
    expect(events.find((e) => e.kind === 'presence')).toMatchObject({ from: 9, battery: 64 });
  });

  it('round-trips festival channel share links', () => {
    const psk = new Uint8Array(32).map((_, i) => i);
    const url = encodeChannelUrl(newFestivalChannel(psk, 'festival'));
    expect(url.startsWith('https://meshtastic.org/e/#')).toBe(true);
    const set = decodeChannelUrl(url);
    expect(set.settings[0].name).toBe('festival');
    expect([...set.settings[0].psk]).toEqual([...psk]);
    expect(set.settings[0].moduleSettings?.positionPrecision).toBe(32);
  });
});

class Recorder implements MeshSink {
  status: string[] = [];
  nodes = new Map<number, unknown>();
  texts: string[] = [];
  acks: [number, string, string?][] = [];
  presence: number[] = [];
  info: Record<string, unknown> = {};
  setStatus = (s: string) => void this.status.push(s);
  setRadioInfo = (i: object) => void Object.assign(this.info, i);
  upsertNode = (u: { num: number }) => void this.nodes.set(u.num, u);
  markPresence = (num: number) => void this.presence.push(num);
  onText = (e: { text: string }) => void this.texts.push(e.text);
  onAck = (id: number, state: string, err?: string) => void this.acks.push([id, state, err]);
  lateAcks: [number, number][] = [];
  onLateAck = (from: number, id: number) => void this.lateAcks.push([from, id]);
}

class Loopback extends BaseTransport {
  kind = 'sim' as const;
  written: Uint8Array[] = [];
  async connect() {}
  async disconnect() {}
  async write(b: Uint8Array) {
    this.written.push(b);
  }
  push(b: Uint8Array) {
    this.emit(b);
  }
}

describe('MeshClient against the simulated radio', () => {
  afterEach(() => vi.useRealTimers());

  it('completes the config handshake, then DMs get ACKed and answered', async () => {
    vi.useFakeTimers();
    const sink = new Recorder();
    const transport = new SimTransport(() => ({ lat: 40.7681, lon: -73.9819 }));
    const client = new MeshClient(transport, sink);
    await client.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.ready).toBe(true);
    expect(sink.info).toMatchObject({ configReady: true, firmware: '2.7.0-sim' });
    expect(client.config.lora).toBeDefined();
    expect(sink.nodes.size).toBeGreaterThanOrEqual(5);

    const maya = 0x5ee00002;
    const id = await client.sendText(maya, 'where are you?');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sink.acks).toContainEqual([id, 'sent', undefined]);
    expect(sink.acks).toContainEqual([id, 'delivered', undefined]);
    expect(sink.texts.length).toBe(1);

    const sam = 0x5ee00005; // out of range
    const id2 = await client.sendText(sam, 'hello?');
    await vi.advanceTimersByTimeAsync(9000);
    expect(sink.acks.find((a) => a[0] === id2)?.[1]).toBe('failed');

    await vi.advanceTimersByTimeAsync(31000);
    expect(sink.presence).toContain(maya);
    expect(sink.presence).not.toContain(0x5ee00004); // radio-only friend never beacons
    await client.stop();
  });

  it('festival setup writes a private full-precision channel, position and LoRa config to the local radio', async () => {
    const t = new Loopback();
    const c = new MeshClient(t, new Recorder());
    const fromRadio = (init: object) => t.push(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, init as never)));
    fromRadio({ payloadVariant: { case: 'myInfo', value: { myNodeNum: 0x1234 } } });
    fromRadio({ payloadVariant: { case: 'config', value: { payloadVariant: { case: 'lora', value: { region: 1, txPower: 22 } } } } });
    await c.requestConfig();
    const want = fromBinary(Mesh.ToRadioSchema, t.written.at(-1)!).payloadVariant.value as number;
    fromRadio({ payloadVariant: { case: 'configCompleteId', value: want } });
    expect(c.ready).toBe(true);

    t.written = [];
    const psk = new Uint8Array(32).fill(3);
    await c.applyFestivalSetup({ channel: newFestivalChannel(psk), preset: Config.Config_LoRaConfig_ModemPreset.MEDIUM_FAST });
    const admins = t.written.map((b) => {
      const p = fromBinary(Mesh.ToRadioSchema, b).payloadVariant.value as Mesh.MeshPacket;
      expect(p.to).toBe(0x1234);
      const d = p.payloadVariant.value as Mesh.Data;
      expect(d.portnum).toBe(Portnums.PortNum.ADMIN_APP);
      return fromBinary(Admin.AdminMessageSchema, d.payload).payloadVariant;
    });
    expect(admins.map((a) => a.case)).toEqual(['beginEditSettings', 'setChannel', 'setConfig', 'setConfig', 'commitEditSettings']);
    const ch = admins[1].value as Channel.Channel;
    expect(ch.role).toBe(Channel.Channel_Role.PRIMARY);
    expect(ch.settings?.moduleSettings?.positionPrecision).toBe(32);
    expect([...ch.settings!.psk]).toEqual([...psk]);
    const pos = (admins[2].value as Config.Config).payloadVariant.value as Config.Config_PositionConfig;
    expect(pos.positionBroadcastSmartEnabled).toBe(true);
    expect(pos.positionBroadcastSecs).toBe(120); // standing still
    expect(pos.broadcastSmartMinimumDistance).toBe(10); // moving: after 10 m…
    expect(pos.broadcastSmartMinimumIntervalSecs).toBe(15); // …at most every 15 s
    const lora = (admins[3].value as Config.Config).payloadVariant.value as Config.Config_LoRaConfig;
    expect(lora.modemPreset).toBe(Config.Config_LoRaConfig_ModemPreset.MEDIUM_FAST);
    expect(lora.region).toBe(1); // kept from the radio
    expect(lora.txPower).toBe(22); // other LoRa settings preserved
    await c.stop();
  });

  it('renaming shows the radio as syncing, then re-downloads its config after the restart', async () => {
    vi.useFakeTimers();
    const t = new Loopback();
    const sink = new Recorder();
    const c = new MeshClient(t, sink);
    t.push(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, { payloadVariant: { case: 'myInfo', value: { myNodeNum: 7 } } })));
    await c.setOwner('Aviv', 'AVIV');
    const admin = fromBinary(Mesh.ToRadioSchema, t.written[0]).payloadVariant.value as Mesh.MeshPacket;
    const owner = fromBinary(Admin.AdminMessageSchema, (admin.payloadVariant.value as Mesh.Data).payload).payloadVariant;
    expect(owner).toMatchObject({ case: 'setOwner', value: { longName: 'Aviv', shortName: 'AVIV' } });
    expect(sink.info.configReady).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fromBinary(Mesh.ToRadioSchema, t.written.at(-1)!).payloadVariant.case).toBe('wantConfigId');
    await c.stop();
  });

  it('only accepts a real ACK from the destination as "delivered"', async () => {
    const t = new Loopback();
    const sink = new Recorder();
    const c = new MeshClient(t, sink);
    const ack = (from: number, requestId: number) => {
      const routing = toBinary(Mesh.RoutingSchema, create(Mesh.RoutingSchema, { variant: { case: 'errorReason', value: 0 } }));
      return toBinary(
        Mesh.FromRadioSchema,
        create(Mesh.FromRadioSchema, {
          payloadVariant: {
            case: 'packet',
            value: { from, to: 1, payloadVariant: { case: 'decoded', value: { portnum: 5, payload: routing, requestId } } },
          },
        }),
      );
    };
    t.push(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, { payloadVariant: { case: 'myInfo', value: { myNodeNum: 1 } } })));
    const id = await c.sendText(2, 'hi');
    t.push(ack(1, id)); // our own radio: implicit ack
    expect(sink.acks).toEqual([[id, 'sent', undefined]]);
    t.push(ack(2, id));
    expect(sink.acks.at(-1)).toEqual([id, 'delivered', undefined]);
    await c.stop();
  });

  it('fails unconfirmed DMs on disconnect, and forwards ACKs that arrive afterwards', async () => {
    const t = new Loopback();
    const sink = new Recorder();
    const c = new MeshClient(t, sink);
    t.push(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, { payloadVariant: { case: 'myInfo', value: { myNodeNum: 1 } } })));
    const id = await c.sendText(2, 'hi');
    await c.stop();
    expect(sink.acks).toEqual([[id, 'failed', 'Disconnected before their radio confirmed']]);

    const c2 = new MeshClient(t, sink);
    const routing = toBinary(Mesh.RoutingSchema, create(Mesh.RoutingSchema, { variant: { case: 'errorReason', value: 0 } }));
    t.push(
      toBinary(
        Mesh.FromRadioSchema,
        create(Mesh.FromRadioSchema, {
          payloadVariant: {
            case: 'packet',
            value: { from: 2, to: 1, payloadVariant: { case: 'decoded', value: { portnum: 5, payload: routing, requestId: id } } },
          },
        }),
      ),
    );
    expect(sink.lateAcks).toContainEqual([2, id]);
    await c2.stop();
  });
});
