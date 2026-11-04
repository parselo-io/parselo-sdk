/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LICENSE_TOKEN: string;
  readonly VITE_LICENSE_KID: string;
  readonly VITE_LICENSE_SPKI: string;
  // Task 03 — Badge Check-in device test. Optional: just a first-launch default for the
  // in-app proxy URL field, which is otherwise editable and persisted via Preferences (the LAN
  // IP changes per network, so this is a convenience, not a real config source).
  readonly VITE_BADGE_CHECKIN_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
