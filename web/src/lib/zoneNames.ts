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
  argentina: 'America/Argentina/Buenos_Aires', bali: 'Asia/Makassar', nz: 'Pacific/Auckland', iceland: 'Atlantic/Reykjavik', hk: 'Asia/Hong_Kong', 'south africa': 'Africa/Johannesburg', utc: 'UTC', gmt: 'UTC',
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

/** Zone abbreviations people write after a time ("3pm PST", "13:00 CEST"): the zone whose clock they mean. */
export const ZONE_ABBR: Record<string, string> = {
  PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PT: 'America/Los_Angeles',
  MST: 'America/Denver', MDT: 'America/Denver', MT: 'America/Denver',
  CST: 'America/Chicago', CDT: 'America/Chicago', CT: 'America/Chicago',
  EST: 'America/New_York', EDT: 'America/New_York', ET: 'America/New_York',
  AST: 'America/Halifax', ADT: 'America/Halifax', NST: 'America/St_Johns', NDT: 'America/St_Johns',
  AKST: 'America/Anchorage', AKDT: 'America/Anchorage', HST: 'Pacific/Honolulu',
  UTC: 'UTC', GMT: 'Europe/London', Z: 'UTC', BST: 'Europe/London', WET: 'Europe/Lisbon', WEST: 'Europe/Lisbon',
  CET: 'Europe/Paris', CEST: 'Europe/Paris', EET: 'Europe/Athens', EEST: 'Europe/Athens', MSK: 'Europe/Moscow',
  IST: 'Asia/Kolkata', PKT: 'Asia/Karachi', SGT: 'Asia/Singapore', HKT: 'Asia/Hong_Kong', CST8: 'Asia/Shanghai',
  JST: 'Asia/Tokyo', KST: 'Asia/Seoul', AWST: 'Australia/Perth', ACST: 'Australia/Adelaide', ACDT: 'Australia/Adelaide',
  AEST: 'Australia/Brisbane', AEDT: 'Australia/Sydney', NZST: 'Pacific/Auckland', NZDT: 'Pacific/Auckland',
};
/** Region words that name a North American zone right after a time ("11am pacific", "2 eastern"). */
export const ZONE_WORDS: Record<string, string> = {
  pacific: 'America/Los_Angeles', mountain: 'America/Denver', central: 'America/Chicago', eastern: 'America/New_York', atlantic: 'America/Halifax',
};
