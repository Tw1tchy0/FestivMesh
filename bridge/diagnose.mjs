#!/usr/bin/env node
// Health check for a USB-connected Meshtastic radio: power chip, battery, GPS, radio settings.
//
//   npm run diagnose                    auto-detect the radio
//   npm run diagnose -- --port COM7     pick the serial port
//   npm run diagnose -- --wait 30       listen to the boot log longer (default 15 s)
//   npm run diagnose -- --reset         restart the board over USB first, to capture its full boot log
//   npm run diagnose -- --log out.txt   also save every log line to a file
//
// Opening the port usually resets an ESP32 board, so its boot log (where power-chip and
// GPS detection is printed) is captured before the config is requested.

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { Channel, Config, Mesh } from '@meshtastic/protobufs';
import { SerialPort } from 'serialport';
import { Deframer, frame, START2 } from './framing.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const KNOWN_VIDS = ['1a86', '10c4', '303a', '0403', '239a'];
const INTERESTING = /pmu|axp|batt|power|charg|volt|gps|gnss|nmea|ubx|ublox|l76k|atgm|neo-?[68m]|sat|i2c|wire|probe|detect/i;

const hex = (n) => '!' + (n >>> 0).toString(16).padStart(8, '0');
const ok = (s) => console.log(`  \x1b[32m✔\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✘\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const info = (k, v) => console.log(`  ${k.padEnd(18)} ${v}`);

async function pickPort() {
  const explicit = arg('port');
  if (explicit) return explicit;
  const ports = (await SerialPort.list()).filter((p) => KNOWN_VIDS.includes((p.vendorId ?? '').toLowerCase()));
  if (ports.length === 0) {
    console.error('No Meshtastic radio found over USB. Plug it in with a data (not charge-only) USB cable.');
    process.exit(1);
  }
  if (ports.length > 1) {
    console.error(`Several radios found: ${ports.map((p) => p.path).join(', ')}. Pick one with --port.`);
    process.exit(1);
  }
  return ports[0].path;
}

async function main() {
  const path = await pickPort();
  const waitS = Number(arg('wait', 15));
  const port = await new Promise((resolve, reject) => {
    const p = new SerialPort({ path, baudRate: 115200 }, (err) => (err ? reject(err) : resolve(p)));
  }).catch((e) => {
    console.error(`Can't open ${path}: ${e.message}`);
    if (/denied|busy/i.test(e.message)) console.error('Something else is using it: stop `npm run bridge` or close the Meshtastic web/desktop app.');
    process.exit(1);
  });

  const bootLog = [];
  const state = { nodes: new Map(), channels: [], config: {}, done: false };
  const deframer = new Deframer(
    (payload) => {
      let fr;
      try {
        fr = fromBinary(Mesh.FromRadioSchema, payload);
      } catch {
        return;
      }
      const v = fr.payloadVariant;
      if (v.case === 'myInfo') state.myInfo = v.value;
      else if (v.case === 'metadata') state.metadata = v.value;
      else if (v.case === 'nodeInfo') state.nodes.set(v.value.num, v.value);
      else if (v.case === 'channel') state.channels.push(v.value);
      else if (v.case === 'config') state.config[v.value.payloadVariant.case] = v.value.payloadVariant.value;
      else if (v.case === 'logRecord') bootLog.push(v.value.message);
      else if (v.case === 'configCompleteId') state.done = true;
    },
    (line) => bootLog.push(line.replace(/\x1b\[[0-9;]*m/g, '')),
  );
  port.on('data', (chunk) => deframer.feed(new Uint8Array(chunk)));

  if (args.includes('--reset')) {
    // ESP32 auto-reset circuit: RTS pulls EN low; releasing it reboots the chip (DTR stays off so it boots normally).
    await new Promise((r) => port.set({ dtr: false, rts: true }, r));
    await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => port.set({ dtr: false, rts: false }, r));
  }

  console.log(`\n${args.includes('--reset') ? 'Restarted' : 'Opened'} ${path}. Listening to its log for ${waitS} s…\n`);
  await new Promise((r) => setTimeout(r, waitS * 1000));

  port.write(Buffer.alloc(32, START2));
  await new Promise((r) => setTimeout(r, 150));
  const req = create(Mesh.ToRadioSchema, { payloadVariant: { case: 'wantConfigId', value: 0x4d1a6 } });
  port.write(Buffer.from(frame(toBinary(Mesh.ToRadioSchema, req))));
  const t0 = Date.now();
  while (!state.done && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200));
  port.close();

  const logFile = arg('log');
  if (logFile) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(logFile, bootLog.join('\n'));
  }
  report(state, bootLog);
}

