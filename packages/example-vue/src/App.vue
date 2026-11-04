<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { Preferences } from "@capacitor/preferences";
import { Device } from "@capacitor/device";
import { Scanner, type ScanResult, type KeyValueStore } from "@parselo/scanner-core";
import VideoScanner from "./VideoScanner.vue";
import MrzScanner from "./MrzScanner.vue";
import IneScanner from "./IneScanner.vue";
import BadgeCheckin from "./BadgeCheckin.vue";

// ─── Top-level screen (Task 03 — Badge Check-in is a separate service test, not another
// scanMode alongside licence/passport/ine: it doesn't use the Scanner SDK at all) ─────────────
type AppScreen = "id-scanning" | "badge-checkin";
const appScreen = ref<AppScreen>("id-scanning");

const LICENSE_TOKEN = import.meta.env.VITE_LICENSE_TOKEN;
const LICENSE_KID   = import.meta.env.VITE_LICENSE_KID;
const LICENSE_SPKI  = import.meta.env.VITE_LICENSE_SPKI;

const preferencesStore: KeyValueStore = {
  async get(key: string) {
    const { value } = await Preferences.get({ key });
    return value;
  },
  async set(key: string, value: string) {
    await Preferences.set({ key, value });
  },
};

// ─── Scan mode ────────────────────────────────────────────────────────────────
type ScanMode = "licence" | "passport" | "ine";
const scanMode = ref<ScanMode>("licence");

// ─── Barcode (PDF417) camera bridge ───────────────────────────────────────────
const showScanner = ref(false);
let resolveCapture: ((raw: string)   => void) | null = null;
let rejectCapture:  ((err: Error)    => void) | null = null;

function onDecoded(raw: string) {
  showScanner.value = false;
  resolveCapture?.(raw);
  resolveCapture = null;
  rejectCapture  = null;
}

function onBarcodeCancelled() {
  showScanner.value = false;
  rejectCapture?.(new Error("cancelled"));
  resolveCapture = null;
  rejectCapture  = null;
}

const native = {
  captureAndDecodePdf417(): Promise<string | null> {
    showScanner.value = true;
    return new Promise<string>((resolve, reject) => {
      resolveCapture = resolve;
      rejectCapture  = reject;
    });
  },
};

// ─── MRZ camera bridge (shared by passport TD3 and INE TD1 — same OCR capture,
// scanner-core picks the parser; the overlay component shown just changes the
// framing/hint text for whichever mode is active) ─────────────────────────────
const showMrzScanner = ref(false);
let resolveMrzCapture: ((lines: string[]) => void) | null = null;
let rejectMrzCapture:  ((err: Error)      => void) | null = null;

function onRecognized(lines: string[]) {
  showMrzScanner.value = false;
  resolveMrzCapture?.(lines);
  resolveMrzCapture = null;
  rejectMrzCapture  = null;
}

function onMrzCancelled() {
  showMrzScanner.value = false;
  rejectMrzCapture?.(new Error("cancelled"));
  resolveMrzCapture = null;
  rejectMrzCapture  = null;
}

const mrzNative = {
  captureAndRecognizeMrz(): Promise<string[] | null> {
    showMrzScanner.value = true;
    return new Promise<string[]>((resolve, reject) => {
      resolveMrzCapture = resolve;
      rejectMrzCapture  = reject;
    });
  },
};

// ─── Scanner ──────────────────────────────────────────────────────────────────
let scanner: Scanner;

const status    = ref<"idle" | "scanning" | "done" | "error">("idle");
const result    = ref<ScanResult | null>(null);
const errText   = ref("");
const licenseOk = ref<boolean | null>(null);

const ERROR_LABELS: Record<string, string> = {
  license_malformed:       "License token is malformed.",
  license_unknown_key:     "License key not recognized — check VITE_LICENSE_KID / VITE_LICENSE_SPKI.",
  license_bad_signature:   "License signature invalid.",
  license_expired:         "License has expired — mint a new token.",
  license_bundle_mismatch: "License bundle ID does not match this app.",
  no_barcode:              "No PDF417 barcode found.",
  not_aamva:               "Barcode found but it's not a Canadian/AAMVA ID.",
  no_mrz:                  "No passport MRZ found — point the camera at the data page.",
  no_ine:                  "No INE MRZ found — point the camera at the back of the card.",
};

const scanBtnLabel = computed(() => {
  if (licenseOk.value === null) return "Checking license…";
  if (scanMode.value === "passport") return "Scan passport";
  if (scanMode.value === "ine") return "Scan INE";
  return "Scan licence";
});

const hintText = computed(() => {
  if (scanMode.value === "passport") return "Tap the button, then point the camera at the data page (photo page) of a passport.";
  if (scanMode.value === "ine") return "Tap the button, then point the camera at the back of a Mexican INE credential (Credencial para Votar).";
  return "Tap the button, then hold the back of a Canadian driver's licence steady in front of the camera.";
});

