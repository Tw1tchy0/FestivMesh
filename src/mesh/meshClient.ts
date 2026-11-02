import { clone, create } from '@bufbuild/protobuf';
import {
  Channel,
  Config,
  decodeFromRadio,
  encodeAdmin,
  encodeHeartbeat,
  encodePresence,
  encodeText,
  encodeWantConfig,
  Mesh,
  randomId,
  type AdminInit,
  type MeshEvent,
  type NodeUpdate,
} from './protocol';
import type { Transport, TransportStatus } from './transport';

/** Where the client reports what it hears. The zustand store implements this. */
export interface MeshSink {
  setStatus(status: TransportStatus, detail?: string): void;
  setRadioInfo(info: { myNodeNum?: number; firmware?: string; configReady?: boolean; bumpRadioRev?: boolean }): void;
  /** `befriend`: heard on a private channel, so it may be added as a friend automatically. */
  upsertNode(u: NodeUpdate, opts: { live: boolean; befriend: boolean }): void;
  markPresence(num: number, at: number, battery?: number): void;
  onText(e: Extract<MeshEvent, { kind: 'text' }>): void;
  onAck(requestId: number, state: 'sent' | 'delivered' | 'failed', error?: string): void;
  /** An ACK for a message this client isn't tracking (sent before a reconnect, restart or timeout). */
  onLateAck(from: number, requestId: number): void;
}

// Each beacon is relayed by every radio in range and wakes friends' phones, so keep it sparse.
const PRESENCE_EVERY_MS = 120_000;
const HEARTBEAT_EVERY_MS = 5 * 60_000; // keeps serial (bridge) sessions alive
const ACK_TIMEOUT_MS = 120_000;
/** After a change that reboots the radio, re-sync even if it never says it rebooted. */
const REBOOT_RESYNC_MS = 15_000;

const ROUTING_ERROR_TEXT: Partial<Record<Mesh.Routing_Error, string>> = {
  [Mesh.Routing_Error.MAX_RETRANSMIT]: 'Not delivered: out of range',
  [Mesh.Routing_Error.NO_ROUTE]: 'No route to them',
  [Mesh.Routing_Error.TIMEOUT]: 'Timed out',
  [Mesh.Routing_Error.TOO_LARGE]: 'Message too long',
  [Mesh.Routing_Error.DUTY_CYCLE_LIMIT]: 'Radio airtime limit hit; try again in a minute',
  [Mesh.Routing_Error.PKI_UNKNOWN_PUBKEY]: "Radio doesn't know their key yet",
  [Mesh.Routing_Error.NO_CHANNEL]: 'Not on the same channel',
};

/**
 * Speaks the Meshtastic phone API over any Transport: runs the want_config
 * handshake, tracks radio config, sends DMs/presence/admin, and matches ACKs.
 */
export class MeshClient {
  myNodeNum?: number;
  firmware?: string;
  config: { lora?: Config.Config_LoRaConfig; position?: Config.Config_PositionConfig } = {};
  channels = new Map<number, Channel.Channel>();
  private configId = 0;
  private sessionPasskey?: Uint8Array;
  /** packetId -> who it was sent to, while waiting for a routing ACK */
  private pending = new Map<number, { to: number; timer: ReturnType<typeof setTimeout> }>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private readyWaiters: (() => void)[] = [];
  /** The radio's stored node list, held until its channels are known (they arrive later in the handshake). */
  private nodeDump: Extract<MeshEvent, { kind: 'node' }>[] = [];
  ready = false;
  battery?: number;

  constructor(
    readonly transport: Transport,
    private sink: MeshSink,
  ) {
    transport.onStatus((s, d) => sink.setStatus(s, d));
    transport.onFromRadio((bytes) => this.handle(bytes));
  }

  async start() {
    await this.transport.connect();
    await this.requestConfig();
    this.timers.push(
      setInterval(() => void this.sendPresence().catch(() => {}), PRESENCE_EVERY_MS),
      setInterval(() => void this.transport.write(encodeHeartbeat()).catch(() => {}), HEARTBEAT_EVERY_MS),
    );
  }

