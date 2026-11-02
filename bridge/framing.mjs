// Meshtastic serial framing: 0x94 0xC3 <len hi> <len lo> <protobuf bytes>.
// Anything outside a frame is the radio's debug log text.

export const START1 = 0x94;
export const START2 = 0xc3;
export const MAX_FRAME = 512;

export function frame(payload) {
  if (payload.length > MAX_FRAME) throw new Error(`Frame too large: ${payload.length}`);
  const out = new Uint8Array(4 + payload.length);
  out[0] = START1;
  out[1] = START2;
  out[2] = (payload.length >> 8) & 0xff;
  out[3] = payload.length & 0xff;
  out.set(payload, 4);
  return out;
}

/** Incremental parser: feed() raw serial chunks, get frames and log text back via callbacks. */
export class Deframer {
  constructor(onFrame, onLog = () => {}) {
    this.onFrame = onFrame;
    this.onLog = onLog;
    this.buf = new Uint8Array(0);
    this.logLine = '';
  }

  feed(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    let i = 0;
    while (i < merged.length) {
      if (merged[i] !== START1) {
        this.log(merged[i++]);
        continue;
      }
      if (i + 1 >= merged.length) break; // need more bytes
      if (merged[i + 1] !== START2) {
        this.log(merged[i++]);
        continue;
      }
      if (i + 3 >= merged.length) break;
      const len = (merged[i + 2] << 8) | merged[i + 3];
      if (len > MAX_FRAME) {
        i += 1; // corrupt header: resync on the next byte
        continue;
      }
      if (i + 4 + len > merged.length) break;
      this.onFrame(merged.slice(i + 4, i + 4 + len));
      i += 4 + len;
    }
    this.buf = merged.slice(i);
  }

  log(byte) {
    if (byte === 0x0a) {
      if (this.logLine.trim()) this.onLog(this.logLine.replace(/\r$/, ''));
      this.logLine = '';
    } else if (byte >= 0x20 || byte === 0x09 || byte === 0x0d) {
      this.logLine += String.fromCharCode(byte);
    }
  }
}