function report(state, bootLog) {
  const { myInfo, metadata, config } = state;
  if (!state.done || !myInfo) {
    console.log('The radio never answered the config request.');
    console.log('Check: data-capable USB cable, the board is booted (screen on), no other app holds the port.');
    if (bootLog.length) console.log(`\nLast log lines:\n  ${bootLog.slice(-15).join('\n  ')}`);
    process.exit(1);
  }
  const me = state.nodes.get(myInfo.myNodeNum);
  const metrics = me?.deviceMetrics;
  const pos = me?.position;
  const gpsMode = config.position?.gpsMode;
  const relevant = bootLog.filter((l) => INTERESTING.test(l));
  const pmuMissing = relevant.some((l) => /no pmu|pmu not|axp.*(fail|not found)|failed.*pmu/i.test(l));
  // e.g. "[Power] Battery: usbPower=1, isCharging=1, batMv=4126, batPct=0"
  const powerLine = [...bootLog].reverse().find((l) => /batMv=\d+/.test(l));
  const batMv = powerLine ? Number(/batMv=(\d+)/.exec(powerLine)[1]) : undefined;
  const batPct = powerLine ? Number(/batPct=(-?\d+)/.exec(powerLine)?.[1]) : undefined;
  // "No GPS lock" just means no fix yet; only a missing module counts here.
  const gpsMissing = relevant.some((l) => /(no gps (module|found|detected)|unable to find gps|gps.*not (found|detected)|no gnss module)/i.test(l));
  const gpsModel = relevant.map((l) => /\] (.+?) detected/.exec(l)?.[1]).find(Boolean);
  const satLine = [...bootLog].reverse().find((l) => /Sats=\d+/.test(l));

  console.log('\n=== Radio ===');
  info('Node', `${hex(myInfo.myNodeNum)} "${me?.user?.longName ?? '?'}"`);
  info('Firmware', metadata?.firmwareVersion ?? '?');
  info('Board model', metadata ? Mesh.HardwareModel[metadata.hwModel] ?? metadata.hwModel : '?');
  info('Firmware build', myInfo.pioEnv || '?');

  console.log('\n=== Power ===');
  info('Battery level', metrics?.batteryLevel === undefined ? 'not in node info' : metrics.batteryLevel > 100 ? 'external power' : `${metrics.batteryLevel}%`);
  if (powerLine) info('Power chip says', powerLine.replace(/^.*Battery:\s*/, ''));
  const chipReadsVoltage = batMv !== undefined && batMv > 2500;
  const noBatteryReading = !chipReadsVoltage && !metrics?.voltage;
  const pctStuck = chipReadsVoltage && batPct === 0 && batMv > 3500;
  if (pctStuck) bad(`Power chip works (battery ${(batMv / 1000).toFixed(2)} V) but reports 0% charge. Only the percentage is wrong.`);
  else if (chipReadsVoltage) ok(`Power chip reads the battery: ${(batMv / 1000).toFixed(2)} V, ${batPct}%.`);
  else if (pmuMissing) bad('Firmware says the power chip (AXP192/AXP2101) was not found.');
  else warn('No battery reading captured. Run again with --reset --wait 30.');

  console.log('\n=== GPS ===');
  info('GPS mode', gpsMode === undefined ? '?' : Config.Config_PositionConfig_GpsMode[gpsMode]);
  if (gpsModel) info('GPS module', gpsModel);
  if (satLine) info('Satellites', /Sats=(\d+)/.exec(satLine)[1]);
  info('Last position', pos?.latitudeI ? `${(pos.latitudeI * 1e-7).toFixed(5)}, ${(pos.longitudeI * 1e-7).toFixed(5)}` : 'none');
  if (gpsMode !== undefined && gpsMode !== Config.Config_PositionConfig_GpsMode.ENABLED)
    bad(`GPS is set to ${Config.Config_PositionConfig_GpsMode[gpsMode]}. Turn it on: Settings › Position › GPS mode = Enabled.`);
  else if (!pos?.latitudeI) warn('No GPS fix yet. Needs open sky; first fix can take 2–15 min.');
  else ok('Has a GPS position.');

  console.log('\n=== Mesh ===');
  const primary = state.channels.find((c) => c.role === Channel.Channel_Role.PRIMARY);
  const lora = config.lora;
  info('Primary channel', primary?.settings?.name || '(public default)');
  info('Preset / region', lora ? `${Config.Config_LoRaConfig_ModemPreset[lora.modemPreset]} / ${Config.Config_LoRaConfig_RegionCode[lora.region]}` : '?');
  const others = [...state.nodes.values()].filter((n) => n.num !== myInfo.myNodeNum);
  info('Other nodes known', String(others.length));
  for (const n of others.slice(0, 8)) {
    const ago = n.lastHeard ? `${Math.round((Date.now() / 1000 - n.lastHeard) / 60)} min ago` : 'never (no clock?)';
    console.log(`    ${hex(n.num)} ${n.user?.longName ?? '?'} — heard ${ago}`);
  }
  if (lora?.region === Config.Config_LoRaConfig_RegionCode.UNSET) bad('LoRa region is UNSET: the radio will not transmit. Set it (e.g. US).');

  console.log('\n=== Log (power / GPS lines) ===');
  if (relevant.length) for (const l of relevant.slice(-40)) console.log(`  ${l}`);
  else console.log('  (none captured: run with --reset)');

  console.log('\n=== Diagnosis ===');
  if (noBatteryReading && pmuMissing) {
    bad('Power chip not detected. On T-Beams that also leaves the GPS unpowered.');
    console.log('    Flash current firmware for your exact board at https://flasher.meshtastic.org; if it persists, the chip is likely damaged.');
  }
  if (pctStuck) warn('The 0% is a battery-gauge/software problem, not a dead battery or power chip.');
  if (gpsMissing) bad('Firmware reports no GPS module found.');
  if (!noBatteryReading && !pctStuck && pos?.latitudeI) ok('Power and GPS look healthy.');
  if (others.length === 0) warn('No other nodes known yet. Without a GPS clock some screens show 0 online even when packets arrive.');
  console.log('');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
