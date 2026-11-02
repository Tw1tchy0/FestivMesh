import Ionicons from '@expo/vector-icons/Ionicons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Button } from '../components/ui';
import { currentFestivalChannel, currentShareUrl, joinFestival, readShareUrl } from '../mesh/festival';
import { useMesh } from '../store/useMesh';
import { COLORS, SPACING } from '../theme';

export default function LinkScreen() {
  const router = useRouter();
  const ready = useMesh((s) => s.configReady);
  useMesh((s) => s.radioRev); // re-render when the radio's channel changes
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  const url = ready ? currentShareUrl() : undefined;
  const festival = ready ? currentFestivalChannel() : undefined;

  const offerJoin = (link: string) => {
    let name: string;
    try {
      name = readShareUrl(link).channel.name || 'festival';
    } catch (e) {
      Alert.alert('Not a festival code', (e as Error).message, [{ text: 'OK', onPress: () => (handled.current = false) }]);
      return;
    }
    Alert.alert(
      `Join "${name}"?`,
      'Your radio switches to this private channel and radio preset, then restarts. You and everyone on it will see each other on the compass.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => (handled.current = false) },
        {
          text: 'Join',
          onPress: async () => {
            setScanning(false);
            setBusy(true);
            try {
              await joinFestival(link);
              Alert.alert('Joined', 'Your radio is restarting. Friends appear once their radios are heard.', [
                { text: 'OK', onPress: () => router.back() },
              ]);
            } catch (e) {
              Alert.alert("Couldn't join", (e as Error).message);
            } finally {
              setBusy(false);
              handled.current = false;
            }
          },
        },
      ],
    );
  };

  const startScan = async () => {
    if (!permission?.granted) {
      const p = await requestPermission();
      if (!p.granted) return Alert.alert('Camera needed', 'Allow camera access to scan a friend’s code.');
    }
    handled.current = false;
    setScanning(true);
  };

  return (
    <ScrollView style={{ backgroundColor: COLORS.bg }} contentContainerStyle={styles.page}>
      {!ready ? (
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.text} />
          <Text style={styles.help}>Connect to your radio first (Settings › Radio connection).</Text>
        </View>
      ) : scanning ? (
        <View style={styles.cameraBox}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (handled.current) return;
              handled.current = true;
              offerJoin(data);
            }}
          />
          <View style={styles.frame} pointerEvents="none" />
        </View>
      ) : url ? (
        <View style={styles.center}>
          <Text style={styles.heading}>Your festival code</Text>
          <View style={styles.qr}>
            <QRCode value={url} size={230} backgroundColor="#fff" color="#000" />
          </View>
          <Text style={styles.help}>
            Friends scan this in Festival Compass (or the official Meshtastic app) to join “{festival?.name}”. It contains your
            group’s private key: only show it to your group.
          </Text>
        </View>
      ) : (
        <View style={styles.center}>
          <Ionicons name="radio-outline" size={36} color={COLORS.textDim} />
          <Text style={styles.heading}>No festival channel yet</Text>
          <Text style={styles.help}>
            Either set one up on this radio (Settings › Festival setup), or scan the code of a friend who already has.
          </Text>
        </View>
      )}

      <View style={styles.actions}>
        {scanning ? (
          <Button label="Stop scanning" kind="secondary" onPress={() => setScanning(false)} />
        ) : (
          <Button label="Scan a friend's code" icon="scan-outline" onPress={startScan} disabled={!ready || busy} />
        )}
        {url && !scanning && (
          <Button
            label="Copy link"
            icon="copy-outline"
            kind="secondary"
            onPress={async () => {
              await Clipboard.setStringAsync(url);
              Alert.alert('Copied', 'Paste it on another phone, or into this app after connecting your other radio.');
            }}
          />
        )}
        <Button
          label="Paste a link"
          icon="clipboard-outline"
          kind="secondary"
          disabled={!ready || busy}
          onPress={async () => {
            const text = await Clipboard.getStringAsync();
            if (!text) return Alert.alert('Clipboard is empty');
            offerJoin(text);
          }}
        />
        {!festival && ready && !scanning && (
          <Button label="Go to festival setup" kind="secondary" onPress={() => router.navigate('/settings')} />
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: SPACING.xl, gap: SPACING.xl },
  center: { alignItems: 'center', gap: SPACING.md, paddingTop: SPACING.lg },
  heading: { color: COLORS.text, fontSize: 20, fontWeight: '700' },
  help: { color: COLORS.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  qr: { padding: 16, backgroundColor: '#fff', borderRadius: 20 },
  cameraBox: { height: 340, borderRadius: 20, overflow: 'hidden', backgroundColor: '#000' },
  frame: {
    position: 'absolute',
    top: 60,
    left: 60,
    right: 60,
    bottom: 60,
    borderWidth: 3,
    borderColor: '#ffffffcc',
    borderRadius: 20,
  },
  actions: { gap: SPACING.sm },
});
