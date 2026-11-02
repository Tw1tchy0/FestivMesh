import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, Chip, Row, SectionTitle } from '../../components/ui';
import { bleAvailable, scanForRadios, type FoundRadio } from '../../mesh/bleTransport';
import { connect, disconnect, getClient } from '../../mesh/connection';
import { createFestival, currentFestivalChannel, PRESETS, REGIONS, saveOwner } from '../../mesh/festival';
import { Config } from '../../mesh/protocol';
import type { TransportKind } from '../../mesh/transport';
import { timeAgo } from '../../geo';
import { useNow } from '../../hooks/useSensors';
import { friendName, selectNearbyRadios, useMesh } from '../../store/useMesh';
import { COLORS, FRIEND_COLORS, SPACING } from '../../theme';

const TRANSPORTS: { kind: TransportKind; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { kind: 'sim', label: 'Simulator', icon: 'flask-outline' },
  { kind: 'bridge', label: 'PC Bridge', icon: 'desktop-outline' },
  { kind: 'ble', label: 'Bluetooth', icon: 'bluetooth' },
];

const MY_COLORS = ['#c9b6ff', '#ffffff', ...FRIEND_COLORS];

function ConnectionSection() {
  const settings = useMesh((s) => s.settings);
  const update = useMesh((s) => s.updateSettings);
  const status = useMesh((s) => s.status);
  const detail = useMesh((s) => s.statusDetail);
  const ready = useMesh((s) => s.configReady);
  useMesh((s) => s.radioRev); // re-render when the radio's channel/config changes
  const firmware = useMesh((s) => s.firmware);
  const myNum = useMesh((s) => s.myNodeNum);
  const myNode = useMesh((s) => (s.myNodeNum ? s.nodes[s.myNodeNum] : undefined));
  const [url, setUrl] = useState(settings.bridgeUrl);
  const [found, setFound] = useState<FoundRadio[]>([]);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!scanning) return;
    const stop = scanForRadios(
      (r) => setFound((prev) => (prev.some((p) => p.id === r.id) ? prev : [...prev, r])),
      (e) => {
        setScanning(false);
        Alert.alert('Bluetooth scan failed', e.message);
      },
    );
    const t = setTimeout(() => setScanning(false), 12000);
    return () => {
      clearTimeout(t);
      stop();
    };
  }, [scanning]);

  const choose = (kind: TransportKind) => {
    if (kind === settings.transport) return;
    update({ transport: kind });
    if (kind !== 'ble' || settings.bleDeviceId) void connect().catch(() => {});
    else void disconnect();
  };

  const lora = getClient()?.config.lora;
  const channel = getClient()?.channels.get(0)?.settings;
  const connected = status === 'connected';

  return (
    <>
      <SectionTitle>Radio connection</SectionTitle>
      <Card>
        <View style={styles.chips}>
          {TRANSPORTS.map((t) => (
            <Chip
              key={t.kind}
              label={t.label}
              icon={t.icon}
              selected={settings.transport === t.kind}
              disabled={t.kind === 'ble' && !bleAvailable}
              onPress={() => choose(t.kind)}
            />
          ))}
        </View>

        {settings.transport === 'sim' && (
          <Text style={styles.help}>Fake friends walking around you, so you can try everything without radios.</Text>
        )}
        {!bleAvailable && (
          <Text style={styles.help}>
            Bluetooth needs the app’s own development build. In Expo Go, use the PC Bridge to reach a real T-Beam.
          </Text>
        )}

        {settings.transport === 'bridge' && (
          <>
            <Text style={styles.help}>
              Plug a T-Beam into your PC, run `npm run bridge`, and enter the address it prints. Phone and PC must be on the
              same WiFi.
            </Text>
            <TextInput
              style={styles.input}
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="ws://192.168.1.10:8787"
              placeholderTextColor={COLORS.textFaint}
            />
            <Button
              label="Connect to bridge"
              icon="link-outline"
              onPress={() => {
                update({ bridgeUrl: url.trim() });
                void connect().catch((e) => Alert.alert("Couldn't connect", (e as Error).message));
              }}
            />
          </>
        )}

        {settings.transport === 'ble' && bleAvailable && (
          <>
            {settings.bleDeviceName && <Row label="Paired radio" value={settings.bleDeviceName} />}
            <Button label={scanning ? 'Scanning…' : 'Find radios'} icon="search" kind="secondary" onPress={() => {
                setFound([]);
                setScanning(true);
              }} disabled={scanning} />
            {found.map((r) => (
              <Pressable
                key={r.id}
                style={styles.found}
                onPress={() => {
                  setScanning(false);
                  update({ bleDeviceId: r.id, bleDeviceName: r.name });
                  void connect().catch((e) => Alert.alert("Couldn't connect", (e as Error).message));
                }}
              >
                <Ionicons name="radio-outline" size={18} color={COLORS.text} />
                <Text style={styles.foundName}>{r.name}</Text>
                {r.rssi != null && <Text style={styles.help}>{r.rssi} dBm</Text>}
              </Pressable>
            ))}
          </>
        )}

        <View style={styles.divider} />
        <Row label="Status" value={connected ? (ready ? 'Connected' : 'Syncing…') : status === 'error' ? detail ?? 'Error' : status} />
        {connected && ready && (
          <>
            <Row label="Radio" value={myNode ? friendName(myNode) : myNum ? `!${myNum.toString(16)}` : '—'} />
            {firmware && <Row label="Firmware" value={firmware} />}
            {myNode?.battery !== undefined && <Row label="Battery" value={myNode.battery > 100 ? 'Plugged in' : `${myNode.battery}%`} />}
            <Row label="Channel" value={channel?.name || 'Public default'} />
            {lora && (
              <Row
                label="Radio preset"
                value={`${Config.Config_LoRaConfig_ModemPreset[lora.modemPreset]} · ${Config.Config_LoRaConfig_RegionCode[lora.region]}`}
              />
            )}
          </>
        )}
        {status !== 'disconnected' ? (
          <Button label="Disconnect" kind="secondary" onPress={() => void disconnect()} />
        ) : (
          (settings.transport === 'sim' || (settings.transport === 'ble' && settings.bleDeviceId)) && (
            <Button
              label="Connect"
              icon="power"
              onPress={() => void connect().catch((e) => Alert.alert("Couldn't connect", (e as Error).message))}
            />
          )
        )}
      </Card>
    </>
  );
}