async function scan() {
  status.value  = "scanning";
  result.value  = null;
  errText.value = "";
  try {
    const r = scanMode.value === "passport"
      ? await scanner.scanPassport()
      : scanMode.value === "ine"
      ? await scanner.scanIne()
      : await scanner.scan();
    result.value = r;
    status.value = r.ok ? "done" : "error";
    if (!r.ok) errText.value = ERROR_LABELS[r.error ?? ""] ?? (r.error ?? "Unknown error");
  } catch (e: unknown) {
    if (e instanceof Error && e.message === "cancelled") {
      status.value = "idle";
      return;
    }
    status.value  = "error";
    errText.value = e instanceof Error ? e.message : String(e);
  }
}

async function flush() {
  await scanner.flushAnalytics();
  alert("Analytics flushed.");
}

onMounted(async () => {
  let deviceModel = "unknown";
  try {
    const info = await Device.getInfo();
    deviceModel = `${info.manufacturer} ${info.model}`.trim() || "unknown";
  } catch { /* web preview or permissions denied */ }

  scanner = new Scanner({
    license: {
      token: LICENSE_TOKEN,
      bundleId: "com.example.idscan",
      publicKeys: { [LICENSE_KID]: LICENSE_SPKI },
    },
    analytics: {
      ingestUrl: "https://i4btgxv6i8.execute-api.ca-central-1.amazonaws.com/events",
      store: preferencesStore,
    },
    native,
    mrzNative,
    deviceModel,
  });

  try {
    const r = await scanner.init();
    licenseOk.value = r.valid;
    if (!r.valid) errText.value = ERROR_LABELS[`license_${r.reason}`] ?? `License invalid: ${r.reason}`;
  } catch (e: unknown) {
    licenseOk.value = false;
    errText.value = e instanceof Error ? e.message : String(e);
  }
});
</script>

<template>
  <!-- Camera overlays (full-screen, rendered on top) -->
  <VideoScanner v-if="showScanner" @decoded="onDecoded" @cancelled="onBarcodeCancelled" />
  <MrzScanner   v-if="showMrzScanner && scanMode === 'passport'" @recognized="onRecognized" @cancelled="onMrzCancelled" />
  <IneScanner   v-if="showMrzScanner && scanMode === 'ine'"      @recognized="onRecognized" @cancelled="onMrzCancelled" />

  <div v-if="!showScanner && !showMrzScanner" class="app">
    <h1>PARSELO</h1>

    <div class="screen-toggle">
      <button :class="{ active: appScreen === 'id-scanning' }" @click="appScreen = 'id-scanning'">ID Scanning</button>
      <button :class="{ active: appScreen === 'badge-checkin' }" @click="appScreen = 'badge-checkin'">Badge Check-in</button>
    </div>

    <BadgeCheckin v-if="appScreen === 'badge-checkin'" />

    <template v-else>
    <div v-if="licenseOk === false" class="card error">
      <strong>License error:</strong> {{ errText }}
    </div>

    <template v-else>
      <!-- Mode toggle -->
      <div class="mode-toggle">
        <button
          :class="{ active: scanMode === 'licence' }"
          @click="scanMode = 'licence'; result = null; errText = ''; status = 'idle'"
        >Driver's Licence</button>
        <button
          :class="{ active: scanMode === 'passport' }"
          @click="scanMode = 'passport'; result = null; errText = ''; status = 'idle'"
        >Passport</button>
        <button
          :class="{ active: scanMode === 'ine' }"
          @click="scanMode = 'ine'; result = null; errText = ''; status = 'idle'"
        >INE (MX)</button>
      </div>

      <p class="hint">{{ hintText }}</p>

      <button
        class="scan-btn"
        :disabled="status === 'scanning' || licenseOk === null"
        @click="scan"
      >
        {{ scanBtnLabel }}
      </button>

      <div v-if="status === 'error'" class="card error">
        <strong>Error:</strong> {{ errText }}
      </div>

      <div v-if="result?.ok && result.document" class="card success">
        <h2>Scan successful ✓</h2>
        <dl>
          <dt>Document type</dt><dd>{{ result.document.documentType }}</dd>
          <dt>Jurisdiction</dt><dd>{{ result.document.jurisdiction }}</dd>
          <!-- Issuer ID, useful for debugging jurisdiction/issuer questions. -->
          <template v-if="result.document.raw?.iin">
            <dt>AAMVA IIN</dt><dd>{{ result.document.raw.iin }}</dd>
          </template>
          <template v-if="result.document.fields.firstName">
            <dt>First name</dt><dd>{{ result.document.fields.firstName.value }}</dd>
          </template>
          <template v-if="result.document.fields.lastName">
            <dt>Last name</dt><dd>{{ result.document.fields.lastName.value }}</dd>
          </template>
          <template v-if="result.document.fields.dateOfBirth">
            <dt>Date of birth</dt><dd>{{ result.document.fields.dateOfBirth.value }}</dd>
          </template>
          <template v-if="result.document.fields.documentNumber">
            <dt>Document #</dt><dd>{{ result.document.fields.documentNumber.value }}</dd>
          </template>
          <template v-if="result.document.fields.expiryDate">
            <dt>Expiry</dt><dd>{{ result.document.fields.expiryDate.value }}</dd>
          </template>
          <!-- Licence-specific fields -->
          <template v-if="result.document.fields.addressStreet">
            <dt>Address</dt>
            <dd>
              {{ result.document.fields.addressStreet.value }},
              {{ result.document.fields.addressCity?.value }}
              {{ result.document.fields.addressRegion?.value }}
              {{ result.document.fields.addressPostalCode?.value }}
            </dd>
          </template>
          <!-- Passport-specific fields -->
          <template v-if="result.document.fields.country">
            <dt>Issuing country</dt><dd>{{ result.document.fields.country.value }}</dd>
          </template>
          <template v-if="result.document.fields.sex">
            <dt>Sex</dt><dd>{{ result.document.fields.sex.value }}</dd>
          </template>
          <!-- Confidence (useful during MRZ testing) -->
          <template v-if="result.document.documentType === 'passport' || result.document.documentType === 'ine'">
            <dt>MRZ confidence</dt>
            <dd>{{ (result.document.fields.documentNumber?.confidence ?? 0).toFixed(2) }}</dd>
          </template>
          <!-- INE-specific: offline integrity signal — see scanner-core README before
               treating any of this as proof the card is genuine or registered with INE. -->
          <template v-if="result.document.documentType === 'ine'">
            <dt>Integrity (offline)</dt><dd>{{ result.document.raw?.integrityOverall }}</dd>
            <dt>MRZ check digits</dt><dd>{{ result.document.raw?.mrzCheckDigitsValid }}</dd>
            <dt>CURP</dt><dd>{{ result.document.raw?.curp ?? "(not decoded — MRZ-only path)" }}</dd>
            <dt>Clave de Elector</dt><dd>{{ result.document.raw?.claveElector ?? "(not decoded — MRZ-only path)" }}</dd>
          </template>
        </dl>

        <details>
          <summary>Full JSON (debug)</summary>
          <pre>{{ JSON.stringify(result, null, 2) }}</pre>
        </details>

        <button class="flush-btn" @click="flush">Flush analytics</button>
      </div>
    </template>
    </template>
  </div>
