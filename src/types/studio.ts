export type AspectRatioOption = "9:16" | "4:5" | "1:1";

export type KenBurnsPreset =
  | "zoom-in-center"
  | "pan-left-right"
  | "zoom-out-reveal"
  | "drift-up-focus";

export type AudioPreset =
  | "lo-fi-chill"
  | "phonk-drift"
  | "synth-pulse"
  | "custom-file"
  | "none";

export interface VisualEnhancements {
  brightness: number; // -25 to +25
  contrast: number; // -25 to +35
  saturation: number; // -20 to +35
  sharpness: number; // 0 to 50
  warmth: number; // -20 to +25
  recommendedKenBurns: KenBurnsPreset;
  focalPointX: number; // 0..1
  focalPointY: number; // 0..1
  rationale: string;
}

export interface GenZCaptionVariant {
  hook: string;
  body: string;
  cta: string;
  hashtags: string[];
  estimatedWatchTimeBoost: string;
}

export interface SrtSubtitleSegment {
  index: number;
  startTime: string; // "00:00:00,000"
  endTime: string; // "00:00:01,500"
  startSec: number;
  endSec: number;
  text: string;
}

export interface C2PAMetadataFields {
  title: string;
  description: string;
  creator: string;
  creditLine: string;
  digitalSourceType: string;
  rightsUsageTerms: string;
}

export interface MediaAnalysis {
  viralScore: number;
  retentionHookScore: number;
  shadowbanRisk: "LOW" | "MODERATE" | "HIGH";
  contentSafetyFlags: string[];
  visualEnhancements: VisualEnhancements;
  genZCaptions: GenZCaptionVariant[];
  srtSubtitles: SrtSubtitleSegment[];
  c2paMetadata: C2PAMetadataFields;
}

export interface StudioConfig {
  targetRatio: AspectRatioOption;
  niche: string;
  creatorHandle: string;
  videoDurationSec: number;
  fps: 30 | 60;
  kenBurnsIntensity: number; // 0.08 to 0.28
  burnInHookBanner: boolean;
  burnInSubtitles: boolean;
  burnInProgressBar: boolean;
  enableDynamicWatermark: boolean;
  watermarkText: string;
  watermarkOpacity: number; // 0.15 to 0.9
  audioPreset: AudioPreset;
  audioVolume: number; // 0 to 1
  stripOriginalExif: boolean;
  injectC2paXmp: boolean;
  metaIgUserId: string;
  metaPageId: string;
  scheduledPublishOffsetMin: number;
}

export interface BatchMediaItem {
  id: string;
  fileName: string;
  mimeType: string;
  sourceUrl: string;
  fileSizeBytes: number;
  width: number;
  height: number;
  status: "queued" | "analyzing" | "analyzed" | "rendering" | "completed" | "error";
  errorMessage?: string;
  selectedCaptionIndex: number;
  analysis: MediaAnalysis;
  processedImageBlob?: Blob;
  processedImageUrl?: string;
  renderedVideoBlob?: Blob;
  renderedVideoUrl?: string;
  xmpPacketXml?: string;
  sha256Digest?: string;
  binaryHeaderPreview?: string;
  metaScheduleStatus?: "unscheduled" | "ready" | "queued-container";
}
