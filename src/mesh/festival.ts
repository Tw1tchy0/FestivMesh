import { getRandomBytes } from 'expo-crypto';
import { getClient } from './connection';
import { Config, decodeChannelUrl, encodeChannelUrl, newFestivalChannel } from './protocol';

export const PRESETS = [
  { value: Config.Config_LoRaConfig_ModemPreset.MEDIUM_FAST, label: 'Medium Fast', hint: 'Recommended: good range, less crowded airtime' },
  { value: Config.Config_LoRaConfig_ModemPreset.LONG_FAST, label: 'Long Fast', hint: 'Meshtastic default: most range, slowest' },
  { value: Config.Config_LoRaConfig_ModemPreset.SHORT_FAST, label: 'Short Fast', hint: 'Dense crowds, friends nearby' },
];

export const REGIONS = ['US', 'EU_868', 'EU_433', 'ANZ', 'NZ_865', 'IN', 'JP', 'KR', 'TW', 'BR_902', 'TH', 'SG_923'] as const;

function requireClient() {
  const c = getClient();
  if (!c?.ready) throw new Error('Connect to your radio first');
  return c;
}

/** The radio's primary channel, if it's a private one (a real key, not the public default). */
export function currentFestivalChannel() {
  const ch = getClient()?.channels.get(0)?.settings;
  return ch && ch.psk.length >= 16 ? ch : undefined;
}

export function currentShareUrl(): string | undefined {
  const ch = currentFestivalChannel();
  return ch ? encodeChannelUrl(ch, getClient()?.config.lora) : undefined;
}

export async function createFestival(preset: Config.Config_LoRaConfig_ModemPreset, region?: Config.Config_LoRaConfig_RegionCode) {
  const c = requireClient();
  await c.applyFestivalSetup({ channel: newFestivalChannel(getRandomBytes(32)), preset, region });
}

/** Parses a share link without touching the radio, so the UI can confirm first. */
export function readShareUrl(url: string) {
  const set = decodeChannelUrl(url.trim());
  const ch = set.settings[0];
  if (ch.psk.length < 16) throw new Error("That's a public channel link, not a private festival channel");
  return { channel: ch, lora: set.loraConfig };
}

export async function joinFestival(url: string) {
  const c = requireClient();
  const { channel, lora } = readShareUrl(url);
  await c.applyFestivalSetup({
    channel,
    preset: lora?.usePreset ? lora.modemPreset : Config.Config_LoRaConfig_ModemPreset.MEDIUM_FAST,
    region: lora?.region || undefined,
  });
}

export async function saveOwner(longName: string, shortName: string) {
  await requireClient().setOwner(longName, shortName);
}
