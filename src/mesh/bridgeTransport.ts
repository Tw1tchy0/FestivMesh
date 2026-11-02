import { BaseTransport } from './transport';

/**
 * Talks to bridge/index.mjs on a PC over WebSocket. The bridge owns the USB serial
 * framing, so each WebSocket message is exactly one ToRadio / FromRadio protobuf.
 * Works in Expo Go: lets the phone use a real T-Beam without Bluetooth.
 */
export class BridgeTransport extends BaseTransport {
  readonly kind = 'bridge' as const;
  private ws: WebSocket | null = null;

  constructor(private url: string) {
    super();
  }

  connect(): Promise<void> {
    this.setStatus('connecting', this.url);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      let opened = false;
      const timer = setTimeout(() => {
        if (!opened) {
          ws.close();
          reject(new Error(`No answer from bridge at ${this.url}`));
        }
      }, 6000);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        this.ws = ws;
        this.setStatus('connected', this.url);
        resolve();
      };
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) this.emit(new Uint8Array(e.data));
      };
      ws.onerror = () => {
        if (!opened) {
          clearTimeout(timer);
          reject(new Error(`Could not reach bridge at ${this.url}`));
        }
      };
      ws.onclose = () => {
        this.ws = null;
        if (opened) this.setStatus('error', 'Bridge connection lost');
      };
    });
  }

  async disconnect() {
    if (this.ws) {
      // Its close event arrives later, possibly after a new connection has reported its own status.
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.close();
    }
    this.ws = null;
    this.setStatus('disconnected');
  }

  async write(bytes: Uint8Array) {
    if (!this.ws) throw new Error('Bridge not connected');
    this.ws.send(bytes.slice().buffer);
  }
}
