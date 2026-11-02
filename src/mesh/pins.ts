// Meeting points travel as plain text ("📍 40.76810,-73.98190 main stage") so they
// also read sensibly on a T-Beam screen or in the official Meshtastic apps.
const PIN_RE = /📍\s*(-?\d{1,2}\.\d{3,7})\s*,\s*(-?\d{1,3}\.\d{3,7})\s*(.*)$/su;

export function formatPin(lat: number, lon: number, note = ''): string {
  return `📍 ${lat.toFixed(5)},${lon.toFixed(5)}${note ? ' ' + note.trim() : ''}`;
}

export function parsePin(text: string): { lat: number; lon: number; note: string } | null {
  const m = PIN_RE.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, note: m[3].trim() };
}
