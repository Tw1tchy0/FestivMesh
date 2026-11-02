# Festival Compass

Find your friends at festivals without cell service. Each person carries a Meshtastic radio (T-Beam etc.). The app shows friends on a Totem-style compass and sends direct messages radio to radio.

- **Compass** (middle tab): a halo ring that turns with your phone. Each friend gets a colored Bond arc on it that sweeps wider as they get closer (a sliver past 1.5 km, about a third of the ring within 25 m). Inside the halo, a dot sits on dashed 50 m / 200 m / 1 km arcs. Your own radio is the dot in the center; within 15 m, a friend's color rings it.
  - Filled dot: they use the app, so you can message them. If their phone is locked or the app is closed, the friend shows "phone away" and the message waits on their radio until they open the app.
  - Outlined dot: radio only. You can track them, but you can't message them.
  - Slowly pulsing light: their last known position.
- **Messages** (left tab): DMs with delivery ticks (on the mesh → delivered). Quick replies and "Send my location" (a meeting point that shows on the friend's compass). New messages raise an alert and set the app icon badge; tapping the alert opens the chat.
- **Settings** (right tab): radio connection, one-tap festival setup (private channel, full-precision GPS, frequent position updates, LoRa preset), your name and color, friends, and **Nearby radios** to add by hand.

Who becomes a friend: radios heard on a private channel (the festival channel) are added automatically, up to 8. Radios on the public default channel are not, so strangers nearby can't fill your compass; add them under Settings › Nearby radios. Anyone who DMs you is added.

## Run it

```bash
npm install
npx expo start          # scan with Expo Go (SDK 58)
```

It starts in **Simulator** mode, with fake friends walking around you.

### Real T-Beam from Expo Go (PC bridge)

Expo Go can't use Bluetooth, so the PC forwards a USB-connected T-Beam to the phone over WiFi:

```bash
npm run probe           # check the radio answers (prints firmware, nodes, channel)
npm run bridge          # serves ws://<pc-ip>:8787; add --port COM6 to pick a port, --verbose for logs
```

Close any other program using the radio's serial port first (Meshtastic web/desktop client, serial monitor). In the app, go to Settings › PC Bridge and enter the address the bridge printed. The phone and the PC must be on the same WiFi.

### Bluetooth (development build)

`react-native-ble-plx` is already wired up (`src/mesh/bleTransport.ts`), but it needs the app's own build instead of Expo Go: `npx eas-cli build --profile development --platform ios` (needs an Apple Developer account), or Android via `npx expo run:android`.

What works with the phone locked depends on the build. iOS pauses apps in the background:

| | Expo Go (bridge) | Bluetooth build |
|---|---|---|
| Message alerts with the app in the background | No: nothing runs until you reopen the app | Yes, while iOS keeps the app in memory: it wakes the app for each packet from the radio (not yet tested on a device) |
| Friends can message you while your phone is locked | Yes, it waits on your radio | Yes |
| Your radio keeps sharing your position | Yes (radio GPS) | Yes |
| App swiped away (force-quit) | Radio only; messages wait until you open the app | Same: iOS doesn't wake force-quit apps |

## Festival setup

1. Connect one radio, then Settings › Festival setup › pick your region and preset › **Set up this radio**.
2. On each other radio, open Link people (QR button) and scan the first person's code. To set up your own second radio, plug it in and use **Paste a link**.

All radios must share the channel and the preset. The setup uses position precision 32. The public default channel blurs positions to about 1 km, which is useless for finding people.

Position updates adapt to movement: a walking radio sends after every 10 m (at most every 15 s), a radio standing still sends once every 2 minutes. The app learns how often it usually hears each friend and starts pulsing their dot as "last known" after about three missed updates: around 90 seconds for someone walking, 5 minutes for someone standing still.

## Layout

- `src/app/`: screens (Expo Router)
- `src/compass/`: dial and geometry
- `src/mesh/`: Meshtastic protocol, MeshClient, and transports (sim / bridge / BLE)
- `bridge/`: USB serial ↔ WebSocket bridge
- `tests/`: unit tests, run with `npm test`. `tests/festival.test.ts` acts out festival situations (phone dies mid-send, app swiped away, radio out of range or out of battery, friend's phone locked, strangers on the public channel) against a fake radio.