</template>

<style scoped>
.app {
  font-family: system-ui, sans-serif;
  max-width: 480px;
  margin: 0 auto;
  padding: 24px 16px;
}
h1 { font-size: 1.4rem; margin-bottom: 16px; }
.hint { color: #555; font-size: 0.9rem; margin-bottom: 24px; }

/* Top-level screen toggle (Task 03 — Badge Check-in vs. the existing ID-scanning demos) */
.screen-toggle {
  display: flex;
  gap: 0;
  margin-bottom: 20px;
  border: 1px solid #999;
  border-radius: 8px;
  overflow: hidden;
}
.screen-toggle button {
  flex: 1;
  padding: 10px 0;
  font-size: 0.9rem;
  font-weight: 600;
  background: #f5f5f5;
  color: #333;
  border: none;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.screen-toggle button:first-child { border-right: 1px solid #999; }
.screen-toggle button.active { background: #1a1a2e; color: #fff; }

/* Mode toggle */
.mode-toggle {
  display: flex;
  gap: 0;
  margin-bottom: 20px;
  border: 1px solid #ccc;
  border-radius: 8px;
  overflow: hidden;
}
.mode-toggle button {
  flex: 1;
  padding: 10px 0;
  font-size: 0.9rem;
  font-weight: 500;
  background: #fff;
  color: #555;
  border: none;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.mode-toggle button:first-child { border-right: 1px solid #ccc; }
.mode-toggle button.active {
  background: #0066cc;
  color: #fff;
}

.scan-btn {
  display: block;
  width: 100%;
  padding: 16px;
  font-size: 1.1rem;
  font-weight: 600;
  background: #0066cc;
  color: #fff;
  border: none;
  border-radius: 10px;
  cursor: pointer;
}
.scan-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.card {
  margin-top: 24px;
  padding: 16px;
  border-radius: 10px;
}
.error   { background: #fff0f0; border: 1px solid #f99; color: #c00; }
.success { background: #f0fff4; border: 1px solid #6c6; }

h2 { font-size: 1rem; margin-top: 0; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
dt { font-weight: 600; color: #333; }
dd { margin: 0; word-break: break-all; }

details { margin-top: 16px; }
summary { cursor: pointer; font-size: 0.85rem; color: #555; }
pre { font-size: 0.75rem; overflow-x: auto; white-space: pre-wrap; }

.flush-btn {
  margin-top: 16px;
  padding: 8px 16px;
  font-size: 0.85rem;
  background: #eee;
  border: 1px solid #ccc;
  border-radius: 6px;
  cursor: pointer;
}
</style>
