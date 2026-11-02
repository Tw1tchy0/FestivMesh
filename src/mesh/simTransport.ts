import { create, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import { Channel, Config, Mesh, Portnums } from '@meshtastic/protobufs';
import { offset, type LatLon } from '../geo';
import { BROADCAST, randomId } from './protocol';
import { BaseTransport } from './transport';

const MY_NUM = 0x5ee00001;
export const SIM_DEFAULT_CENTER: LatLon = { lat: 40.7681, lon: -73.9819 }; // used until the phone has a GPS fix

type SimFriend = {
  num: number;
  longName: string;
  shortName: string;
  hasApp: boolean;
  /** Distance (m) and bearing over time; `null` = gone quiet. */
  path: (t: number) => { dist: number; bearing: number } | null;
  replies: string[];
};

const FRIENDS: SimFriend[] = [
  {
    num: 0x5ee00002,
    longName: 'Maya',
    shortName: 'MAYA',
    hasApp: true,
    path: (t) => ({ dist: 260 + 140 * Math.sin(t / 40), bearing: (40 + t * 0.6) % 360 }),
    replies: ['At the main stage, left side 🎶', 'Coming to you!', 'Water station by the ferris wheel'],
  },
  {
    num: 0x5ee00003,
    longName: 'Jonah',
    shortName: 'JNH',
    hasApp: true,
    // Walks in from ~900 m to arrive next to you, waits, then wanders off again (90 s cycle).
    path: (t) => {
      const c = t % 90;
      const dist = c < 50 ? 900 * (1 - c / 50) + 6 : c < 65 ? 6 : 6 + (c - 65) * 18;
      return { dist, bearing: 200 };
    },
    replies: ['omw', 'Where are you??', 'ok 👍'],
  },
  {
    num: 0x5ee00004,
    longName: 'T-Beam 2',
    shortName: 'TB2',
    hasApp: false, // radio only: trackable, can't read DMs
    path: (t) => ({ dist: 70 + 25 * Math.sin(t / 7), bearing: (300 + 20 * Math.sin(t / 11)) % 360 }),
    replies: [],
  },
  {
    num: 0x5ee00005,
    longName: 'Sam',
    shortName: 'SAM',
    hasApp: true,
    path: () => null, // out of range: only a last-known position from 12 min ago
    replies: [],
  },
];

/**
 * A fake radio for Expo Go: speaks the same ToRadio/FromRadio protobufs as a real
 * T-Beam so the whole app (MeshClient included) runs without hardware.
 */
export class SimTransport extends BaseTransport {
  readonly kind = 'sim' as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private timeouts: ReturnType<typeof setTimeout>[] = [];
  private t0 = Date.now();
  private tick = 0;
  private replyIdx = new Map<number, number>();

  constructor(private getCenter: () => LatLon | null) {
    super();
  }

  async connect() {
    this.setStatus('connecting', 'Simulator');
    this.t0 = Date.now();
    this.setStatus('connected', 'Simulator');
    this.timer = setInterval(() => this.step(), 1000);
  }

  async disconnect() {
    if (this.timer) clearInterval(this.timer);
    this.timeouts.forEach(clearTimeout);
    this.timer = null;
    this.timeouts = [];
    this.setStatus('disconnected');
  }

  async write(bytes: Uint8Array) {
    const tr = fromBinary(Mesh.ToRadioSchema, bytes);
    const v = tr.payloadVariant;
    if (v.case === 'wantConfigId') this.later(50, () => this.sendConfig(v.value));
    if (v.case === 'packet' && v.value.payloadVariant.case === 'decoded') {
      const p = v.value;
      const d = v.value.payloadVariant.value;
      if (d.portnum === Portnums.PortNum.TEXT_MESSAGE_APP) this.onText(p.to, p.id);
      if (d.portnum === Portnums.PortNum.ADMIN_APP) this.later(300, () => this.ack(MY_NUM, p.id));
    }
  }

  // ---- fake radio behaviour ----

  private later(ms: number, fn: () => void) {
    this.timeouts.push(setTimeout(fn, ms));
  }

  private center(): LatLon {
    return this.getCenter() ?? SIM_DEFAULT_CENTER;
  }

  private fromRadio(init: MessageInitShape<typeof Mesh.FromRadioSchema>) {
    this.emit(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, init)));
  }

  private packet(from: number, to: number, portnum: Portnums.PortNum, payload: Uint8Array, extra: object = {}) {
    this.fromRadio({
      payloadVariant: {
        case: 'packet',
        value: {
          from,
          to,
          id: randomId(),
          rxTime: Math.floor(Date.now() / 1000),
          rxSnr: 6.5,
          hopStart: 3,
          hopLimit: 3,
          payloadVariant: { case: 'decoded', value: { portnum, payload, ...extra } },
        },
      },
    });
  }

  private pos(f: SimFriend, t: number): LatLon | null {
    const p = f.path(t);
    return p ? offset(this.center(), p.bearing, p.dist) : null;
  }

  private sendConfig(configId: number) {
    const now = Math.floor(Date.now() / 1000);
    this.fromRadio({ payloadVariant: { case: 'myInfo', value: { myNodeNum: MY_NUM } } });
    this.fromRadio({
      payloadVariant: { case: 'metadata', value: { firmwareVersion: '2.7.0-sim', hasBluetooth: true } },
    });
    this.fromRadio({
      payloadVariant: {
        case: 'nodeInfo',
        value: { num: MY_NUM, user: { longName: 'My T-Beam', shortName: 'ME' }, lastHeard: now },
      },
    });
    for (const f of FRIENDS) {
      const quiet = f.path(0) === null;
      const p = quiet ? offset(this.center(), 120, 1600) : this.pos(f, 0)!;
      this.fromRadio({
        payloadVariant: {
          case: 'nodeInfo',
          value: {
            num: f.num,
            user: { longName: f.longName, shortName: f.shortName },
            lastHeard: quiet ? now - 12 * 60 : now,
            position: {
              latitudeI: Math.round(p.lat * 1e7),
              longitudeI: Math.round(p.lon * 1e7),
              time: quiet ? now - 12 * 60 : now,
            },
            deviceMetrics: { batteryLevel: 40 + ((f.num * 7) % 55) },
            snr: 5,
            hopsAway: f.num % 2,
          },
        },
      });
    }
    this.fromRadio({
      payloadVariant: {
        case: 'config',
        value: create(Config.ConfigSchema, {
          payloadVariant: {
            case: 'lora',
            value: { usePreset: true, modemPreset: Config.Config_LoRaConfig_ModemPreset.MEDIUM_FAST, region: 1 },
          },
        }),
      },
    });
    this.fromRadio({
      payloadVariant: {
        case: 'config',
        value: create(Config.ConfigSchema, {
          payloadVariant: { case: 'position', value: { positionBroadcastSecs: 120, gpsMode: 1 } },
        }),
      },
    });
    this.fromRadio({
      payloadVariant: {
        case: 'channel',
        value: create(Channel.ChannelSchema, {
          index: 0,
          role: Channel.Channel_Role.PRIMARY,
          settings: { name: 'festival', psk: new Uint8Array(32).fill(7), moduleSettings: { positionPrecision: 32 } },
        }),
      },
    });
    this.fromRadio({ payloadVariant: { case: 'configCompleteId', value: configId } });
  }

  private step() {
    this.tick++;
    const t = (Date.now() - this.t0) / 1000;
    for (const f of FRIENDS) {
      const p = this.pos(f, t);
      if (!p) continue;
      // Stagger updates so friends don't all refresh in the same second.
      if ((this.tick + f.num) % 3 === 0) {
        const position = create(Mesh.PositionSchema, {
          latitudeI: Math.round(p.lat * 1e7),
          longitudeI: Math.round(p.lon * 1e7),
          time: Math.floor(Date.now() / 1000),
        });
        this.packet(f.num, BROADCAST, Portnums.PortNum.POSITION_APP, toBinary(Mesh.PositionSchema, position));
      }
      if (f.hasApp && (this.tick + f.num) % 30 === 1) {
        this.packet(f.num, BROADCAST, Portnums.PortNum.PRIVATE_APP, new Uint8Array([0x46, 0x43, 1, 80]));
      }
    }
  }

  private ack(from: number, requestId: number, error = Mesh.Routing_Error.NONE) {
    const routing = create(Mesh.RoutingSchema, { variant: { case: 'errorReason', value: error } });
    this.packet(from, MY_NUM, Portnums.PortNum.ROUTING_APP, toBinary(Mesh.RoutingSchema, routing), { requestId });
  }

  private onText(to: number, id: number) {
    const f = FRIENDS.find((x) => x.num === to);
    if (!f || f.path(0) === null) {
      // Out of range: the radio gives up after its retries.
      this.later(8000, () => this.ack(MY_NUM, id, Mesh.Routing_Error.MAX_RETRANSMIT));
      return;
    }
    this.later(400, () => this.ack(MY_NUM, id)); // implicit ack: heard a relay
    this.later(1600, () => this.ack(f.num, id)); // real ack from the friend's radio
    if (f.replies.length === 0) return;
    const i = this.replyIdx.get(f.num) ?? 0;
    this.replyIdx.set(f.num, i + 1);
    const reply = f.replies[i % f.replies.length];
    this.later(4500, () =>
      this.packet(f.num, MY_NUM, Portnums.PortNum.TEXT_MESSAGE_APP, new TextEncoder().encode(reply)),
    );
  }
}

export const SIM_MY_NUM = MY_NUM;
