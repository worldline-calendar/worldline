// The saved data's format version (data/store.ts → persist). Bump it with a migration when the format changes.
export const STORE_VERSION = 3; // 3: big collections saved under their own keys (data/persist.ts) — an older copy must not read only the head
