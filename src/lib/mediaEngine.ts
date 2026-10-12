import {
  AspectRatioOption,
  BatchMediaItem,
  StudioConfig,
} from "../types/studio";
import {
  buildC2paXmpPacket,
  computeBlobSha256,
  formatBinaryHexHeader,
  injectXmpIntoJpegBlob,
} from "./metadataInjector";

export function getTargetDimensions(ratio: AspectRatioOption): {
  width: number;
  height: number;
} {
  switch (ratio) {
    case "9:16":
      return { width: 1080, height: 1920 };
    case "4:5":
      return { width: 1080, height: 1350 };
    case "1:1":
      return { width: 1080, height: 1080 };
  }
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to decode image asset: ${src}`));
    img.src = src;
  });
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines;
}

/**
 * Renders a single composite frame onto the provided 2D canvas context.
 * Used both for interactive real-time preview and 60fps MediaRecorder video encoding.
 */
export function renderCompositeFrame(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  item: BatchMediaItem,
  config: StudioConfig,
  progress01: number, // 0.0 to 1.0
  includeOverlays = true
): void {
  const { width, height } = ctx.canvas;
  const enh = item.analysis.visualEnhancements;
  const eased = easeInOutCubic(Math.max(0, Math.min(1, progress01)));
  const currentSec = progress01 * config.videoDurationSec;

  ctx.save();
  ctx.clearRect(0, 0, width, height);

  // Build CSS filter string from AI visual enhancement parameters
  const brightPct = 100 + enh.brightness;
  const contrastPct = 100 + enh.contrast + enh.sharpness * 0.25;
  const satPct = 100 + enh.saturation;
  const sepiaPct = enh.warmth > 0 ? Math.min(25, enh.warmth * 0.8) : 0;

  // 1. Ambient blurred background fill (eliminates black bars & boosts retention)
  ctx.save();
  ctx.filter = `blur(36px) brightness(${Math.max(55, brightPct - 25)}%) saturate(${satPct + 15}%)`;
  const bgScale = Math.max(width / img.width, height / img.height) * 1.15;
  const bgW = img.width * bgScale;
  const bgH = img.height * bgScale;
  ctx.drawImage(img, (width - bgW) / 2, (height - bgH) / 2, bgW, bgH);
  ctx.restore();

  // 2. Compute Ken Burns camera transform around AI focal point
  const baseCoverScale = Math.max(width / img.width, height / img.height);
  const intensity = config.kenBurnsIntensity;
  let scaleFactor = 1.0;
  let panX = 0;
  let panY = 0;

  const focusOffsetX = (0.5 - enh.focalPointX) * width * 0.22;
  const focusOffsetY = (0.5 - enh.focalPointY) * height * 0.22;

  switch (enh.recommendedKenBurns) {
    case "zoom-in-center":
      scaleFactor = 1.02 + eased * intensity;
      panX = focusOffsetX * eased;
      panY = focusOffsetY * eased;
      break;
    case "zoom-out-reveal":
      scaleFactor = 1.02 + intensity - eased * intensity;
      panX = focusOffsetX * (1 - eased);
      panY = focusOffsetY * (1 - eased);
      break;
    case "pan-left-right":
      scaleFactor = 1.06 + intensity * 0.5;
      panX = (-0.5 + eased) * width * intensity * 0.75;
      panY = focusOffsetY * 0.5;
      break;
    case "drift-up-focus":
      scaleFactor = 1.06 + eased * (intensity * 0.7);
      panX = focusOffsetX * eased;
      panY = (0.5 - eased) * height * intensity * 0.65;
      break;
  }

  ctx.save();
  ctx.filter = `brightness(${brightPct}%) contrast(${contrastPct}%) saturate(${satPct}%) sepia(${sepiaPct}%)`;
  ctx.translate(width / 2 + panX, height / 2 + panY);
  ctx.scale(baseCoverScale * scaleFactor, baseCoverScale * scaleFactor);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  ctx.restore();

  // Warmth / coolness color grade tint overlay
  if (Math.abs(enh.warmth) > 2) {
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    ctx.fillStyle =
      enh.warmth > 0
        ? `rgba(255, 168, 76, ${Math.min(0.22, enh.warmth / 110)})`
        : `rgba(86, 168, 255, ${Math.min(0.22, Math.abs(enh.warmth) / 110)})`;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  // Subtle cinematic top/bottom vignette scrim for legibility
  const vignette = ctx.createLinearGradient(0, 0, 0, height);
  vignette.addColorStop(0, "rgba(6, 10, 18, 0.45)");
  vignette.addColorStop(0.25, "rgba(6, 10, 18, 0.0)");
  vignette.addColorStop(0.68, "rgba(6, 10, 18, 0.05)");
  vignette.addColorStop(1, "rgba(6, 10, 18, 0.68)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  if (!includeOverlays) {
    ctx.restore();
    return;
  }

  // 3. Top 3-second viral hook banner (Meta Safe-Zone compliant)
  const activeCaption =
    item.analysis.genZCaptions[item.selectedCaptionIndex] ||
    item.analysis.genZCaptions[0];

  if (config.burnInHookBanner && activeCaption?.hook && currentSec <= 3.4) {
    const hookAlpha =
      currentSec < 0.25
        ? currentSec / 0.25
        : currentSec > 2.9
          ? Math.max(0, (3.4 - currentSec) / 0.5)
          : 1;

    ctx.save();
    ctx.globalAlpha = hookAlpha;
    const fontSize = Math.round(width * 0.044);
    ctx.font = `700 ${fontSize}px "Plus Jakarta Sans", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const maxBoxW = width * 0.82;
    const lines = wrapCanvasText(ctx, activeCaption.hook, maxBoxW - 64);
    const lineHeight = fontSize * 1.28;
    const boxH = lines.length * lineHeight + 44;
    const boxY = height * 0.12;
    const boxX = (width - maxBoxW) / 2;

    // Rounded high-contrast backdrop
    ctx.fillStyle = "rgba(11, 15, 23, 0.86)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, maxBoxW, boxH, 20);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#F8FAFC";
    lines.forEach((line, idx) => {
      const lineY =
        boxY + 22 + lineHeight / 2 + idx * lineHeight;
      ctx.fillText(line, width / 2, lineY);
    });
    ctx.restore();
  }

  // 4. Automated Timed SRT Subtitles Burn-in
  if (config.burnInSubtitles && item.analysis.srtSubtitles?.length) {
    const activeSeg = item.analysis.srtSubtitles.find(
      (s) => currentSec >= s.startSec && currentSec <= s.endSec
    );
    if (activeSeg) {
      ctx.save();
      const subFontSize = Math.round(width * 0.042);
      ctx.font = `700 ${subFontSize}px "Plus Jakarta Sans", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const subLines = wrapCanvasText(ctx, activeSeg.text, width * 0.8);
      const subLineH = subFontSize * 1.26;
      const baseSubY = height * 0.76;

      subLines.forEach((line, idx) => {
        const yPos =
          baseSubY + (idx - (subLines.length - 1) / 2) * subLineH;
        const textW = ctx.measureText(line).width;

        ctx.fillStyle = "rgba(9, 13, 22, 0.82)";
        ctx.beginPath();
        ctx.roundRect(
          width / 2 - textW / 2 - 22,
          yPos - subFontSize * 0.66,
          textW + 44,
          subFontSize * 1.32,
          12
        );
        ctx.fill();

        ctx.fillStyle = "#FACC15";
        ctx.fillText(line, width / 2, yPos);
      });
      ctx.restore();
    }
  }

  // 5. Custom Dynamic Anti-Rip Watermark
  if (config.enableDynamicWatermark && config.watermarkText.trim()) {
    ctx.save();
    ctx.globalAlpha = config.watermarkOpacity;
    const wmFontSize = Math.round(width * 0.026);
    ctx.font = `600 ${wmFontSize}px "JetBrains Mono", monospace`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    // Subtle sinusoidal drift prevents static bounding-box watermark removal bots
    const driftX = Math.sin(progress01 * Math.PI * 2) * 18;
    const driftY = Math.cos(progress01 * Math.PI * 2) * 12;
    const wmX = width - 48 + driftX;
    const wmY = height * 0.88 + driftY;

    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
    ctx.shadowBlur = 8;
    ctx.fillText(config.watermarkText, wmX, wmY);
    ctx.restore();
  }

  // 6. High-Retention Watch-Time Progress Bar
  if (config.burnInProgressBar) {
    ctx.save();
    const barHeight = 8;
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
    ctx.fillRect(0, height - barHeight, width, barHeight);

    ctx.fillStyle = "#3B82F6";
    ctx.fillRect(0, height - barHeight, width * progress01, barHeight);
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Generates an enhanced, aspect-ratio-reframed JPEG Blob with binary C2PA/IPTC XMP injected.
 */
export async function processEnhancedImageWithXmp(
  item: BatchMediaItem,
  config: StudioConfig
): Promise<{
  blob: Blob;
  url: string;
  xmpXml: string;
  sha256: string;
  hexPreview: string;
}> {
  const img = await loadImageElement(item.sourceUrl);
  const { width, height } = getTargetDimensions(config.targetRatio);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not initialize 2D canvas context.");
  }

  // Render enhanced frame at mid-motion focal point
  renderCompositeFrame(ctx, img, item, config, 0.35, config.enableDynamicWatermark);

  const rawJpegBlob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas JPEG encode failed"))),
      "image/jpeg",
      0.94
    );
  });

  const initialHash = await computeBlobSha256(rawJpegBlob);
  const xmpXml = buildC2paXmpPacket(
    item.analysis.c2paMetadata,
    initialHash,
    config.targetRatio
  );

  const finalBlob = config.injectC2paXmp
    ? await injectXmpIntoJpegBlob(rawJpegBlob, xmpXml, config.stripOriginalExif)
    : rawJpegBlob;

  const finalSha256 = await computeBlobSha256(finalBlob);
  const hexPreview = await formatBinaryHexHeader(finalBlob, 96);
  const url = URL.createObjectURL(finalBlob);

  return {
    blob: finalBlob,
    url,
    xmpXml,
    sha256: finalSha256,
    hexPreview,
  };
}

/**
 * Synthesizes a procedural copyright-safe background beat or mixes a user-uploaded audio file
 * into a Web Audio MediaStreamDestination for MediaRecorder video capture.
 */
async function createMixedAudioStream(
  config: StudioConfig,
  customAudioBuffer: ArrayBuffer | null
): Promise<{
  stream: MediaStream | null;
  cleanup: () => void;
}> {
  if (config.audioPreset === "none" || config.audioVolume <= 0.01) {
    return { stream: null, cleanup: () => {} };
  }

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtx();
  const dest = audioCtx.createMediaStreamDestination();
  const masterGain = audioCtx.createGain();
  masterGain.gain.value = config.audioVolume;
  masterGain.connect(dest);

  let intervalId: number | null = null;
  let sourceNode: AudioBufferSourceNode | null = null;

  if (config.audioPreset === "custom-file" && customAudioBuffer) {
    try {
      const decoded = await audioCtx.decodeAudioData(customAudioBuffer.slice(0));
      sourceNode = audioCtx.createBufferSource();
      sourceNode.buffer = decoded;
      sourceNode.loop = true;
      sourceNode.connect(masterGain);
      sourceNode.start(0);
    } catch {
      // Fallback to procedural pulse if custom audio decode fails
    }
  }

  if (!sourceNode) {
    // Procedural beat generator using Web Audio oscillators
    const bpm =
      config.audioPreset === "phonk-drift"
        ? 136
        : config.audioPreset === "synth-pulse"
          ? 118
          : 88;
    const stepMs = (60 / bpm / 2) * 1000;
    let step = 0;

    const triggerStep = () => {
      if (audioCtx.state === "closed") return;
      const now = audioCtx.currentTime;

      // Sub kick on beats 0, 3, 4
      if (step % 8 === 0 || step % 8 === 3 || step % 8 === 4) {
        const osc = audioCtx.createOscillator();
        const kickGain = audioCtx.createGain();
        osc.type = "sine";
        const baseFreq = config.audioPreset === "phonk-drift" ? 130 : 95;
        osc.frequency.setValueAtTime(baseFreq, now);
        osc.frequency.exponentialRampToValueAtTime(36, now + 0.16);
        kickGain.gain.setValueAtTime(0.65, now);
        kickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.connect(kickGain);
        kickGain.connect(masterGain);
        osc.start(now);
        osc.stop(now + 0.24);
      }

      // Chord / cowbell / synth pluck
      const notes =
        config.audioPreset === "phonk-drift"
          ? [293.66, 349.23, 440.0, 587.33]
          : config.audioPreset === "synth-pulse"
            ? [261.63, 329.63, 392.0, 523.25]
            : [220.0, 261.63, 329.63, 392.0];

      const osc2 = audioCtx.createOscillator();
      const pluckGain = audioCtx.createGain();
      osc2.type = config.audioPreset === "phonk-drift" ? "sawtooth" : "triangle";
      osc2.frequency.setValueAtTime(notes[step % notes.length], now);
      pluckGain.gain.setValueAtTime(0.18, now);
      pluckGain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc2.connect(pluckGain);
      pluckGain.connect(masterGain);
      osc2.start(now);
      osc2.stop(now + 0.3);

      step++;
    };

    triggerStep();
    intervalId = window.setInterval(triggerStep, stepMs);
  }

  return {
    stream: dest.stream,
    cleanup: () => {
      if (intervalId !== null) window.clearInterval(intervalId);
      try {
        sourceNode?.stop();
      } catch {
        // ignore
      }
      if (audioCtx.state !== "closed") {
        audioCtx.close().catch(() => {});
      }
    },
  };
}

/**
 * Renders a high-retention Ken Burns motion video with burned-in hooks, SRT subtitles,
 * dynamic anti-rip watermark, and mixed Web Audio background music using MediaRecorder.
 */
export async function renderKenBurnsVideoBlob(
  item: BatchMediaItem,
  config: StudioConfig,
  customAudioBuffer: ArrayBuffer | null,
  onProgress?: (pct: number) => void
): Promise<{ blob: Blob; url: string }> {
  const img = await loadImageElement(item.sourceUrl);
  const { width, height } = getTargetDimensions(config.targetRatio);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not initialize 2D canvas context for video rendering.");
  }

  const canvasStream = canvas.captureStream(config.fps);
  const audioSetup = await createMixedAudioStream(config, customAudioBuffer);

  const combinedTracks = [
    ...canvasStream.getVideoTracks(),
    ...(audioSetup.stream ? audioSetup.stream.getAudioTracks() : []),
  ];
  const combinedStream = new MediaStream(combinedTracks);

  const mimeCandidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  const selectedMime =
    mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";

  const recorder = new MediaRecorder(
    combinedStream,
    selectedMime
      ? { mimeType: selectedMime, videoBitsPerSecond: 8_500_000 }
      : { videoBitsPerSecond: 8_500_000 }
  );

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) {
      chunks.push(ev.data);
    }
  };

  return new Promise((resolve, reject) => {
    recorder.onerror = () => {
      audioSetup.cleanup();
      reject(new Error("MediaRecorder encountered an encoding error."));
    };

    recorder.onstop = () => {
      audioSetup.cleanup();
      const finalBlob = new Blob(chunks, {
        type: selectedMime || "video/webm",
      });
      const url = URL.createObjectURL(finalBlob);
      resolve({ blob: finalBlob, url });
    };

    recorder.start(100);

    const durationMs = config.videoDurationSec * 1000;
    const startTime = performance.now();

    const stepFrame = (now: number) => {
      const elapsed = now - startTime;
      const progress01 = Math.min(1, elapsed / durationMs);

      renderCompositeFrame(ctx, img, item, config, progress01, true);
      onProgress?.(Math.round(progress01 * 100));

      if (elapsed < durationMs) {
        requestAnimationFrame(stepFrame);
      } else {
        recorder.stop();
      }
    };

    requestAnimationFrame(stepFrame);
  });
}
