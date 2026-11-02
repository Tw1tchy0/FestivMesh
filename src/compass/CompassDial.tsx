import { memo, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, G, Line, Path, Polygon } from 'react-native-svg';
import { formatDistance, unwrapHeading } from '../geo';
import { useHeading } from '../hooks/useSensors';
import { COLORS } from '../theme';
import { arcPath, ARRIVED_M, bondSpanDeg, DISTANCE_RINGS, polar, radiusForDistance } from './geometry';

export type DialFriend = {
  num: number;
  color: string;
  bearing: number;
  dist: number;
  canMessage: boolean;
  fresh: boolean;
};
export type DialPin = { num: number; color: string; bearing: number; dist: number };

type Props = {
  size: number;
  /** On screen: animations only run while true. */
  active: boolean;
  friends: DialFriend[];
  pins: DialPin[];
  myColor: string;
  hasFix: boolean;
  units: 'metric' | 'imperial';
  onPressFriend: (num: number) => void;
};

const AnimatedG = Animated.createAnimatedComponent(G);

/**
 * Totem-style compass: a halo ring with a coloured Bond arc per friend that sweeps
 * wider as they get closer, log-scaled distance arcs inside, and your own radio as a
 * dot in the centre that friends ring once you've found them.
 */
export const CompassDial = memo(function CompassDial({
  size,
  active,
  friends,
  pins,
  myColor,
  hasFix,
  units,
  onPressFriend,
}: Props) {
  const c = size / 2;
  const haloR = c - 12;
  const innerR = 30;
  const fieldR = haloR - 20;

  // Rotate the whole world layer so north stays north as the phone turns. Subscribes to the
  // heading directly so turning only moves this layer instead of redrawing the SVG.
  const rotation = useSharedValue(0);
  const continuous = useRef(0);
  useEffect(() => {
    const turn = (heading: number | null) => {
      if (heading == null) return;
      continuous.current = unwrapHeading(continuous.current, heading);
      rotation.value = withTiming(-continuous.current, { duration: 180, easing: Easing.out(Easing.quad) });
    };
    turn(useHeading.getState().heading);
    return useHeading.subscribe((s, prev) => {
      if (s.heading !== prev.heading) turn(s.heading);
    });
  }, [rotation]);
  const worldStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));

  const arrived = friends.filter((f) => f.dist <= ARRIVED_M);
  // Farthest first, so a nearer friend's (wider) arc draws on top where they overlap.
  const away = friends.filter((f) => f.dist > ARRIVED_M).sort((a, b) => b.dist - a.dist);
  const live = away.filter((f) => f.fresh);
  const stale = away.filter((f) => !f.fresh);

  // Endless animations redraw every frame, so they only run while on screen and needed.
  // Slow "breathing" for last-known positions.
  const breath = useSharedValue(1);
  const breathing = active && stale.length > 0;
  useEffect(() => {
    if (breathing) breath.value = withRepeat(withTiming(0.25, { duration: 1600, easing: Easing.inOut(Easing.sin) }), -1, true);
    else {
      cancelAnimation(breath);
      breath.value = 0.6;
    }
  }, [breathing, breath]);
  const breathingProps = useAnimatedProps(() => ({ opacity: breath.value }));

  // Two dots swirling round the halo while waiting for a GPS fix.
  const swirl = useSharedValue(0);
  const swirling = active && !hasFix;
  useEffect(() => {
    if (swirling) swirl.value = withRepeat(withTiming(360, { duration: 1800, easing: Easing.linear }), -1, false);
    else cancelAnimation(swirl);
  }, [swirling, swirl]);
  const swirlStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${swirl.value}deg` }] }));

  // Faint track the Bond arcs sit on, with ticks every 30° (longer at N/E/S/W).
  const haloBase = useMemo(
    () => (
      <G>
        <Circle cx={c} cy={c} r={haloR} stroke={COLORS.haloTrack} strokeWidth={6} fill="none" />
        {Array.from({ length: 12 }, (_, i) => {
          const cardinal = i % 3 === 0;
          const a = polar(c, c, haloR - (cardinal ? 9 : 6), i * 30);
          const b = polar(c, c, haloR - 4, i * 30);
          return (
            <Line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={COLORS.textFaint}
              strokeWidth={cardinal ? 2 : 1}
              strokeLinecap="round"
            />
          );
        })}
      </G>
    ),
    [c, haloR],
  );

  // A friend's Bond Light: an arc centred on their bearing that sweeps wider as they get closer.
  const bondLight = (f: DialFriend) => {
    const d = arcPath(c, c, haloR, f.bearing, bondSpanDeg(f.dist));
    return (
      <G key={f.num}>
        <Path d={d} stroke={f.color} strokeWidth={16} strokeLinecap="round" fill="none" opacity={0.16} />
        <Path d={d} stroke={f.color} strokeWidth={6} strokeLinecap="round" fill="none" />
      </G>
    );
  };

  const marker = (f: DialFriend) => {
    const r = radiusForDistance(f.dist, innerR, fieldR);
    const p = polar(c, c, r, f.bearing);
    return (
      <G key={f.num} onPress={() => onPressFriend(f.num)}>
        <Circle cx={p.x} cy={p.y} r={20} fill="transparent" />
        <Circle cx={p.x} cy={p.y} r={13} fill={f.color} opacity={0.14} />
        {f.canMessage ? (
          <Circle cx={p.x} cy={p.y} r={7} fill={f.color} />
        ) : (
          // Radio only: outlined, since you can track but not message them.
          <Circle cx={p.x} cy={p.y} r={6} fill={COLORS.bg} stroke={f.color} strokeWidth={2.5} />
        )}
      </G>
    );
  };

  const pinMarker = (p: DialPin) => {
    const r = radiusForDistance(p.dist, innerR, fieldR);
    const { x, y } = polar(c, c, r, p.bearing);
    const s = 6;
    return (
      <Polygon
        key={`pin-${p.num}`}
        points={`${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}`}
        fill="none"
        stroke={p.color}
        strokeWidth={2}
      />
    );
  };

  // Friends you've found ring your own dot, one coloured segment each.
  const arrivedRing = () => {
    if (arrived.length === 1) {
      return <Circle cx={c} cy={c} r={16} stroke={arrived[0].color} strokeWidth={3.5} fill="none" />;
    }
    const seg = 360 / arrived.length;
    return arrived.map((f, i) => (
      <Path
        key={f.num}
        d={arcPath(c, c, 16, i * seg + seg / 2, seg - 14)}
        stroke={f.color}
        strokeWidth={3.5}
        strokeLinecap="round"
        fill="none"
      />
    ));
  };

  const north = polar(c, c, haloR + 0.5, 0);

  return (
    <View style={{ width: size, height: size }}>
      {/* World layer: rotates with heading */}
      <Animated.View style={[StyleSheet.absoluteFill, worldStyle]}>
        <Svg width={size} height={size}>
          {DISTANCE_RINGS.map((d) => (
            <Circle
              key={d}
              cx={c}
              cy={c}
              r={radiusForDistance(d, innerR, fieldR)}
              stroke={COLORS.border}
              strokeWidth={1}
              strokeDasharray="2 6"
              fill="none"
            />
          ))}
          {haloBase}
          <Path
            d={`M ${north.x} ${north.y - 11} l 5 8 l -10 0 z`}
            fill={COLORS.danger}
          />
          {pins.map(pinMarker)}
          <AnimatedG animatedProps={breathingProps}>
            <G opacity={0.7}>{stale.map(bondLight)}</G>
            {stale.map(marker)}
          </AnimatedG>
          {live.map(bondLight)}
          {live.map(marker)}
        </Svg>
      </Animated.View>

      {!hasFix && (
        <Animated.View style={[StyleSheet.absoluteFill, swirlStyle]} pointerEvents="none">
          <Svg width={size} height={size}>
            {[0, 180].map((b) => (
              <Path key={b} d={arcPath(c, c, haloR, b, 18)} stroke={COLORS.accent} strokeWidth={6} strokeLinecap="round" fill="none" />
            ))}
          </Svg>
        </Animated.View>
      )}

      {/* Fixed layer: "you are facing" tick, your radio, ring labels */}
      <Svg width={size} height={size} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Path d={`M ${c} ${2} l 6 9 l -12 0 z`} fill={COLORS.text} />
        <Circle cx={c} cy={c} r={14} fill={myColor} opacity={0.18} />
        <Circle cx={c} cy={c} r={8} fill={myColor} />
        {arrived.length > 0 && arrivedRing()}
      </Svg>
      {DISTANCE_RINGS.map((d) => {
        const p = polar(c, c, radiusForDistance(d, innerR, fieldR), 135);
        return (
          <Text key={d} pointerEvents="none" style={[styles.ringLabel, { left: p.x + 2, top: p.y - 2 }]}>
            {formatDistance(d, units)}
          </Text>
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  ringLabel: { position: 'absolute', color: COLORS.textFaint, fontSize: 9, fontVariant: ['tabular-nums'] },
});
