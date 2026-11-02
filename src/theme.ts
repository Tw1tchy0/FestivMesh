export const COLORS = {
  bg: '#07070b',
  surface: '#121219',
  surfaceHigh: '#1b1b25',
  border: '#262633',
  text: '#f2f2f7',
  textDim: '#8e8ea0',
  textFaint: '#55556a',
  haloTrack: '#23232e',
  accent: '#c9b6ff',
  danger: '#ff5a6e',
  ok: '#4ade80',
  warn: '#fbbf24',
};

// Bond colors, in the order friends are assigned them (Totem: pink, green, blue, yellow first).
export const FRIEND_COLORS = [
  '#ff4fa3', // pink
  '#3ee07a', // green
  '#3d8bff', // blue
  '#ffd23d', // yellow
  '#ff8a3d', // orange
  '#a66bff', // purple
  '#2ee6e6', // cyan
  '#ff4d4d', // red
] as const;

export const MAX_FRIENDS = 8;

export const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const RADIUS = { sm: 8, md: 14, lg: 20, pill: 999 };
export const TAB_BAR_HEIGHT = 64;
