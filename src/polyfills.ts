// @bufbuild/protobuf needs TextEncoder/TextDecoder for string fields.
// Hermes ships TextEncoder but older builds lack TextDecoder; fill in only what is missing.

function utf8Encode(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let c: number;
    if (b < 0x80) c = b;
    else if (b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
    else if (b < 0xf0) c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    out += String.fromCodePoint(c);
  }
  return out;
}

const g = globalThis as Record<string, unknown>;
if (typeof g.TextEncoder === 'undefined') {
  g.TextEncoder = class {
    encoding = 'utf-8';
    encode(s = '') {
      return utf8Encode(s);
    }
  };
}
if (typeof g.TextDecoder === 'undefined') {
  g.TextDecoder = class {
    encoding = 'utf-8';
    decode(b?: ArrayBufferView | ArrayBuffer) {
      if (!b) return '';
      const u8 = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      return utf8Decode(u8);
    }
  };
}

export { utf8Encode, utf8Decode };
