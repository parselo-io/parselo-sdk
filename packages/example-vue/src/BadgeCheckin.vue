<!--
  Task 03 — Badge Check-in device test screen.

  A debugging/tuning tool, not production UI (see task brief §3): it exists to run real
  match/non-match/poor-capture trials against the deployed dev POST /verify-checkin and surface
  every raw per-leg score, so T_profile / T_profile_floor / T_badgeleg can be set from real
  evidence instead of placeholders.

  Talks to a local dev proxy (packages/badge-checkin-dev-proxy), never to Cognito or
  /verify-checkin directly — this app must never hold the M2M client secret (brief §2).

  Privacy: both images are captured with CameraResultType.Base64 (kept in JS memory only, never
  written to device storage — CameraResultType.Uri would create a temp file and is deliberately
  not used here) and are never written to Preferences/localStorage or logged. Only the proxy URL,
  repId, and mode are persisted, for convenience across app relaunches.
-->
<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { Camera, CameraResultType, CameraSource, CameraDirection, type Photo } from "@capacitor/camera";
import { Preferences } from "@capacitor/preferences";

type Mode = "2-leg" | "3-leg";
type CaptureMethod = "two-photos" | "single-photo";

const PREF_PROXY_URL     = "badgeCheckin.proxyUrl";
const PREF_REP_ID        = "badgeCheckin.repId";
const PREF_MODE          = "badgeCheckin.mode";
const PREF_CAPTURE_METHOD = "badgeCheckin.captureMethod";

const proxyUrl       = ref(import.meta.env.VITE_BADGE_CHECKIN_PROXY_URL ?? "");
const repId          = ref("dd3d33");
const mode           = ref<Mode>("3-leg");
// single-photo always runs the full 3-leg-equivalent check server-side regardless of `mode`
// (see verify-checkin.ts) — the mode toggle only applies to two-photos capture.
const captureMethod  = ref<CaptureMethod>("single-photo");

interface CapturedImage { base64: string; format: string; }
const selfie   = ref<CapturedImage | null>(null);
const badge    = ref<CapturedImage | null>(null);
// single-photo capture: one combined shot (rep's own face + their badge held up next to it).
const combined = ref<CapturedImage | null>(null);

// Mirrors control-plane's VerifyCheckinResponse (lambda/_verify-checkin-types.ts) — duplicated
// here rather than imported since this is a standalone dev harness, not a build-time dependency
// on the control-plane package.
interface FaceLegResult { score: number; threshold: number; passed: boolean; evaluated: boolean; }
interface VerifyCheckinResult {
  decision: "yes" | "no" | "review";
  mode: string;
  confidence: number;
  faceMatch: Record<string, FaceLegResult>;
  badge: { valid: boolean; confidence: number; checks: Record<string, boolean> };
  reasons: string[];
  requestId: string;
  processedRegion?: string;
}

const selfiePreview = computed(() => selfie.value ? `data:image/${selfie.value.format};base64,${selfie.value.base64}` : null);
const badgePreview  = computed(() => badge.value  ? `data:image/${badge.value.format};base64,${badge.value.base64}`   : null);

const capturing = ref<"selfie" | "badge-camera" | "badge-library" | "combined" | "combined-library" | null>(null);
const sending   = ref(false);
const result    = ref<VerifyCheckinResult | null>(null);
const sendError = ref("");

const canSend = computed(() => {
  if (!proxyUrl.value || !repId.value || sending.value) return false;
  return captureMethod.value === "single-photo" ? !!combined.value : (!!selfie.value && !!badge.value);
});

onMounted(async () => {
  try {
    const [savedUrl, savedRepId, savedMode, savedCaptureMethod] = await Promise.all([
      Preferences.get({ key: PREF_PROXY_URL }),
      Preferences.get({ key: PREF_REP_ID }),
      Preferences.get({ key: PREF_MODE }),
      Preferences.get({ key: PREF_CAPTURE_METHOD }),
    ]);
    if (savedUrl.value) proxyUrl.value = savedUrl.value;
    if (savedRepId.value) repId.value = savedRepId.value;
    if (savedMode.value === "2-leg" || savedMode.value === "3-leg") mode.value = savedMode.value;
    if (savedCaptureMethod.value === "two-photos" || savedCaptureMethod.value === "single-photo") {
      captureMethod.value = savedCaptureMethod.value;
    }
  } catch { /* web preview or first launch */ }
});

