import { create, fromBinary, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import { Admin, AppOnly, Channel, Config, Mesh, Portnums, Telemetry } from '@meshtastic/protobufs';
import { fromBase64, toBase64 } from './base64';

export const BROADCAST = 0xffffffff;
export const MAX_TEXT_BYTES = 200;

// App-level presence beacon on PRIVATE_APP: "FC" + version + battery (255 = unknown).
// It tells friends a phone is running this app on that node, so it can receive DMs.
const PRESENCE_MAGIC = [0x46, 0x43];
const PRESENCE_VERSION = 1;

export function randomId(): number {
  // Meshtastic packet ids are non-zero uint32s.
  return (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------- encoding (phone -> radio) ----------

function toRadio(init: MessageInitShape<typeof Mesh.ToRadioSchema>): Uint8Array {
  return toBinary(Mesh.ToRadioSchema, create(Mesh.ToRadioSchema, init));
}

function packet(opts: {
  to: number;
  id: number;
  portnum: Portnums.PortNum;
  payload: Uint8Array;
  wantAck?: boolean;
  wantResponse?: boolean;
  channel?: number;
}): Uint8Array {
  return toRadio({
    payloadVariant: {
      case: 'packet',
      value: {
        to: opts.to,
        id: opts.id,
        channel: opts.channel ?? 0,
        wantAck: opts.wantAck ?? false,
        payloadVariant: {
          case: 'decoded',
          value: { portnum: opts.portnum, payload: opts.payload, wantResponse: opts.wantResponse ?? false },
        },
      },
    },
  });
}

export function encodeWantConfig(configId: number): Uint8Array {
  return toRadio({ payloadVariant: { case: 'wantConfigId', value: configId } });
}

export function encodeHeartbeat(): Uint8Array {
  return toRadio({ payloadVariant: { case: 'heartbeat', value: {} } });
}

export function encodeText(to: number, text: string, id: number): Uint8Array {
  return packet({
    to,
    id,
    portnum: Portnums.PortNum.TEXT_MESSAGE_APP,
    payload: new TextEncoder().encode(text),
    wantAck: true,
  });
}

export function encodePresence(id: number, battery?: number): Uint8Array {
  const payload = new Uint8Array([...PRESENCE_MAGIC, PRESENCE_VERSION, battery ?? 255]);
  return packet({ to: BROADCAST, id, portnum: Portnums.PortNum.PRIVATE_APP, payload });
}

export function decodePresence(payload: Uint8Array): { battery?: number } | null {
  if (payload.length < 3 || payload[0] !== PRESENCE_MAGIC[0] || payload[1] !== PRESENCE_MAGIC[1]) return null;
  const battery = payload[3];
  return { battery: battery === undefined || battery === 255 ? undefined : battery };
}

export type AdminInit = MessageInitShape<typeof Admin.AdminMessageSchema>;

export function encodeAdmin(to: number, id: number, admin: AdminInit, sessionPasskey?: Uint8Array): Uint8Array {
  const msg = create(Admin.AdminMessageSchema, admin);
  if (sessionPasskey) msg.sessionPasskey = sessionPasskey;
  return packet({
    to,
    id,
    portnum: Portnums.PortNum.ADMIN_APP,
    payload: toBinary(Admin.AdminMessageSchema, msg),
    wantAck: true,
    wantResponse: true,
  });
}

// ---------- decoding (radio -> phone) ----------

export type NodeUpdate = {
  num: number;
  longName?: string;
  shortName?: string;
  position?: { lat: number; lon: number; time: number };
  lastHeard?: number; // ms epoch
  battery?: number;
  snr?: number;
  hopsAway?: number;
  unmessagable?: boolean;
};

export type MeshEvent =
  | { kind: 'myInfo'; myNodeNum: number }
  | { kind: 'metadata'; firmwareVersion: string }
  /** `channel` is the local channel index the node was heard on. */
  | { kind: 'node'; node: NodeUpdate; live: boolean; channel: number }
  | { kind: 'config'; config: Config.Config }
  | { kind: 'channel'; channel: Channel.Channel }
  | { kind: 'configComplete'; id: number }
  | { kind: 'rebooted' }
  | { kind: 'text'; from: number; to: number; id: number; text: string; rxTime: number; channel: number }
  | { kind: 'presence'; from: number; battery?: number; rxTime: number }
  | { kind: 'ack'; from: number; requestId: number; error: Mesh.Routing_Error }
  | { kind: 'admin'; from: number; admin: Admin.AdminMessage };

function positionFrom(p: Mesh.Position | undefined, fallbackMs: number) {
  if (!p || !p.latitudeI || !p.longitudeI) return undefined;
  const t = p.time || p.timestamp;
  return { lat: p.latitudeI * 1e-7, lon: p.longitudeI * 1e-7, time: t ? t * 1000 : fallbackMs };
}

export function decodeFromRadio(bytes: Uint8Array, now = Date.now()): MeshEvent[] {
  if (bytes.length === 0) return [];
  const fr = fromBinary(Mesh.FromRadioSchema, bytes);
  const v = fr.payloadVariant;
  switch (v.case) {
    case 'myInfo':
      return [{ kind: 'myInfo', myNodeNum: v.value.myNodeNum }];
    case 'metadata':
      return [{ kind: 'metadata', firmwareVersion: v.value.firmwareVersion }];
    case 'nodeInfo': {
      const n = v.value;
      const lastHeard = n.lastHeard ? n.lastHeard * 1000 : undefined;
      return [
        {
          kind: 'node',
          live: false,
          channel: n.channel,
          node: {
            num: n.num,
            longName: n.user?.longName,
            shortName: n.user?.shortName,
            unmessagable: n.user?.isUnmessagable,
            position: positionFrom(n.position, lastHeard ?? now),
            lastHeard,
            battery: n.deviceMetrics?.batteryLevel,
            snr: n.snr,
            hopsAway: n.hopsAway,
          },
        },
      ];
    }
    case 'config':
      return [{ kind: 'config', config: v.value }];
    case 'channel':
      return [{ kind: 'channel', channel: v.value }];
    case 'configCompleteId':
      return [{ kind: 'configComplete', id: v.value }];
    case 'rebooted':
      return [{ kind: 'rebooted' }];
    case 'packet':
      return decodePacket(v.value, now);
    default:
      return [];
  }
}

function decodePacket(p: Mesh.MeshPacket, now: number): MeshEvent[] {
  if (p.payloadVariant.case !== 'decoded') return []; // encrypted on a channel we don't have
  const d = p.payloadVariant.value;
  const rxTime = p.rxTime ? p.rxTime * 1000 : now;
  const hopsAway = p.hopStart && p.hopLimit <= p.hopStart ? p.hopStart - p.hopLimit : undefined;
  const heard: MeshEvent = {
    kind: 'node',
    live: true,
    channel: p.channel,
    node: { num: p.from, lastHeard: rxTime, snr: p.rxSnr || undefined, hopsAway },
  };
  try {
    switch (d.portnum) {
      case Portnums.PortNum.TEXT_MESSAGE_APP:
        return [
          heard,
          {
            kind: 'text',
            from: p.from,
            to: p.to,
            id: p.id,
            text: new TextDecoder().decode(d.payload),
            rxTime,
            channel: p.channel,
          },
        ];
      case Portnums.PortNum.POSITION_APP: {
        const pos = positionFrom(fromBinary(Mesh.PositionSchema, d.payload), rxTime);
        if (!pos) return [heard];
        // Use receive time so a node with a wrong clock doesn't look stale.
        return [{ ...heard, node: { ...heard.node, position: { ...pos, time: rxTime } } } as MeshEvent];
      }
      case Portnums.PortNum.NODEINFO_APP: {
        const u = fromBinary(Mesh.UserSchema, d.payload);
        return [
          {
            ...heard,
            node: { ...heard.node, longName: u.longName, shortName: u.shortName, unmessagable: u.isUnmessagable },
          } as MeshEvent,
        ];
      }
      case Portnums.PortNum.TELEMETRY_APP: {
        const t = fromBinary(Telemetry.TelemetrySchema, d.payload);
        if (t.variant.case !== 'deviceMetrics') return [heard];
        return [{ ...heard, node: { ...heard.node, battery: t.variant.value.batteryLevel } } as MeshEvent];
      }
      case Portnums.PortNum.ROUTING_APP: {
        const r = fromBinary(Mesh.RoutingSchema, d.payload);
        const error = r.variant.case === 'errorReason' ? r.variant.value : Mesh.Routing_Error.NONE;
        return d.requestId ? [{ kind: 'ack', from: p.from, requestId: d.requestId, error }] : [];
      }
      case Portnums.PortNum.PRIVATE_APP: {
        const pres = decodePresence(d.payload);
        return pres ? [heard, { kind: 'presence', from: p.from, battery: pres.battery, rxTime }] : [heard];
      }
      case Portnums.PortNum.ADMIN_APP:
        return [{ kind: 'admin', from: p.from, admin: fromBinary(Admin.AdminMessageSchema, d.payload) }];
      default:
        return [heard];
    }
  } catch {
    return [heard]; // malformed payload: still counts as "heard"
  }
}

// ---------- festival channel share links (same format as the official apps) ----------

const URL_PREFIX = 'https://meshtastic.org/e/#';

export function encodeChannelUrl(settings: Channel.ChannelSettings, lora?: Config.Config_LoRaConfig): string {
  const set = create(AppOnly.ChannelSetSchema, { settings: [settings], loraConfig: lora });
  return URL_PREFIX + toBase64(toBinary(AppOnly.ChannelSetSchema, set), true);
}

export function decodeChannelUrl(url: string): AppOnly.ChannelSet {
  const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : url;
  const set = fromBinary(AppOnly.ChannelSetSchema, fromBase64(hash.split('?')[0]));
  if (set.settings.length === 0) throw new Error('Link has no channel in it');
  return set;
}

/** `psk` must be 32 cryptographically random bytes (expo-crypto getRandomBytes in the app). */
export function newFestivalChannel(psk: Uint8Array, name = 'festival'): Channel.ChannelSettings {
  if (psk.length !== 32) throw new Error('PSK must be 32 bytes');
  return create(Channel.ChannelSettingsSchema, {
    name,
    psk,
    // 32 bits = full GPS precision; the default public channel blurs positions to ~1 km.
    moduleSettings: { positionPrecision: 32 },
  });
}

export const ModemPreset = Config.Config_LoRaConfig_ModemPreset;
export const RegionCode = Config.Config_LoRaConfig_RegionCode;
export { Admin, Channel, Config, Mesh };
