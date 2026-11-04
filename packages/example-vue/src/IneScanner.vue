<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { Mrz } from "@parselo/capacitor-mrz";
import { parseIneMrz } from "@parselo/scanner-core";

const emit = defineEmits<{
  recognized: [lines: string[]];
  cancelled: [];
}>();

const videoRef = ref<HTMLVideoElement | null>(null);
const hint = ref("Point the camera at the back of the INE card");

let stream: MediaStream | null = null;
let timerId: ReturnType<typeof setInterval> | null = null;
let recognizing = false;
let alive = true;

const SAMPLE_MS = 800;   // slightly slower than barcode — text recognition is heavier
const BLUR_MIN  = 60;
const SMALL_W   = 320;

const smallCanvas = document.createElement("canvas");
const fullCanvas  = document.createElement("canvas");

function laplacianVariance(data: Uint8ClampedArray, w: number, h: number): number {
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const ci = (y * w + x) * 4;
      const ti = ((y - 1) * w + x) * 4;
      const bi = ((y + 1) * w + x) * 4;
      const li = (y * w + x - 1) * 4;
      const ri = (y * w + x + 1) * 4;
      const c = 0.299 * data[ci]     + 0.587 * data[ci + 1]     + 0.114 * data[ci + 2];
      const t = 0.299 * data[ti]     + 0.587 * data[ti + 1]     + 0.114 * data[ti + 2];
      const b = 0.299 * data[bi]     + 0.587 * data[bi + 1]     + 0.114 * data[bi + 2];
      const l = 0.299 * data[li]     + 0.587 * data[li + 1]     + 0.114 * data[li + 2];
      const r = 0.299 * data[ri]     + 0.587 * data[ri + 1]     + 0.114 * data[ri + 2];
      const lap = t + b + l + r - 4 * c;
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

async function sampleFrame() {
  if (!alive || recognizing) return;
  const video = videoRef.value;
  if (!video || video.readyState < 2) return;

  const vw = video.videoWidth;
  const vh = video.videoHeight;

  // 1. Blur check
  const sh = Math.round(SMALL_W * (vh / vw));
  smallCanvas.width  = SMALL_W;
  smallCanvas.height = sh;
  const sCtx = smallCanvas.getContext("2d", { willReadFrequently: true })!;
  sCtx.drawImage(video, 0, 0, SMALL_W, sh);
  const score = laplacianVariance(sCtx.getImageData(0, 0, SMALL_W, sh).data, SMALL_W, sh);
  if (score < BLUR_MIN) {
    hint.value = "Hold still…";
    return;
  }

  // 2. Full-res capture → text recognition
  hint.value = "Reading INE card…";
  recognizing = true;
  fullCanvas.width  = vw;
  fullCanvas.height = vh;
  fullCanvas.getContext("2d")!.drawImage(video, 0, 0);
  const dataUrl = fullCanvas.toDataURL("image/jpeg", 0.92);

  try {
    const { lines } = await Mrz.recognizeText({ image: dataUrl });
    console.log("[IneScanner] recognizeText returned", lines.length, "line(s):", lines);

    // Pre-validate: only close the camera when scanner-core finds a valid TD1
    // (INE) MRZ. Threshold is isIne only (not confidence) so real cards with
    // minor OCR check-digit errors still pass; the downstream parseIneMrz call
    // in scanIne() will record the confidence/failures in the result.
    if (lines.length >= 1) {
      const ine = parseIneMrz(lines);
      console.log("[IneScanner] parseIneMrz →", { isIne: ine.isIne, confidence: ine.confidence, failures: ine.checksumFailures });
      if (ine.isIne && alive) {
        console.log("[IneScanner] valid INE MRZ found — emitting recognized");
        alive = false;
        emit("recognized", lines);
        return;
      }
    } else {
      console.log("[IneScanner] plugin returned 0 lines — no text recognized");
    }
    hint.value = "Point the camera at the back of the INE card";
  } catch (err: unknown) {
    console.error("[IneScanner] recognizeText threw:", err instanceof Error ? err.message : String(err));
    hint.value = "Point the camera at the back of the INE card";
  } finally {
    recognizing = false;
  }
}

onMounted(async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    const video = videoRef.value!;
    video.srcObject = stream;
    await video.play();
    timerId = setInterval(sampleFrame, SAMPLE_MS);
  } catch {
    emit("cancelled");
  }
});

onUnmounted(() => {
  alive = false;
  if (timerId !== null) clearInterval(timerId);
  stream?.getTracks().forEach((t) => t.stop());
});
</script>

<template>
  <div class="wrap">
    <video ref="videoRef" class="feed" autoplay playsinline muted />

    <div class="overlay">
      <!-- INE card is roughly 8.5:5.5 landscape (credit-card format) -->
      <div class="finder">
        <span class="corner tl" />
        <span class="corner tr" />
        <span class="corner bl" />
        <span class="corner br" />
        <!-- TD1 MRZ zone marker at the bottom of the finder -->
        <div class="mrz-zone">
          <span class="mrz-label">MRZ</span>
        </div>
      </div>
      <p class="hint">{{ hint }}</p>
    </div>

    <button class="cancel" @click="$emit('cancelled')">Cancel</button>
  </div>
</template>

<style scoped>
.wrap {
  position: fixed;
  inset: 0;
  background: #000;
  overflow: hidden;
}
.feed {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
}
/* ID-1 card format (INE): roughly 8.5:5.5 */
.finder {
  position: relative;
  width: 88%;
  aspect-ratio: 8.5 / 5.5;
}
.corner {
  position: absolute;
  width: 28px;
  height: 28px;
  border-color: #fff;
  border-style: solid;
}
.tl { top: 0;    left: 0;   border-width: 3px 0 0 3px; }
.tr { top: 0;    right: 0;  border-width: 3px 3px 0 0; }
.bl { bottom: 0; left: 0;   border-width: 0 0 3px 3px; }
.br { bottom: 0; right: 0;  border-width: 0 3px 3px 0; }

/* Stripe at the bottom of the finder indicating the MRZ area */
.mrz-zone {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 20%;
  border-top: 1px dashed rgba(255, 255, 255, 0.5);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 6px;
}
.mrz-label {
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.6);
  letter-spacing: 0.12em;
  font-family: monospace;
}

.hint {
  color: #fff;
  font-size: 0.88rem;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.85);
  margin: 0;
  text-align: center;
  padding: 0 32px;
}
.cancel {
  position: absolute;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 40px;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 24px;
  font-size: 0.9rem;
  cursor: pointer;
  white-space: nowrap;
}
</style>
