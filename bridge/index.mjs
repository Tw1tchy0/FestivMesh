#!/usr/bin/env node
// USB T-Beam <-> WebSocket bridge, so the app in Expo Go can use a real radio over WiFi.
//
//   npm run bridge                      auto-detect the radio, serve ws://<this-pc>:8787
//   npm run bridge -- --port COM6       pick the serial port
//   npm run probe                       print what the radio reports, then exit
//   add --verbose to also print the radio's debug log

import os from 'node:os';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { Channel, Config, Mesh, Portnums } from '@meshtastic/protobufs';
import { SerialPort } from 'serialport';
import { WebSocketServer } from 'ws';
import { Deframer, frame, START2 } from './framing.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

// USB-serial chips used on T-Beams and other Meshtastic boards (CH9102/CH340, CP210x, ESP32-S3 native)
const KNOWN_VIDS = ['1a86', '10c4', '303a', '0403', '239a'];

async function findPort() {
  const explicit = arg('port');
  if (explicit) return explicit;
  const ports = await SerialPort.list();
  const hit = ports.find((p) => KNOWN_VIDS.includes((p.vendorId ?? '').toLowerCase()));
  if (!hit) {
    console.error('No Meshtastic radio found. Ports:', ports.map((p) => `${p.path} (${p.manufacturer ?? '?'})`).join(', ') || 'none');
    process.exit(1);
  }
  return hit.path;
}

function openSerial(path) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate: 115200 }, (err) => (err ? reject(err) : resolve(port)));
  });
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

function describe(fr) {
  const v = fr.payloadVariant;
  switch (v.case) {
    case 'myInfo':
      return `myInfo: node !${v.value.myNodeNum.toString(16)} (${v.value.pioEnv || 'unknown board'})`;
    case 'metadata':
      return `metadata: firmware ${v.value.firmwareVersion}, bluetooth=${v.value.hasBluetooth}, wifi=${v.value.hasWifi}`;
    case 'nodeInfo': {
      const n = v.value;
      const pos = n.position?.latitudeI ? ` @ ${(n.position.latitudeI * 1e-7).toFixed(5)},${(n.position.longitudeI * 1e-7).toFixed(5)}` : '';
      const heard = n.lastHeard ? ` heard ${Math.round((Date.now() / 1000 - n.lastHeard) / 60)}m ago` : '';
      return `node !${n.num.toString(16)} "${n.user?.longName ?? '?'}"${pos}${heard}`;
    }
    case 'config': {
      const c = v.value.payloadVariant;
      if (c.case === 'lora')
        return `lora: region=${Config.Config_LoRaConfig_RegionCode[c.value.region]} preset=${Config.Config_LoRaConfig_ModemPreset[c.value.modemPreset]}`;
      if (c.case === 'position')
        return `position: broadcast=${c.value.positionBroadcastSecs}s smart=${c.value.positionBroadcastSmartEnabled} gps=${Config.Config_PositionConfig_GpsMode[c.value.gpsMode]}`;
      return null;
    }
    case 'channel':
      if (v.value.role === Channel.Channel_Role.DISABLED) return null;
      return `channel ${v.value.index}: "${v.value.settings?.name || '(default)'}" precision=${v.value.settings?.moduleSettings?.positionPrecision ?? 0} role=${Channel.Channel_Role[v.value.role]}`;
    case 'configCompleteId':
      return 'config complete';
    case 'packet': {
      const p = v.value;
      const port = p.payloadVariant.case === 'decoded' ? Portnums.PortNum[p.payloadVariant.value.portnum] : 'encrypted';
      return `packet ${port} from !${p.from.toString(16)} to ${p.to === 0xffffffff ? 'all' : '!' + p.to.toString(16)}`;
    }
    default:
      return null;
  }
}

async function main() {
  const path = await findPort();
  const port = await openSerial(path);
  console.log(`Serial open: ${path}`);
  const clients = new Set();
  const verbose = flag('verbose');
  const probe = flag('probe');

  const deframer = new Deframer(
    (payload) => {
      if (verbose || probe) {
        try {
          const d = describe(fromBinary(Mesh.FromRadioSchema, payload));
          if (d) console.log('  <-', d);
          if (probe && d === 'config complete') {
            console.log('Probe OK.');
            process.exit(0);
          }
        } catch {
          /* undecodable frame: still forward it */
        }
      }
      for (const ws of clients) if (ws.readyState === 1) ws.send(payload);
    },
    (line) => verbose && console.log('  [radio]', line),
  );
  port.on('data', (chunk) => deframer.feed(new Uint8Array(chunk)));
  port.on('close', () => {
    console.error('Serial port closed (radio unplugged or rebooted). Exiting.');
    process.exit(2);
  });

  // Wake the radio's serial API (same as the official Python client).
  port.write(Buffer.alloc(32, START2));
  await new Promise((r) => setTimeout(r, 150));

  if (probe) {
    console.log('Requesting config...');
    const req = create(Mesh.ToRadioSchema, { payloadVariant: { case: 'wantConfigId', value: 0x1234 } });
    port.write(Buffer.from(frame(toBinary(Mesh.ToRadioSchema, req))));
    setTimeout(() => {
      console.error('No config complete within 20 s. Is another app holding the port?');
      process.exit(1);
    }, 20000);
    return;
  }

  const wsPort = Number(arg('ws', 8787));
  const wss = new WebSocketServer({ port: wsPort });
  wss.on('connection', (ws, req) => {
    clients.add(ws);
    console.log(`App connected from ${req.socket.remoteAddress} (${clients.size} client${clients.size > 1 ? 's' : ''})`);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const bytes = new Uint8Array(data);
      if (verbose) {
        try {
          const tr = fromBinary(Mesh.ToRadioSchema, bytes);
          console.log('  ->', tr.payloadVariant.case);
        } catch {}
      }
      port.write(Buffer.from(frame(bytes)));
    });
    ws.on('close', () => {
      clients.delete(ws);
      console.log(`App disconnected (${clients.size} left)`);
    });
  });
  console.log(`Bridge ready. In the app: Settings > Connection > PC Bridge, then use one of:`);
  for (const ip of lanAddresses()) console.log(`   ws://${ip}:${wsPort}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
