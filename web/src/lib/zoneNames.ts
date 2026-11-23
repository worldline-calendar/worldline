// A place's time zone by name, instantly and offline, for quick add ("9am Tokyo time", "4pm Taipei time"): every
// zone's own city (Asia/Tokyo → "tokyo"), the cities of the built-in airport list, US/Canadian regions, and a few
// countries with one zone. (The full city search in lib/zoneSearch.ts is loaded only when its picker opens.)
import { AIRPORTS } from './airports';

const EXTRA: Record<string, string> = {
  eastern: 'America/New_York', central: 'America/Chicago', mountain: 'America/Denver', pacific: 'America/Los_Angeles',
  atlantic: 'America/Halifax', newfoundland: 'America/St_Johns', alaska: 'America/Anchorage', hawaii: 'Pacific/Honolulu',
  'new york': 'America/New_York', nyc: 'America/New_York', 'san francisco': 'America/Los_Angeles', sf: 'America/Los_Angeles',
  la: 'America/Los_Angeles', 'bay area': 'America/Los_Angeles', ontario: 'America/Toronto', quebec: 'America/Toronto',
  'british columbia': 'America/Vancouver', bc: 'America/Vancouver', alberta: 'America/Edmonton',
  uk: 'Europe/London', britain: 'Europe/London', england: 'Europe/London', scotland: 'Europe/London', ireland: 'Europe/Dublin',
  germany: 'Europe/Berlin', france: 'Europe/Paris', spain: 'Europe/Madrid', italy: 'Europe/Rome', netherlands: 'Europe/Amsterdam',
  switzerland: 'Europe/Zurich', sweden: 'Europe/Stockholm', norway: 'Europe/Oslo', denmark: 'Europe/Copenhagen',
  finland: 'Europe/Helsinki', poland: 'Europe/Warsaw', greece: 'Europe/Athens', turkey: 'Europe/Istanbul', israel: 'Asia/Jerusalem',
  japan: 'Asia/Tokyo', korea: 'Asia/Seoul', 'south korea': 'Asia/Seoul', china: 'Asia/Shanghai', beijing: 'Asia/Shanghai',
  taiwan: 'Asia/Taipei', 'hong kong': 'Asia/Hong_Kong', singapore: 'Asia/Singapore', india: 'Asia/Kolkata', mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata', bangalore: 'Asia/Kolkata', 'new zealand': 'Pacific/Auckland', chile: 'America/Santiago',
  argentina: 'America/Argentina/Buenos_Aires', 'south africa': 'Africa/Johannesburg', utc: 'UTC', gmt: 'UTC',
};

let names: Map<string, string> | null = null;
function build() {
  const m = new Map<string, string>();
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  for (const z of zones) {
    const city = z.split('/').pop()!.replace(/_/g, ' ').toLowerCase();
    if (!m.has(city)) m.set(city, z);
  }
  for (const a of AIRPORTS.values()) {
    const city = a.city.replace(/\s*\(.*\)$/, '').toLowerCase();
    if (!m.has(city)) m.set(city, a.zone);
  }
  for (const [k, z] of Object.entries(EXTRA)) m.set(k, z);
  return m;
}

/** "Tokyo" → "Asia/Tokyo"; "new york" → "America/New_York"; unknown → undefined. */
export function zoneByName(name: string): string | undefined {
  names ??= build();
  return names.get(name.trim().toLowerCase().replace(/\s+/g, ' '));
}