function FestivalSection() {
  const router = useRouter();
  const ready = useMesh((s) => s.configReady);
  useMesh((s) => s.radioRev);
  const lora = getClient()?.config.lora;
  const [preset, setPreset] = useState(Config.Config_LoRaConfig_ModemPreset.MEDIUM_FAST);
  const [pickedRegion, setRegion] = useState<string | null>(null);
  // Default to the radio's own region until the user picks one.
  const region =
    pickedRegion ??
    (lora && lora.region !== Config.Config_LoRaConfig_RegionCode.UNSET ? Config.Config_LoRaConfig_RegionCode[lora.region] : 'US');
  const [busy, setBusy] = useState(false);
  const festival = ready ? currentFestivalChannel() : undefined;

  const run = () =>
    Alert.alert(
      festival ? 'Replace festival channel?' : 'Create festival channel?',
      'Your radio gets a new private channel with full-precision location sharing and restarts. Friends then join by scanning your code.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Set up radio',
          onPress: async () => {
            setBusy(true);
            try {
              await createFestival(preset, Config.Config_LoRaConfig_RegionCode[region as keyof typeof Config.Config_LoRaConfig_RegionCode]);
              Alert.alert('Radio set up', 'It restarts in a few seconds. Then show your code to friends on the Link screen.');
            } catch (e) {
              Alert.alert('Setup failed', (e as Error).message);
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );

  return (
    <>
      <SectionTitle>Festival setup</SectionTitle>
      <Card>
        <Text style={styles.help}>
          {festival
            ? `This radio is on the private "${festival.name}" channel. Friends join by scanning your code.`
            : 'Do this once on one radio, then link the others. A private channel keeps your locations exact and visible only to your group.'}
        </Text>
        <Text style={styles.label}>Region</Text>
        <View style={styles.chips}>
          {REGIONS.map((r) => (
            <Chip key={r} label={r.replace('_', ' ')} selected={region === r} onPress={() => setRegion(r)} />
          ))}
        </View>
        <Text style={styles.label}>Radio preset (every radio must match)</Text>
        {PRESETS.map((p) => (
          <Pressable key={p.value} style={styles.option} onPress={() => setPreset(p.value)}>
            <Ionicons
              name={preset === p.value ? 'radio-button-on' : 'radio-button-off'}
              size={20}
              color={preset === p.value ? COLORS.text : COLORS.textFaint}
            />
            <View style={{ flex: 1 }}>
              <Text style={styles.optionTitle}>{p.label}</Text>
              <Text style={styles.help}>{p.hint}</Text>
            </View>
          </Pressable>
        ))}
        <Button
          label={busy ? 'Setting up…' : festival ? 'Create a new festival channel' : 'Set up this radio'}
          icon="sparkles-outline"
          disabled={!ready || busy}
          kind={festival ? 'secondary' : 'primary'}
          onPress={run}
        />
        <Button label="Link people (QR code)" icon="qr-code-outline" kind="secondary" onPress={() => router.push('/link')} />
      </Card>
    </>
  );
}

function ProfileSection() {
  const settings = useMesh((s) => s.settings);
  const update = useMesh((s) => s.updateSettings);
  const ready = useMesh((s) => s.configReady);
  const myNode = useMesh((s) => (s.myNodeNum ? s.nodes[s.myNodeNum] : undefined));
  const [longName, setLongName] = useState(settings.myLongName || myNode?.longName || '');
  const [shortName, setShortName] = useState(settings.myShortName || myNode?.shortName || '');

  return (
    <>
      <SectionTitle>You</SectionTitle>
      <Card>
        <TextInput
          style={styles.input}
          value={longName}
          onChangeText={setLongName}
          placeholder="Your name"
          placeholderTextColor={COLORS.textFaint}
          maxLength={39}
        />
        <TextInput
          style={styles.input}
          value={shortName}
          onChangeText={(t) => setShortName(t.slice(0, 4))}
          placeholder="Short name (4 letters, shown on radios)"
          placeholderTextColor={COLORS.textFaint}
          autoCapitalize="characters"
        />
        <Button
          label="Save name to radio"
          kind="secondary"
          disabled={!ready || !longName.trim()}
          onPress={() => {
            const long = longName.trim();
            const short = (shortName.trim() || long.slice(0, 4)).toUpperCase();
            Alert.alert(
              'Rename your radio?',
              `Your Meshtastic board will restart to apply "${long}". It's offline for about 15 seconds, then the app reconnects on its own.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Rename & restart',
                  onPress: async () => {
                    update({ myLongName: long, myShortName: short });
                    try {
                      await saveOwner(long, short);
                      Alert.alert('Radio restarting', 'Friends will see your new name once it announces itself on the mesh.');
                    } catch (e) {
                      Alert.alert("Couldn't save", (e as Error).message);
                    }
                  },
                },
              ],
            );
          }}
        />
        <Text style={styles.help}>Saving restarts your radio (about 15 seconds).</Text>
        <Text style={styles.label}>Your color (center dot)</Text>
        <View style={styles.chips}>
          {MY_COLORS.map((c) => (
            <Pressable
              key={c}
              onPress={() => update({ myColor: c })}
              style={[styles.swatch, { backgroundColor: c }, settings.myColor === c && styles.swatchOn]}
            />
          ))}
        </View>
      </Card>
    </>
  );
}

function FriendsSection() {
  const nodes = useMesh((s) => s.nodes);
  const myNum = useMesh((s) => s.myNodeNum);
  const updateFriend = useMesh((s) => s.updateFriend);
  const forget = useMesh((s) => s.forgetNode);
  const list = Object.values(nodes)
    .filter((n) => n.num !== myNum && (n.colorIdx !== undefined || n.hidden))
    .sort((a, b) => (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0) || (a.colorIdx ?? 99) - (b.colorIdx ?? 99));
  if (list.length === 0) return null;

  return (
    <>
      <SectionTitle>Friends</SectionTitle>
      <Card>
        <Text style={styles.help}>Tap a color to change it. Up to 8 friends show on the compass.</Text>
        {list.map((n) => (
          <View key={n.num} style={styles.friendRow}>
            <Pressable
              hitSlop={8}
              onPress={() => updateFriend(n.num, { colorIdx: ((n.colorIdx ?? -1) + 1) % FRIEND_COLORS.length })}
              style={[styles.swatchSmall, { backgroundColor: n.hidden ? COLORS.surfaceHigh : FRIEND_COLORS[n.colorIdx ?? 0] }]}
            />
            <Text style={[styles.friendName, n.hidden && { color: COLORS.textFaint }]} numberOfLines={1}>
              {friendName(n)}
            </Text>
            <Switch value={!n.hidden} onValueChange={(v) => updateFriend(n.num, { hidden: !v })} />
            <Pressable
              hitSlop={8}
              onPress={() =>
                Alert.alert(`Forget ${friendName(n)}?`, 'Removes them and your chat history. They come back if their radio is heard again.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Forget', style: 'destructive', onPress: () => forget(n.num) },
                ])
              }
            >
              <Ionicons name="trash-outline" size={18} color={COLORS.textFaint} />
            </Pressable>
          </View>
        ))}
      </Card>
    </>
  );
}

/** Radios heard nearby that aren't friends yet (e.g. on the public channel), to add by hand. */
function NearbySection() {
  const nodes = useMesh((s) => s.nodes);
  const myNum = useMesh((s) => s.myNodeNum);
  const addFriend = useMesh((s) => s.addFriend);
  const now = useNow(30_000);
  const nearby = selectNearbyRadios(nodes, myNum, now);
  if (nearby.length === 0) return null;

  return (
    <>
      <SectionTitle>Nearby radios</SectionTitle>
      <Card>
        <Text style={styles.help}>
          Radios on your channel that aren’t friends yet. Only radios on a private festival channel are added
          automatically, so strangers on the public channel don’t fill your compass.
        </Text>
        {nearby.map((n) => (
          <View key={n.num} style={styles.friendRow}>
            <Text style={styles.friendName} numberOfLines={1}>
              {friendName(n)}
            </Text>
            <Text style={styles.nearbyAgo}>{n.lastHeard ? timeAgo(n.lastHeard, now) : ''}</Text>
            <Button
              label="Add"
              kind="secondary"
              onPress={() => {
                if (!addFriend(n.num)) Alert.alert('8 friends already', 'Hide or forget a friend first to make room.');
              }}
            />
          </View>
        ))}
      </Card>
    </>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const settings = useMesh((s) => s.settings);
  const update = useMesh((s) => s.updateSettings);

  return (
    <ScrollView
      style={{ backgroundColor: COLORS.bg }}
      contentContainerStyle={{ paddingTop: insets.top, paddingHorizontal: SPACING.lg, paddingBottom: SPACING.xl * 2 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Settings</Text>
      <ConnectionSection />
      <FestivalSection />
      <ProfileSection />
      <FriendsSection />
      <NearbySection />

      <SectionTitle>Preferences</SectionTitle>
      <Card>
        <Row label="Units">
          <View style={styles.chips}>
            <Chip label="Meters" selected={settings.units === 'metric'} onPress={() => update({ units: 'metric' })} />
            <Chip label="Feet" selected={settings.units === 'imperial'} onPress={() => update({ units: 'imperial' })} />
          </View>
        </Row>
        <Row label="Keep screen on (compass)">
          <Switch value={settings.keepAwake} onValueChange={(v) => update({ keepAwake: v })} />
        </Row>
      </Card>

      <Text style={styles.footer}>
        FestivMesh · runs on Meshtastic radios. Filled dot = friend uses the app (can message, even when their phone is locked). Outlined dot =
        radio only (trackable). A slowly pulsing light is their last known spot.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  title: { color: COLORS.text, fontSize: 28, fontWeight: '700', paddingTop: SPACING.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  help: { color: COLORS.textDim, fontSize: 13, lineHeight: 18 },
  label: { color: COLORS.text, fontSize: 14, fontWeight: '600', marginTop: SPACING.xs },
  input: {
    color: COLORS.text,
    fontSize: 16,
    backgroundColor: COLORS.surfaceHigh,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: COLORS.border },
  found: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    padding: SPACING.md,
    borderRadius: 10,
    backgroundColor: COLORS.surfaceHigh,
  },
  foundName: { color: COLORS.text, fontSize: 15, flex: 1 },
  option: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md },
  optionTitle: { color: COLORS.text, fontSize: 15, fontWeight: '500' },
  swatch: { width: 30, height: 30, borderRadius: 15 },
  swatchOn: { borderWidth: 3, borderColor: COLORS.text },
  swatchSmall: { width: 22, height: 22, borderRadius: 11 },
  friendRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  friendName: { color: COLORS.text, fontSize: 15, flex: 1 },
  nearbyAgo: { color: COLORS.textFaint, fontSize: 12 },
  footer: { color: COLORS.textFaint, fontSize: 12, lineHeight: 17, marginTop: SPACING.xl, textAlign: 'center' },
});
