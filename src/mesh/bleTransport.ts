import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';
import type { BleManager, Device, Subscription } from 'react-native-ble-plx';
import { fromBase64, toBase64 } from './base64';
import { BaseTransport } from './transport';

// Meshtastic BLE API (https://meshtastic.org/docs/development/device/client-api/)
export const MESH_SERVICE = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
const TO_RADIO = 'f75c76d2-129e-4dad-a1dd-7866124401e7';
const FROM_RADIO = '2c55e69e-4993-11ed-b878-0242ac120002';
const FROM_NUM = 'ed9da18c-a800-4f66-a670-aa7547e34453';

/** Bluetooth needs a development build; Expo Go doesn't contain the native module. */
export const bleAvailable =
  Platform.OS !== 'web' && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

let manager: BleManager | null = null;
function getManager(): BleManager {
  if (!bleAvailable) throw new Error('Bluetooth needs a development build (not Expo Go)');
  if (!manager) {
    // Required lazily so Expo Go never loads the missing native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BleManager: Manager } = require('react-native-ble-plx') as typeof import('react-native-ble-plx');
    manager = new Manager();
  }
  return manager;
}

export type FoundRadio = { id: string; name: string; rssi: number | null };

/** Scans for Meshtastic radios. Returns a stop function. */
export function scanForRadios(onFound: (r: FoundRadio) => void, onError: (e: Error) => void): () => void {
  const m = getManager();
  m.startDeviceScan([MESH_SERVICE], null, (err, device) => {
    if (err) return onError(err);
    if (device) onFound({ id: device.id, name: device.name ?? device.localName ?? 'Meshtastic', rssi: device.rssi });
  });
  return () => m.stopDeviceScan();
}

export class BleTransport extends BaseTransport {
  readonly kind = 'ble' as const;
  private device: Device | null = null;
  private subs: Subscription[] = [];
  private draining = false;
  private drainAgain = false;
  private closing = false;

  constructor(private deviceId: string) {
    super();
  }

  async connect() {
    this.closing = false;
    this.setStatus('connecting', this.deviceId);
    const m = getManager();
    const device = await m.connectToDevice(this.deviceId, { requestMTU: 512, timeout: 15000 });
    await device.discoverAllServicesAndCharacteristics();
    this.device = device;
    this.subs.push(
      device.onDisconnected(() => {
        this.device = null;
        this.setStatus(this.closing ? 'disconnected' : 'error', 'Radio disconnected');
      }),
      device.monitorCharacteristicForService(MESH_SERVICE, FROM_NUM, (err) => {
        if (!err) void this.drain();
      }),
    );
    this.setStatus('connected', device.name ?? this.deviceId);
  }

  async disconnect() {
    this.closing = true;
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    if (this.device) await this.device.cancelConnection().catch(() => {});
    this.device = null;
    this.setStatus('disconnected');
  }

  async write(bytes: Uint8Array) {
    if (!this.device) throw new Error('Radio not connected');
    await this.device.writeCharacteristicWithResponseForService(MESH_SERVICE, TO_RADIO, toBase64(bytes));
    // The radio often answers immediately (e.g. the config download); don't wait for a FromNum notify.
    void this.drain();
  }

  /** Reads FromRadio until the radio returns an empty packet. */
  private async drain() {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        while (this.device) {
          const c = await this.device.readCharacteristicForService(MESH_SERVICE, FROM_RADIO);
          const bytes = c.value ? fromBase64(c.value) : new Uint8Array();
          if (bytes.length === 0) break;
          this.emit(bytes);
        }
      } while (this.drainAgain && this.device);
    } catch (e) {
      if (!this.closing) this.setStatus('error', (e as Error).message);
    } finally {
      this.draining = false;
    }
  }
}
