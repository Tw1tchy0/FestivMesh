export type TransportKind = 'sim' | 'bridge' | 'ble';
export type TransportStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Moves whole protobuf messages between the app and a Meshtastic radio.
 * write() takes encoded ToRadio bytes; onFromRadio delivers encoded FromRadio bytes.
 */
export interface Transport {
  readonly kind: TransportKind;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  write(toRadio: Uint8Array): Promise<void>;
  onFromRadio(cb: (fromRadio: Uint8Array) => void): void;
  onStatus(cb: (status: TransportStatus, detail?: string) => void): void;
}

/** Shared listener plumbing for transports. */
export abstract class BaseTransport implements Transport {
  abstract readonly kind: TransportKind;
  private fromRadioCbs: ((b: Uint8Array) => void)[] = [];
  private statusCbs: ((s: TransportStatus, d?: string) => void)[] = [];

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract write(toRadio: Uint8Array): Promise<void>;

  onFromRadio(cb: (b: Uint8Array) => void) {
    this.fromRadioCbs.push(cb);
  }
  onStatus(cb: (s: TransportStatus, d?: string) => void) {
    this.statusCbs.push(cb);
  }
  protected emit(bytes: Uint8Array) {
    for (const cb of this.fromRadioCbs) cb(bytes);
  }
  protected setStatus(s: TransportStatus, detail?: string) {
    for (const cb of this.statusCbs) cb(s, detail);
  }
}