  async stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.pending.forEach((p, id) => {
      clearTimeout(p.timer);
      this.sink.onAck(id, 'failed', 'Disconnected before their radio confirmed');
    });
    this.pending.clear();
    await this.transport.disconnect();
  }

  async requestConfig() {
    this.ready = false;
    this.sink.setRadioInfo({ configReady: false });
    this.configId = randomId();
    await this.transport.write(encodeWantConfig(this.configId));
  }

  /**
   * True for a channel with its own random key (e.g. the festival channel). On the public default
   * channel anyone nearby is heard, so those radios only become friends when added by hand.
   */
  isPrivateChannel(index: number): boolean {
    const psk = this.channels.get(index)?.settings?.psk;
    return !!psk && psk.length >= 16;
  }

  whenReady(): Promise<void> {
    return this.ready ? Promise.resolve() : new Promise((r) => this.readyWaiters.push(r));
  }

  handle(bytes: Uint8Array) {
    let events: MeshEvent[];
    try {
      events = decodeFromRadio(bytes);
    } catch {
      return; // not a FromRadio we understand (newer firmware field, partial read)
    }
    for (const e of events) this.apply(e);
  }

  private apply(e: MeshEvent) {
    switch (e.kind) {
      case 'myInfo':
        this.myNodeNum = e.myNodeNum;
        this.sink.setRadioInfo({ myNodeNum: e.myNodeNum });
        break;
      case 'metadata':
        this.firmware = e.firmwareVersion;
        this.sink.setRadioInfo({ firmware: e.firmwareVersion });
        break;
      case 'node':
        if (e.node.num === this.myNodeNum && e.node.battery !== undefined) this.battery = e.node.battery;
        if (!e.live && !this.ready) this.nodeDump.push(e);
        else this.sink.upsertNode(e.node, { live: e.live, befriend: this.isPrivateChannel(e.channel) });
        break;
      case 'config': {
        const v = e.config.payloadVariant;
        if (v.case === 'lora') this.config.lora = v.value;
        if (v.case === 'position') this.config.position = v.value;
        break;
      }
      case 'channel':
        this.channels.set(e.channel.index, e.channel);
        break;
      case 'configComplete':
        if (e.id !== this.configId) break;
        for (const n of this.nodeDump.splice(0)) this.sink.upsertNode(n.node, { live: false, befriend: this.isPrivateChannel(n.channel) });
        this.ready = true;
        this.sink.setRadioInfo({ configReady: true, bumpRadioRev: true });
        this.readyWaiters.splice(0).forEach((r) => r());
        void this.sendPresence().catch(() => {});
        break;
      case 'rebooted':
        void this.requestConfig().catch(() => {});
        break;
      case 'text':
        if (e.from !== this.myNodeNum) this.sink.onText(e);
        break;
      case 'presence':
        if (e.from !== this.myNodeNum) this.sink.markPresence(e.from, e.rxTime, e.battery);
        break;
      case 'ack':
        this.onAck(e.from, e.requestId, e.error);
        break;
      case 'admin':
        if (e.admin.sessionPasskey.length) this.sessionPasskey = e.admin.sessionPasskey;
        break;
    }
  }

  private onAck(from: number, requestId: number, error: Mesh.Routing_Error) {
    const p = this.pending.get(requestId);
    if (!p) {
      // The store checks it came from the message's recipient, so our own radio's implicit ACKs don't count.
      if (error === Mesh.Routing_Error.NONE) this.sink.onLateAck(from, requestId);
      return;
    }
    if (error !== Mesh.Routing_Error.NONE) {
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      this.sink.onAck(requestId, 'failed', ROUTING_ERROR_TEXT[error] ?? `Failed (${Mesh.Routing_Error[error]})`);
    } else if (from === p.to) {
      // ACK from the destination radio itself.
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      this.sink.onAck(requestId, 'delivered');
    } else {
      // ACK from our own radio = a neighbour rebroadcast it ("implicit ack"); keep waiting for the real one.
      this.sink.onAck(requestId, 'sent');
    }
  }

  /** Sends a DM. Returns the packet id so the UI can follow its ACK. */
  async sendText(to: number, text: string): Promise<number> {
    const id = randomId();
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) this.sink.onAck(id, 'failed', 'No confirmation from their radio');
    }, ACK_TIMEOUT_MS);
    this.pending.set(id, { to, timer });
    try {
      await this.transport.write(encodeText(to, text, id));
    } catch (err) {
      clearTimeout(timer);
      this.pending.delete(id);
      throw err;
    }
    return id;
  }

  async sendPresence() {
    if (!this.ready) return;
    await this.transport.write(encodePresence(randomId(), this.battery));
  }

  private async admin(admin: AdminInit) {
    if (this.myNodeNum === undefined) throw new Error('Radio not ready');
    await this.transport.write(encodeAdmin(this.myNodeNum, randomId(), admin, this.sessionPasskey));
  }

  /** The radio restarts to apply this. */
  async setOwner(longName: string, shortName: string) {
    await this.admin({ payloadVariant: { case: 'setOwner', value: { longName, shortName } } });
    this.expectReboot();
  }

  /** Shows "Syncing…" while the radio restarts, then downloads its config again. */
  private expectReboot() {
    this.ready = false;
    this.sink.setRadioInfo({ configReady: false });
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      if (!this.ready) void this.requestConfig().catch(() => {});
    }, REBOOT_RESYNC_MS);
  }

  /**
   * Puts the radio on a private festival channel with full position precision, frequent
   * smart position broadcasts, and the chosen modem preset. The radio reboots afterwards.
   */
  async applyFestivalSetup(opts: {
    channel: Channel.ChannelSettings;
    preset: Config.Config_LoRaConfig_ModemPreset;
    region?: Config.Config_LoRaConfig_RegionCode;
  }) {
    await this.whenReady();
    const lora = this.config.lora
      ? clone(Config.Config_LoRaConfigSchema, this.config.lora)
      : create(Config.Config_LoRaConfigSchema);
    lora.usePreset = true;
    lora.modemPreset = opts.preset;
    if (opts.region !== undefined) lora.region = opts.region;
    if (lora.region === Config.Config_LoRaConfig_RegionCode.UNSET) throw new Error('Pick your region first');
    if (!lora.hopLimit) lora.hopLimit = 3;
    lora.txEnabled = true;

    const position = this.config.position
      ? clone(Config.Config_PositionConfigSchema, this.config.position)
      : create(Config.Config_PositionConfigSchema);
    position.gpsMode = Config.Config_PositionConfig_GpsMode.ENABLED;
    position.gpsUpdateInterval = 10;
    // Standing still: one update every 2 min. Moving: smart broadcast sends after 10 m, at most every 15 s.
    position.positionBroadcastSecs = 120;
    position.positionBroadcastSmartEnabled = true;
    position.broadcastSmartMinimumDistance = 10;
    position.broadcastSmartMinimumIntervalSecs = 15;

    const settings = clone(Channel.ChannelSettingsSchema, opts.channel);
    settings.moduleSettings = create(Channel.ModuleSettingsSchema, { positionPrecision: 32 });
    const channel = create(Channel.ChannelSchema, { index: 0, role: Channel.Channel_Role.PRIMARY, settings });

    await this.admin({ payloadVariant: { case: 'beginEditSettings', value: true } });
    await this.admin({ payloadVariant: { case: 'setChannel', value: channel } });
    const setConfig = (value: Config.Config) => this.admin({ payloadVariant: { case: 'setConfig', value } });
    await setConfig(create(Config.ConfigSchema, { payloadVariant: { case: 'position', value: position } }));
    await setConfig(create(Config.ConfigSchema, { payloadVariant: { case: 'lora', value: lora } }));
    await this.admin({ payloadVariant: { case: 'commitEditSettings', value: true } });
    this.channels.set(0, channel);
    this.config.lora = lora;
    this.config.position = position;
    this.sink.setRadioInfo({ bumpRadioRev: true });
    this.expectReboot();
  }
}