watch(proxyUrl,      (v) => { void Preferences.set({ key: PREF_PROXY_URL, value: v }); });
watch(repId,         (v) => { void Preferences.set({ key: PREF_REP_ID, value: v }); });
watch(mode,          (v) => { void Preferences.set({ key: PREF_MODE, value: v }); });
watch(captureMethod, (v) => { void Preferences.set({ key: PREF_CAPTURE_METHOD, value: v }); });

function toCaptured(photo: Photo): CapturedImage | null {
  if (!photo.base64String) return null;
  return { base64: photo.base64String, format: photo.format || "jpeg" };
}

async function captureSelfie() {
  capturing.value = "selfie";
  try {
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.Base64,
      source: CameraSource.Camera,
      direction: CameraDirection.Front,
      quality: 90,
      saveToGallery: false,
      correctOrientation: true,
    });
    selfie.value = toCaptured(photo);
  } catch (e) {
    if (!isUserCancelled(e)) sendError.value = describeError(e);
  } finally {
    capturing.value = null;
  }
}

async function captureBadgeFromCamera() {
  capturing.value = "badge-camera";
  try {
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.Base64,
      source: CameraSource.Camera,
      direction: CameraDirection.Rear,
      quality: 90,
      saveToGallery: false,
      correctOrientation: true,
    });
    badge.value = toCaptured(photo);
  } catch (e) {
    if (!isUserCancelled(e)) sendError.value = describeError(e);
  } finally {
    capturing.value = null;
  }
}

// Single-photo capture: one shot of the rep's own face with their badge held up next to it —
// front camera, same as captureSelfie, since the rep needs to see themselves to frame it.
async function captureCombined() {
  capturing.value = "combined";
  try {
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.Base64,
      source: CameraSource.Camera,
      direction: CameraDirection.Front,
      quality: 90,
      saveToGallery: false,
      correctOrientation: true,
    });
    combined.value = toCaptured(photo);
  } catch (e) {
    if (!isUserCancelled(e)) sendError.value = describeError(e);
  } finally {
    capturing.value = null;
  }
}

// Reload a previously-saved combined shot from the photo library — handy for re-running the
// exact same capture against threshold/masking changes without re-taking it each time.
async function loadCombinedFromLibrary() {
  capturing.value = "combined-library";
  try {
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.Base64,
      source: CameraSource.Photos,
      correctOrientation: true,
    });
    combined.value = toCaptured(photo);
  } catch (e) {
    if (!isUserCancelled(e)) sendError.value = describeError(e);
  } finally {
    capturing.value = null;
  }
}

async function loadBadgeFromLibrary() {
  capturing.value = "badge-library";
  try {
    // For a digital badge image saved to the tester's photo library (brief §3) — a gitignored
    // dev asset, never anything committed to the repo.
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.Base64,
      source: CameraSource.Photos,
      correctOrientation: true,
    });
    badge.value = toCaptured(photo);
  } catch (e) {
    if (!isUserCancelled(e)) sendError.value = describeError(e);
  } finally {
    capturing.value = null;
  }
}

