<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { Pdf417 } from "@parselo/capacitor-pdf417";

const emit = defineEmits<{
  decoded: [raw: string];
  cancelled: [];
}>();

const videoRef = ref<HTMLVideoElement | null>(null);
const hint = ref("Position the barcode in the frame");

let stream: MediaStream | null = null;
let timerId: ReturnType<typeof setInterval> | null = null;
let decoding = false;
let alive = true;

const SAMPLE_MS  = 500;
const BLUR_MIN   = 60;   // Laplacian variance; raise if triggering on blurry frames
const SMALL_W    = 320;  // down-sample width for the blur check

// Reused offscreen canvases to avoid allocation on every frame
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
  if (!alive || decoding) return;
  const video = videoRef.value;
  if (!video || video.readyState < 2) return;

  const vw = video.videoWidth;
  const vh = video.videoHeight;

  // 1. Blur check on a small copy (fast — ~320×180 pixels)
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

  // 2. Decode attempt on the full-resolution frame
  hint.value = "Reading barcode…";
  decoding = true;
  fullCanvas.width  = vw;
  fullCanvas.height = vh;
  fullCanvas.getContext("2d")!.drawImage(video, 0, 0);
  const dataUrl = fullCanvas.toDataURL("image/jpeg", 0.92);

  try {
    const { raw } = await Pdf417.decodePdf417({ image: dataUrl });
    if (raw && alive) {
      alive = false;
      emit("decoded", raw);
      return;
    }
    hint.value = "Position the barcode in the frame";
  } catch {
    hint.value = "Position the barcode in the frame";
  } finally {
    decoding = false;
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
      <div class="finder">
        <span class="corner tl" />
        <span class="corner tr" />
        <span class="corner bl" />
        <span class="corner br" />
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
/* PDF417 is wide — 3:1 matches a typical licence barcode */
.finder {
  position: relative;
  width: 85%;
  aspect-ratio: 3 / 1;
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
