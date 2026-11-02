import '../polyfills';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useSensorTracking } from '../hooks/useSensors';
import { connect } from '../mesh/connection';
import { useMesh } from '../store/useMesh';
import { COLORS } from '../theme';

let autoConnected = false;

function useAutoConnect() {
  useEffect(() => {
    if (autoConnected) return; // dev StrictMode runs effects twice
    autoConnected = true;
    const start = () => void connect().catch(() => {});
    if (useMesh.persist.hasHydrated()) start();
    else return useMesh.persist.onFinishHydration(start);
  }, []);
}

export default function RootLayout() {
  useSensorTracking();
  useAutoConnect();
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: COLORS.bg },
          headerTintColor: COLORS.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: COLORS.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="chat/[num]" options={{ title: '' }} />
        <Stack.Screen
          name="friend/[num]"
          options={{
            presentation: 'formSheet',
            sheetAllowedDetents: [0.5, 0.85],
            sheetGrabberVisible: true,
            headerShown: false,
            contentStyle: { backgroundColor: COLORS.surface },
          }}
        />
        <Stack.Screen name="link" options={{ presentation: 'modal', title: 'Link people' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