function isUserCancelled(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /cancel/i.test(msg);
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function clearImages() {
  selfie.value   = null;
  badge.value    = null;
  combined.value = null;
  result.value = null;
  sendError.value = "";
}

async function send() {
  if (!canSend.value) return;
  sending.value   = true;
  sendError.value = "";
  result.value    = null;
  try {
    const base = proxyUrl.value.replace(/\/$/, "");
    const body = captureMethod.value === "single-photo"
      ? { repId: repId.value, singlePhoto: true, selfie: combined.value!.base64 }
      : { repId: repId.value, mode: mode.value, selfie: selfie.value!.base64, badge: badge.value!.base64 };
    const res = await fetch(`${base}/verify-checkin`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      sendError.value = `HTTP ${res.status}: ${JSON.stringify(json)}`;
    } else {
      result.value = json;
    }
  } catch (e) {
    sendError.value = describeError(e);
  } finally {
    sending.value = false;
  }
}

const legRows = computed(() => {
  const fm = result.value?.faceMatch;
  if (!fm) return [];
  return Object.entries(fm).map(([leg, v]) => ({ leg, ...v }));
});
</script>

<template>
  <div class="badge-checkin">
    <p class="privacy-note">
      Selfie and badge images stay in memory only — never saved to this device, never logged.
      Only proxy URL / repId / mode are remembered between launches.
    </p>

    <!-- Config -->
    <div class="config">
      <label>
        Dev proxy URL
        <input v-model="proxyUrl" type="url" placeholder="http://192.168.1.23:8787" autocapitalize="off" />
      </label>
      <label>
        repId
        <input v-model="repId" type="text" placeholder="dd3d33" autocapitalize="off" />
      </label>
      <label>
        Capture method
        <div class="mode-toggle">
          <button :class="{ active: captureMethod === 'single-photo' }" @click="captureMethod = 'single-photo'">Single photo</button>
          <button :class="{ active: captureMethod === 'two-photos' }" @click="captureMethod = 'two-photos'">Two photos</button>
        </div>
      </label>
      <div v-if="captureMethod === 'two-photos'" class="mode-toggle">
        <button :class="{ active: mode === '2-leg' }" @click="mode = '2-leg'">2-leg</button>
        <button :class="{ active: mode === '3-leg' }" @click="mode = '3-leg'">3-leg</button>
      </div>
      <p v-else class="capture-hint">Single-photo capture always runs the full 3-leg check server-side.</p>
    </div>

    <!-- Captures -->
    <div v-if="captureMethod === 'single-photo'" class="captures">
      <div class="capture-slot">
        <h3>Selfie + badge (front camera)</h3>
        <p class="capture-hint">
          Hold your badge up next to your face, at roughly the same distance from the camera as
          your face (not closer) — make sure your whole badge, including its printed photo, is
          clearly visible. Before tapping the shutter, <strong>tap on the badge's photo on
          screen</strong> to focus there, and hold still for a moment — the camera tends to
          focus on your face by default, leaving the badge soft.
        </p>
        <img v-if="combined" :src="`data:image/${combined.format};base64,${combined.base64}`" class="preview" />
        <div v-else class="preview placeholder">No photo yet</div>
        <div class="badge-btn-row">
          <button class="capture-btn" :disabled="capturing !== null" @click="captureCombined">
            {{ capturing === 'combined' ? 'Opening camera…' : (combined ? 'Retake photo' : 'Capture photo') }}
          </button>
          <button class="capture-btn secondary" :disabled="capturing !== null" @click="loadCombinedFromLibrary">
            {{ capturing === 'combined-library' ? 'Opening library…' : 'Load from library' }}
          </button>
        </div>
      </div>
    </div>

    <div v-else class="captures">
      <div class="capture-slot">
        <h3>Selfie (front camera)</h3>
        <img v-if="selfiePreview" :src="selfiePreview" class="preview" />
        <div v-else class="preview placeholder">No selfie yet</div>
        <button class="capture-btn" :disabled="capturing !== null" @click="captureSelfie">
          {{ capturing === 'selfie' ? 'Opening camera…' : (selfie ? 'Retake selfie' : 'Capture selfie') }}
        </button>
      </div>

      <div class="capture-slot">
        <h3>Badge</h3>
        <img v-if="badgePreview" :src="badgePreview" class="preview" />
        <div v-else class="preview placeholder">No badge yet</div>
        <div class="badge-btn-row">
          <button class="capture-btn" :disabled="capturing !== null" @click="captureBadgeFromCamera">
            {{ capturing === 'badge-camera' ? 'Opening camera…' : 'Capture badge' }}
          </button>
          <button class="capture-btn secondary" :disabled="capturing !== null" @click="loadBadgeFromLibrary">
            {{ capturing === 'badge-library' ? 'Opening library…' : 'Load from library' }}
          </button>
        </div>
      </div>
    </div>

    <div class="action-row">
      <button class="send-btn" :disabled="!canSend" @click="send">
        {{ sending ? 'Sending…' : 'Send to /verify-checkin' }}
      </button>
      <button class="clear-btn" @click="clearImages">Clear</button>
    </div>

    <div v-if="sendError" class="card error">
      <strong>Error:</strong> {{ sendError }}
    </div>

    <div v-if="result" class="card success">
      <h2>Result</h2>
      <dl>
        <dt>Decision</dt><dd class="decision" :class="result.decision">{{ result.decision }}</dd>
        <dt>Mode</dt><dd>{{ result.mode }}</dd>
        <dt>Confidence</dt><dd>{{ typeof result.confidence === 'number' ? result.confidence.toFixed(2) : result.confidence }}</dd>
        <dt>Request ID</dt><dd class="mono">{{ result.requestId }}</dd>
      </dl>

      <template v-if="result.reasons?.length">
        <h3>Reasons</h3>
        <ul class="reasons-list">
          <li v-for="r in result.reasons" :key="r">{{ r }}</li>
        </ul>
      </template>

      <h3>Face legs</h3>
      <table class="leg-table">
        <thead>
          <tr><th>Leg</th><th>Score</th><th>Threshold</th><th>Passed</th><th>Evaluated</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in legRows" :key="row.leg">
            <td>{{ row.leg }}</td>
            <td>{{ row.evaluated ? row.score.toFixed(2) : '—' }}</td>
            <td>{{ row.threshold }}</td>
            <td>{{ row.evaluated ? (row.passed ? '✓' : '✗') : '—' }}</td>
            <td>{{ row.evaluated ? 'yes' : 'no' }}</td>
          </tr>
        </tbody>
      </table>

      <details open>
        <summary>Full JSON (debug)</summary>
        <pre>{{ JSON.stringify(result, null, 2) }}</pre>
      </details>
    </div>
  </div>
</template>

<style scoped>
.badge-checkin { font-family: system-ui, sans-serif; }

.privacy-note {
  font-size: 0.78rem;
  color: #666;
  background: #f5f5f5;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 16px;
}

.config { display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px; }
.config label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; font-weight: 600; color: #333; }
.config input {
  padding: 10px;
  font-size: 0.95rem;
  border: 1px solid #ccc;
  border-radius: 8px;
}

.mode-toggle { display: flex; border: 1px solid #ccc; border-radius: 8px; overflow: hidden; width: fit-content; }
.mode-toggle button {
  padding: 8px 20px;
  font-size: 0.9rem;
  font-weight: 500;
  background: #fff;
  color: #555;
  border: none;
  cursor: pointer;
}
.mode-toggle button:first-child { border-right: 1px solid #ccc; }
.mode-toggle button.active { background: #0066cc; color: #fff; }

.captures { display: flex; flex-direction: column; gap: 16px; margin-bottom: 16px; }
.capture-slot h3 { font-size: 0.85rem; margin: 0 0 8px; color: #333; }
.capture-hint { font-size: 0.78rem; color: #666; margin: 0 0 8px; }
.preview {
  width: 100%;
  max-height: 220px;
  object-fit: contain;
  background: #eee;
  border-radius: 8px;
  margin-bottom: 8px;
}
.preview.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 120px;
  color: #999;
  font-size: 0.85rem;
}

.badge-btn-row { display: flex; gap: 8px; }
.capture-btn {
  flex: 1;
  padding: 12px;
  font-size: 0.9rem;
  font-weight: 600;
  background: #0066cc;
  color: #fff;
  border: none;
  border-radius: 8px;
  cursor: pointer;
}
.capture-btn.secondary { background: #eee; color: #333; }
.capture-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.action-row { display: flex; gap: 8px; margin-bottom: 16px; }
.send-btn {
  flex: 1;
  padding: 14px;
  font-size: 1rem;
  font-weight: 600;
  background: #0a8f3c;
  color: #fff;
  border: none;
  border-radius: 10px;
  cursor: pointer;
}
.send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.clear-btn {
  padding: 14px 18px;
  font-size: 0.9rem;
  background: #eee;
  color: #333;
  border: none;
  border-radius: 10px;
  cursor: pointer;
}

.card { margin-top: 16px; padding: 16px; border-radius: 10px; }
.error   { background: #fff0f0; border: 1px solid #f99; color: #c00; }
.success { background: #f0fff4; border: 1px solid #6c6; }

h2 { font-size: 1rem; margin: 0 0 12px; }
h3 { font-size: 0.85rem; margin: 16px 0 8px; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
dt { font-weight: 600; color: #333; }
dd { margin: 0; word-break: break-all; }
.mono { font-family: monospace; font-size: 0.8rem; }
.decision { font-weight: 700; text-transform: uppercase; }
.decision.yes { color: #0a8f3c; }
.decision.no { color: #c00; }
.decision.review { color: #b8860b; }

.leg-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
.leg-table th, .leg-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; }

.reasons-list { margin: 0 0 12px; padding-left: 20px; font-size: 0.82rem; color: #555; }
.reasons-list li { margin-bottom: 2px; }

details { margin-top: 16px; }
summary { cursor: pointer; font-size: 0.85rem; color: #555; }
pre { font-size: 0.72rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
</style>
