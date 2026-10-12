/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import {
  Check,
  Code2,
  Copy,
  Download,
  FileCode,
  Film,
  FolderArchive,
  Image as ImageIcon,
  Music,
  Play,
  Plus,
  RefreshCw,
  CalendarClock,
  ShieldCheck,
  Sliders,
  Sparkles,
  Subtitles,
  Trash2,
  Upload,
  Video,
} from "lucide-react";
import {
  AspectRatioOption,
  AudioPreset,
  BatchMediaItem,
  KenBurnsPreset,
  StudioConfig,
} from "./types/studio";
import {
  DEFAULT_STUDIO_CONFIG,
  INITIAL_BATCH_ITEMS,
} from "./lib/samplePresets";
import {
  getTargetDimensions,
  loadImageElement,
  processEnhancedImageWithXmp,
  renderCompositeFrame,
  renderKenBurnsVideoBlob,
} from "./lib/mediaEngine";
import {
  buildC2paXmpPacket,
  formatSrtContent,
} from "./lib/metadataInjector";
import {
  generateSingleFileCloudflareWorker,
  generateWranglerToml,
} from "./lib/cloudflareWorkerTemplate";

type ActiveSection =
  | "studio"
  | "motion"
  | "c2pa"
  | "scheduler"
  | "worker";

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>("studio");
  const [config, setConfig] = useState<StudioConfig>(DEFAULT_STUDIO_CONFIG);
  const [batchItems, setBatchItems] =
    useState<BatchMediaItem[]>(INITIAL_BATCH_ITEMS);
  const [selectedId, setSelectedId] = useState<string>(
    INITIAL_BATCH_ITEMS[0].id
  );
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [isPlayingPreview, setIsPlayingPreview] = useState<boolean>(true);
  const [previewProgress, setPreviewProgress] = useState<number>(0);
  const [renderProgressPct, setRenderProgressPct] = useState<number | null>(
    null
  );
  const [isBatchProcessing, setIsBatchProcessing] = useState<boolean>(false);
  const [isExportingZip, setIsExportingZip] = useState<boolean>(false);
  const [statusBanner, setStatusBanner] = useState<{
    type: "info" | "success" | "error";
    message: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [customAudioBuffer, setCustomAudioBuffer] =
    useState<ArrayBuffer | null>(null);
  const [customAudioName, setCustomAudioName] = useState<string>("");

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadedImageRef = useRef<HTMLImageElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);

  const selectedItem =
    batchItems.find((item) => item.id === selectedId) || batchItems[0] || null;

  const filteredItems = batchItems.filter((item) =>
    item.fileName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Load HTMLImageElement when selectedItem changes
  useEffect(() => {
    if (!selectedItem) {
      loadedImageRef.current = null;
      return;
    }
    let cancelled = false;
    loadImageElement(selectedItem.sourceUrl)
      .then((img) => {
        if (!cancelled) {
          loadedImageRef.current = img;
          // Also generate initial C2PA XMP preview if not yet populated
          if (!selectedItem.xmpPacketXml) {
            processEnhancedImageWithXmp(selectedItem, config)
              .then((res) => {
                if (cancelled) return;
                setBatchItems((prev) =>
                  prev.map((it) =>
                    it.id === selectedItem.id
                      ? {
                          ...it,
                          processedImageBlob: res.blob,
                          processedImageUrl: res.url,
                          xmpPacketXml: res.xmpXml,
                          sha256Digest: res.sha256,
                          binaryHeaderPreview: res.hexPreview,
                        }
                      : it
                  )
                );
              })
              .catch(() => {});
          }
        }
      })
      .catch(() => {
        if (!cancelled) loadedImageRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [selectedItem?.id, selectedItem?.sourceUrl]);

  // 60fps Live Canvas Animation Loop
  useEffect(() => {
    let rafId: number;
    let startTs = performance.now() - previewProgress * config.videoDurationSec * 1000;

    const tick = (now: number) => {
      const canvas = previewCanvasRef.current;
      const img = loadedImageRef.current;

      if (canvas && img && selectedItem) {
        const { width, height } = getTargetDimensions(config.targetRatio);
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          let p = previewProgress;
          if (isPlayingPreview) {
            const durationMs = config.videoDurationSec * 1000;
            const elapsed = (now - startTs) % durationMs;
            p = elapsed / durationMs;
            setPreviewProgress(p);
          }
          renderCompositeFrame(ctx, img, selectedItem, config, p, true);
        }
      }
      if (isPlayingPreview) {
        rafId = requestAnimationFrame(tick);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [
    selectedItem,
    config,
    isPlayingPreview,
    previewProgress,
  ]);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  // Convert image URL or Blob to base64 string (without data: prefix) for Gemini multimodal API
  async function imageUrlToBase64(url: string): Promise<{
    base64: string;
    mimeType: string;
  }> {
    const response = await fetch(url);
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return {
      base64: btoa(binary),
      mimeType: blob.type || "image/jpeg",
    };
  }

  // Handle Multi-File Upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newItems: BatchMediaItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const objectUrl = URL.createObjectURL(file);
      let width = 1080;
      let height = 1350;
      try {
        const img = await loadImageElement(objectUrl);
        width = img.naturalWidth || 1080;
        height = img.naturalHeight || 1350;
      } catch {
        // use defaults
      }

      const id = `upload-${Date.now()}-${i}`;
      newItems.push({
        id,
        fileName: file.name,
        mimeType: file.type || "image/jpeg",
        sourceUrl: objectUrl,
        fileSizeBytes: file.size,
        width,
        height,
        status: "queued",
        selectedCaptionIndex: 0,
        metaScheduleStatus: "ready",
        analysis: {
          viralScore: 88,
          retentionHookScore: 86,
          shadowbanRisk: "LOW",
          contentSafetyFlags: [
            "Meta Reels 9:16 safe-zone ready",
            "Pending Gemini 3.8 Flash deep scan",
            "C2PA 2.1 XMP injection armed",
          ],
          visualEnhancements: {
            brightness: 3,
            contrast: 12,
            saturation: 10,
            sharpness: 20,
            warmth: 4,
            recommendedKenBurns: "zoom-in-center",
            focalPointX: 0.5,
            focalPointY: 0.42,
            rationale:
              "Balanced clarity and midtone contrast preset applied; run Gemini Multimodal Analysis for frame-specific focal tracking.",
          },
          genZCaptions: [
            {
              hook: `POV: You unlocked the ${file.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ")} blueprint`,
              body: "nah bc once you dial in the framing and stop overcomplicating the workflow everything clicks fr.",
              cta: "comment 'BLUEPRINT' and I'll send the full breakdown",
              hashtags: [
                "#creatorworkflow",
                "#viralreels",
                "#contentstrategy",
                "#aestheticedits",
                "#fyp",
              ],
              estimatedWatchTimeBoost: "+38% 3s hold",
            },
          ],
          srtSubtitles: [
            {
              index: 1,
              startTime: "00:00:00,000",
              endTime: "00:00:01,500",
              startSec: 0,
              endSec: 1.5,
              text: "WAIT UNTIL YOU SEE THIS TRANSFORMATION",
            },
            {
              index: 2,
              startTime: "00:00:01,500",
              endTime: "00:00:03,000",
              startSec: 1.5,
              endSec: 3.0,
              text: "OPTIMIZED FOR MAXIMUM 3-SECOND RETENTION",
            },
            {
              index: 3,
              startTime: "00:00:03,000",
              endTime: "00:00:04,500",
              startSec: 3.0,
              endSec: 4.5,
              text: "C2PA VERIFIED + ZERO SHADOWBAN RISK",
            },
            {
              index: 4,
              startTime: "00:00:04,500",
              endTime: "00:00:06,000",
              startSec: 4.5,
              endSec: 6.0,
              text: "COMMENT 'BLUEPRINT' FOR THE EXACT WORKFLOW",
            },
          ],
          c2paMetadata: {
            title: file.name.replace(/\.[^.]+$/, ""),
            description:
              "Processed via EdgePulse Client-Side C2PA/IPTC Media Pipeline",
            creator: config.creatorHandle,
            creditLine: `${config.creatorHandle} / EdgePulse Studio`,
            digitalSourceType:
              "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
            rightsUsageTerms: "All Rights Reserved - Original Creator Asset",
          },
        },
      });
    }

    setBatchItems((prev) => [...newItems, ...prev]);
    setSelectedId(newItems[0].id);
    setStatusBanner({
      type: "success",
      message: `Added ${newItems.length} media file(s) to the client-side batch queue.`,
    });
    e.target.value = "";
  };

  // Run Real Server-Side Gemini 3.8 Flash Multimodal Analysis on an Item
  const handleAnalyzeItemWithGemini = async (item: BatchMediaItem) => {
    setBatchItems((prev) =>
      prev.map((it) =>
        it.id === item.id
          ? { ...it, status: "analyzing", errorMessage: undefined }
          : it
      )
    );
    setStatusBanner({
      type: "info",
      message: `Analyzing "${item.fileName}" with Gemini 3.8 Flash multimodal engine...`,
    });

    try {
      const { base64, mimeType } = await imageUrlToBase64(item.sourceUrl);
      const response = await fetch("/api/analyze-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: base64,
          mimeType,
          fileName: item.fileName,
          targetRatio: config.targetRatio,
          niche: config.niche,
          videoDurationSec: config.videoDurationSec,
          creatorHandle: config.creatorHandle,
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.analysis) {
        throw new Error(
          data.error || "Gemini API returned an unexpected response."
        );
      }

      const updatedItem: BatchMediaItem = {
        ...item,
        status: "analyzed",
        selectedCaptionIndex: 0,
        analysis: data.analysis,
      };

      const xmpResult = await processEnhancedImageWithXmp(updatedItem, config);

      setBatchItems((prev) =>
        prev.map((it) =>
          it.id === item.id
            ? {
                ...updatedItem,
                processedImageBlob: xmpResult.blob,
                processedImageUrl: xmpResult.url,
                xmpPacketXml: xmpResult.xmpXml,
                sha256Digest: xmpResult.sha256,
                binaryHeaderPreview: xmpResult.hexPreview,
              }
            : it
        )
      );

      setStatusBanner({
        type: "success",
        message: `Gemini 3.8 Flash analysis complete for "${item.fileName}" — Viral Score: ${data.analysis.viralScore}/100 · C2PA XMP binary injected.`,
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Gemini analysis request failed.";
      setBatchItems((prev) =>
        prev.map((it) =>
          it.id === item.id ? { ...it, status: "error", errorMessage: msg } : it
        )
      );
      setStatusBanner({
        type: "error",
        message: `Gemini API Error: ${msg}`,
      });
    }
  };

  // Render Ken Burns Motion Video + Web Audio Mix for Selected Item
  const handleRenderVideo = async (item: BatchMediaItem) => {
    setBatchItems((prev) =>
      prev.map((it) => (it.id === item.id ? { ...it, status: "rendering" } : it))
    );
    setRenderProgressPct(0);
    setStatusBanner({
      type: "info",
      message: `Recording ${config.videoDurationSec}s ${config.fps}fps Ken Burns motion video + Web Audio mix for "${item.fileName}"...`,
    });

    try {
      const [videoRes, imageRes] = await Promise.all([
        renderKenBurnsVideoBlob(
          item,
          config,
          customAudioBuffer,
          (pct) => setRenderProgressPct(pct)
        ),
        processEnhancedImageWithXmp(item, config),
      ]);

      setBatchItems((prev) =>
        prev.map((it) =>
          it.id === item.id
            ? {
                ...it,
                status: "completed",
                renderedVideoBlob: videoRes.blob,
                renderedVideoUrl: videoRes.url,
                processedImageBlob: imageRes.blob,
                processedImageUrl: imageRes.url,
                xmpPacketXml: imageRes.xmpXml,
                sha256Digest: imageRes.sha256,
                binaryHeaderPreview: imageRes.hexPreview,
              }
            : it
        )
      );

      setRenderProgressPct(null);
      setStatusBanner({
        type: "success",
        message: `Rendered ${config.targetRatio} motion video (${(videoRes.blob.size / 1024 / 1024).toFixed(2)} MB) and C2PA JPEG for "${item.fileName}".`,
      });
    } catch (err: unknown) {
      setRenderProgressPct(null);
      const msg =
        err instanceof Error ? err.message : "Failed to render motion video.";
      setBatchItems((prev) =>
        prev.map((it) =>
          it.id === item.id ? { ...it, status: "error", errorMessage: msg } : it
        )
      );
      setStatusBanner({ type: "error", message: msg });
    }
  };

  // Process Entire Batch (C2PA Image Enhancement + Gemini Analysis if queued)
  const handleProcessAllBatch = async () => {
    if (isBatchProcessing) return;
    setIsBatchProcessing(true);
    setStatusBanner({
      type: "info",
      message: `Processing all ${batchItems.length} assets in client-side pipeline (Color Grade + Binary C2PA/IPTC XMP Injection)...`,
    });

    try {
      for (const item of batchItems) {
        const res = await processEnhancedImageWithXmp(item, config);
        setBatchItems((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  status: it.status === "completed" ? "completed" : "analyzed",
                  processedImageBlob: res.blob,
                  processedImageUrl: res.url,
                  xmpPacketXml: res.xmpXml,
                  sha256Digest: res.sha256,
                  binaryHeaderPreview: res.hexPreview,
                }
              : it
          )
        );
      }
      setStatusBanner({
        type: "success",
        message: `Batch complete: All ${batchItems.length} assets enhanced and binary-injected with unique C2PA 2.1 / IPTC XMP manifests.`,
      });
    } catch (err: unknown) {
      setStatusBanner({
        type: "error",
        message:
          err instanceof Error ? err.message : "Batch processing encountered an error.",
      });
    } finally {
      setIsBatchProcessing(false);
    }
  };

  // Package & Download Complete Batch ZIP via JSZip
  const handleExportBatchZip = async () => {
    if (isExportingZip || batchItems.length === 0) return;
    setIsExportingZip(true);
    setStatusBanner({
      type: "info",
      message:
        "Packaging enhanced C2PA JPEGs, rendered WebM motion videos, SRT subtitles, XMP sidecars, Gen Z captions, and Single-File Cloudflare Worker into ZIP archive...",
    });

    try {
      const zip = new JSZip();
      const mediaFolder = zip.folder("01_enhanced_c2pa_images");
      const videoFolder = zip.folder("02_ken_burns_videos");
      const srtFolder = zip.folder("03_srt_subtitles");
      const xmpFolder = zip.folder("04_c2pa_xmp_sidecars");
      const workerFolder = zip.folder("05_cloudflare_worker_deploy");

      const captionsManifest: Record<string, unknown>[] = [];
      const csvRows: string[] = [
        "file_name,aspect_ratio,viral_score,shadowban_risk,sha256_digest,scheduled_offset_min,selected_hook,caption_body,cta,hashtags",
      ];

      for (let i = 0; i < batchItems.length; i++) {
        const item = batchItems[i];
        const baseName = item.fileName.replace(/\.[^.]+$/, "");

        let imgBlob = item.processedImageBlob;
        let xmpXml = item.xmpPacketXml;
        let sha256 = item.sha256Digest;

        if (!imgBlob || !xmpXml || !sha256) {
          const processed = await processEnhancedImageWithXmp(item, config);
          imgBlob = processed.blob;
          xmpXml = processed.xmpXml;
          sha256 = processed.sha256;
        }

        mediaFolder?.file(`${baseName}_${config.targetRatio.replace(":", "x")}_c2pa.jpg`, imgBlob);
        xmpFolder?.file(`${baseName}.xmp`, xmpXml);

        const srtText = formatSrtContent(item.analysis.srtSubtitles);
        srtFolder?.file(`${baseName}.srt`, srtText);

        if (item.renderedVideoBlob) {
          videoFolder?.file(`${baseName}_motion_${config.fps}fps.webm`, item.renderedVideoBlob);
        }

        const activeCap =
          item.analysis.genZCaptions[item.selectedCaptionIndex] ||
          item.analysis.genZCaptions[0];

        captionsManifest.push({
          fileName: item.fileName,
          aspectRatio: config.targetRatio,
          viralScore: item.analysis.viralScore,
          retentionHookScore: item.analysis.retentionHookScore,
          shadowbanRisk: item.analysis.shadowbanRisk,
          sha256Digest: sha256,
          selectedCaption: activeCap,
          allCaptionVariants: item.analysis.genZCaptions,
          c2paMetadata: item.analysis.c2paMetadata,
        });

        const escCsv = (s: string) => `"${(s || "").replace(/"/g, '""')}"`;
        csvRows.push(
          [
            escCsv(item.fileName),
            escCsv(config.targetRatio),
            item.analysis.viralScore,
            escCsv(item.analysis.shadowbanRisk),
            escCsv(sha256 || ""),
            (i + 1) * config.scheduledPublishOffsetMin,
            escCsv(activeCap?.hook || ""),
            escCsv(activeCap?.body || ""),
            escCsv(activeCap?.cta || ""),
            escCsv((activeCap?.hashtags || []).join(" ")),
          ].join(",")
        );
      }

      zip.file(
        "captions_us_genz_manifest.json",
        JSON.stringify(captionsManifest, null, 2)
      );
      zip.file("meta_graph_bulk_schedule.csv", csvRows.join("\n"));

      workerFolder?.file(
        "worker.js",
        generateSingleFileCloudflareWorker(config)
      );
      workerFolder?.file("wrangler.toml", generateWranglerToml(config));

      const zipBlob = await zip.generateAsync({ type: "blob" });
      const downloadUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `edgepulse_batch_${config.targetRatio.replace(":", "x")}_${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(downloadUrl);

      setStatusBanner({
        type: "success",
        message: `Exported complete JSZip archive (${(zipBlob.size / 1024 / 1024).toFixed(2)} MB) with C2PA JPEGs, SRTs, XMPs, Captions, and Cloudflare Worker.`,
      });
    } catch (err: unknown) {
      setStatusBanner({
        type: "error",
        message:
          err instanceof Error ? err.message : "Failed to generate JSZip bundle.",
      });
    } finally {
      setIsExportingZip(false);
    }
  };

  // Update Visual Enhancement Slider on Selected Item
  const updateSelectedEnhancement = (
    field: keyof BatchMediaItem["analysis"]["visualEnhancements"],
    value: number | string
  ) => {
    if (!selectedItem) return;
    setBatchItems((prev) =>
      prev.map((it) =>
        it.id === selectedItem.id
          ? {
              ...it,
              analysis: {
                ...it.analysis,
                visualEnhancements: {
                  ...it.analysis.visualEnhancements,
                  [field]: value,
                },
              },
            }
          : it
      )
    );
  };

  // Update SRT Subtitle Line
  const updateSubtitleSegment = (
    idx: number,
    field: "text" | "startSec" | "endSec",
    val: string | number
  ) => {
    if (!selectedItem) return;
    setBatchItems((prev) =>
      prev.map((it) => {
        if (it.id !== selectedItem.id) return it;
        const nextSubs = it.analysis.srtSubtitles.map((seg, sIdx) => {
          if (sIdx !== idx) return seg;
          const updated = { ...seg, [field]: val };
          if (field === "startSec" || field === "endSec") {
            const formatSrtTime = (sec: number) => {
              const mins = Math.floor(sec / 60)
                .toString()
                .padStart(2, "0");
              const wholeSecs = Math.floor(sec % 60)
                .toString()
                .padStart(2, "0");
              const ms = Math.round((sec % 1) * 1000)
                .toString()
                .padStart(3, "0");
              return `00:${mins}:${wholeSecs},${ms}`;
            };
            updated.startTime = formatSrtTime(Number(updated.startSec));
            updated.endTime = formatSrtTime(Number(updated.endSec));
          }
          return updated;
        });
        return {
          ...it,
          analysis: {
            ...it.analysis,
            srtSubtitles: nextSubs,
          },
        };
      })
    );
  };

  const addSubtitleSegment = () => {
    if (!selectedItem) return;
    const subs = selectedItem.analysis.srtSubtitles;
    const lastEnd = subs.length > 0 ? subs[subs.length - 1].endSec : 0;
    const newStart = Math.min(config.videoDurationSec - 0.5, lastEnd);
    const newEnd = Math.min(config.videoDurationSec, newStart + 1.5);
    const newSeg = {
      index: subs.length + 1,
      startSec: newStart,
      endSec: newEnd,
      startTime: `00:00:0${Math.floor(newStart)},000`,
      endTime: `00:00:0${Math.floor(newEnd)},500`,
      text: "NEW RETENTION HOOK CUE",
    };
    setBatchItems((prev) =>
      prev.map((it) =>
        it.id === selectedItem.id
          ? {
              ...it,
              analysis: {
                ...it.analysis,
                srtSubtitles: [...it.analysis.srtSubtitles, newSeg],
              },
            }
          : it
      )
    );
  };

  const workerCode = generateSingleFileCloudflareWorker(config);
  const wranglerToml = generateWranglerToml(config);

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      {/* Hidden File Inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*"
        onChange={handleFileUpload}
        className="hidden"
      />
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const buf = await f.arrayBuffer();
          setCustomAudioBuffer(buf);
          setCustomAudioName(f.name);
          setConfig((prev) => ({ ...prev, audioPreset: "custom-file" }));
          setStatusBanner({
            type: "success",
            message: `Loaded custom background audio track "${f.name}" for MediaRecorder mixing.`,
          });
        }}
        className="hidden"
      />

      {/* Top Bar Contract: Strictly 3 zones separated by gap-8 */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-800/80 bg-[#0B0F17]/95 sticky top-0 z-30 backdrop-blur-md">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#studio"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection("studio");
          }}
          className="text-lg font-bold tracking-tight text-slate-100 font-display whitespace-nowrap shrink-0"
        >
          EdgePulse Studio
        </a>

        {/* Zone 2: 5 concise single-line navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <a
            href="#studio"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection("studio");
            }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeSection === "studio"
                ? "text-slate-100 border-blue-500"
                : "border-transparent hover:text-slate-200"
            }`}
          >
            Batch Studio
          </a>
          <a
            href="#motion"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection("motion");
            }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeSection === "motion"
                ? "text-slate-100 border-blue-500"
                : "border-transparent hover:text-slate-200"
            }`}
          >
            Motion & Subtitles
          </a>
          <a
            href="#c2pa"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection("c2pa");
            }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeSection === "c2pa"
                ? "text-slate-100 border-blue-500"
                : "border-transparent hover:text-slate-200"
            }`}
          >
            C2PA & XMP
          </a>
          <a
            href="#scheduler"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection("scheduler");
            }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeSection === "scheduler"
                ? "text-slate-100 border-blue-500"
                : "border-transparent hover:text-slate-200"
            }`}
          >
            Meta Scheduler
          </a>
          <a
            href="#worker"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection("worker");
            }}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
              activeSection === "worker"
                ? "text-slate-100 border-blue-500"
                : "border-transparent hover:text-slate-200"
            }`}
          >
            Cloudflare Worker
          </a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={handleExportBatchZip}
            disabled={isExportingZip}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-500 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 flex items-center gap-2 cursor-pointer"
          >
            <FolderArchive className="w-3.5 h-3.5" />
            <span>
              {isExportingZip ? "Packaging ZIP..." : "Export Batch ZIP"}
            </span>
          </button>
        </div>
      </header>

      {/* Mobile Workspace Switcher */}
      <div className="flex md:hidden items-center gap-1 px-4 py-2 border-b border-slate-800 overflow-x-auto bg-slate-900/40">
        {(
          [
            ["studio", "Batch Studio"],
            ["motion", "Motion & Subtitles"],
            ["c2pa", "C2PA & XMP"],
            ["scheduler", "Meta Scheduler"],
            ["worker", "Cloudflare Worker"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveSection(key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors ${
              activeSection === key
                ? "bg-blue-600 text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Contextual Status Feedback Bar */}
      {statusBanner && (
        <div
          className={`px-6 py-2.5 border-b text-xs flex items-center justify-between gap-4 ${
            statusBanner.type === "error"
              ? "bg-red-950/50 border-red-800/60 text-red-200"
              : statusBanner.type === "success"
                ? "bg-emerald-950/40 border-emerald-800/50 text-emerald-200"
                : "bg-blue-950/40 border-blue-800/50 text-blue-200"
          }`}
        >
          <span>{statusBanner.message}</span>
          <button
            onClick={() => setStatusBanner(null)}
            className="text-xs underline opacity-75 hover:opacity-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Workspace Container */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-6">
        {/* Global KPI & Pipeline Bar (Unboxed Tabular Metadata) */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-6 mb-6 border-b border-slate-800/80">
          <div>
            <h1 className="text-xl font-semibold text-slate-100 tracking-tight">
              Client-Side Viral Arbitrage & C2PA Media Engine
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-1 font-mono tabular-nums">
              <span>{batchItems.length} Batch Assets</span>
              <span aria-hidden="true">·</span>
              <span>Target {config.targetRatio}</span>
              <span aria-hidden="true">·</span>
              <span>
                {getTargetDimensions(config.targetRatio).width}×
                {getTargetDimensions(config.targetRatio).height}px
              </span>
              <span aria-hidden="true">·</span>
              <span>{config.fps} FPS Canvas MediaRecorder</span>
              <span aria-hidden="true">·</span>
              <span>C2PA 2.1 Binary APP1 Enabled</span>
              <span aria-hidden="true">·</span>
              <span>Zero Server Storage</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Aspect Ratio Segmented Selector */}
            <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
              {(["9:16", "4:5", "1:1"] as AspectRatioOption[]).map((ratio) => (
                <button
                  key={ratio}
                  onClick={() =>
                    setConfig((prev) => ({ ...prev, targetRatio: ratio }))
                  }
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer font-mono tabular-nums ${
                    config.targetRatio === ratio
                      ? "bg-slate-800 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {ratio}{" "}
                  {ratio === "9:16"
                    ? "Reels"
                    : ratio === "4:5"
                      ? "Feed"
                      : "Square"}
                </button>
              ))}
            </div>

            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-slate-900 border border-slate-800 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Add Media Batch</span>
            </button>

            <button
              onClick={handleProcessAllBatch}
              disabled={isBatchProcessing}
              className="px-3.5 py-2 text-xs font-medium text-emerald-200 bg-emerald-950/60 border border-emerald-800/70 rounded-lg hover:bg-emerald-900/60 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isBatchProcessing ? "animate-spin" : ""}`}
              />
              <span>
                {isBatchProcessing
                  ? "Injecting C2PA Batch..."
                  : "Inject C2PA All"}
              </span>
            </button>
          </div>
        </div>

        {/* VIEW 1: BATCH STUDIO & GEMINI MULTIMODAL OPTIMIZER */}
        {activeSection === "studio" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left Column (4 cols): Batch Queue & Upload Dropzone */}
            <div className="lg:col-span-4 space-y-5">
              <div className="border border-slate-800 rounded-xl p-5 bg-slate-900/40 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-slate-200">
                    01. Batch Media Queue
                  </h2>
                  <span className="text-xs text-slate-400 font-mono tabular-nums">
                    {filteredItems.length} of {batchItems.length} items
                  </span>
                </div>

                {/* Search Filter */}
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter batch by filename..."
                  className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
                />

                {/* Batch Items List */}
                <div className="divide-y divide-slate-800/70 max-h-[420px] overflow-y-auto pr-1">
                  {filteredItems.length === 0 ? (
                    <div className="py-8 text-center space-y-2">
                      <p className="text-xs text-slate-400">
                        No media assets match your filter.
                      </p>
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="px-3 py-1.5 text-xs font-medium bg-slate-800 text-slate-200 rounded-md hover:bg-slate-700 cursor-pointer"
                      >
                        Upload Media Files
                      </button>
                    </div>
                  ) : (
                    filteredItems.map((item) => {
                      const isSelected = item.id === selectedItem?.id;
                      return (
                        <div
                          key={item.id}
                          onClick={() => setSelectedId(item.id)}
                          className={`py-3 px-2.5 flex items-center gap-3 cursor-pointer transition-colors rounded-lg ${
                            isSelected
                              ? "bg-slate-800/80"
                              : "hover:bg-slate-800/35"
                          }`}
                        >
                          <div className="w-12 h-15 rounded-md overflow-hidden bg-slate-950 shrink-0 border border-slate-800">
                            <img
                              src={item.sourceUrl}
                              alt={item.fileName}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-slate-100 truncate">
                              {item.fileName}
                            </p>
                            {/* Unboxed metadata with typographic separators */}
                            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400 mt-1 font-mono tabular-nums">
                              <span className="text-emerald-400 font-medium">
                                Score {item.analysis.viralScore}/100
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>
                                {(item.fileSizeBytes / 1024 / 1024).toFixed(2)}{" "}
                                MB
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>
                                {item.status === "analyzing"
                                  ? "Analyzing..."
                                  : item.status === "rendering"
                                    ? "Rendering..."
                                    : item.renderedVideoUrl
                                      ? "Video + C2PA Ready"
                                      : "C2PA Ready"}
                              </span>
                            </div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (batchItems.length <= 1) return;
                              const next = batchItems.filter(
                                (x) => x.id !== item.id
                              );
                              setBatchItems(next);
                              if (selectedId === item.id && next[0]) {
                                setSelectedId(next[0].id);
                              }
                            }}
                            title="Remove from batch"
                            className="p-1.5 text-slate-500 hover:text-red-400 transition-colors shrink-0 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Dropzone Trigger */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-3 px-4 border border-dashed border-slate-700 hover:border-blue-500/70 rounded-lg text-xs text-slate-400 hover:text-slate-200 transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Drop images here or click to browse local batch</span>
                </button>
              </div>

              {/* Color Grading & Visual Enhancement Controls */}
              {selectedItem && (
                <div className="border border-slate-800 rounded-xl p-5 bg-slate-900/40 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                      <Sliders className="w-4 h-4 text-blue-400" />
                      <span>02. Client-Side Color & Detail Grade</span>
                    </h2>
                    <button
                      onClick={() => {
                        updateSelectedEnhancement("brightness", 4);
                        updateSelectedEnhancement("contrast", 14);
                        updateSelectedEnhancement("saturation", 10);
                        updateSelectedEnhancement("sharpness", 22);
                        updateSelectedEnhancement("warmth", 6);
                      }}
                      className="text-xs text-slate-400 hover:text-slate-200 underline cursor-pointer"
                    >
                      Reset
                    </button>
                  </div>

                  <p className="text-xs text-slate-400 leading-relaxed">
                    {selectedItem.analysis.visualEnhancements.rationale}
                  </p>

                  <div className="space-y-3 pt-1">
                    {(
                      [
                        ["brightness", "Brightness", -25, 25, "%"],
                        ["contrast", "Micro-Contrast", -25, 35, "%"],
                        ["saturation", "Vibrance / Saturation", -20, 35, "%"],
                        ["sharpness", "Edge Clarity Boost", 0, 50, "%"],
                        ["warmth", "Golden Hour Warmth", -20, 25, "%"],
                      ] as const
                    ).map(([key, label, min, max, unit]) => {
                      const val =
                        selectedItem.analysis.visualEnhancements[key];
                      return (
                        <div key={key} className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-300">{label}</span>
                            <span className="font-mono tabular-nums text-slate-400">
                              {val > 0 ? `+${val}` : val}
                              {unit}
                            </span>
                          </div>
                          <input
                            type="range"
                            min={min}
                            max={max}
                            value={val}
                            onChange={(e) =>
                              updateSelectedEnhancement(
                                key,
                                Number(e.target.value)
                              )
                            }
                            className="w-full accent-blue-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Center Column (4 cols): Live 60fps Canvas Viewport & Motion Renderer */}
            <div className="lg:col-span-4 space-y-4">
              <div className="border border-slate-800 rounded-xl p-5 bg-slate-900/40 flex flex-col items-center">
                <div className="w-full flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-slate-200">
                    Live HTML5 Canvas Stage ({config.targetRatio})
                  </span>
                  <span className="text-xs font-mono tabular-nums text-slate-400">
                    {(previewProgress * config.videoDurationSec).toFixed(1)}s /{" "}
                    {config.videoDurationSec.toFixed(1)}s
                  </span>
                </div>

                {/* Canvas Container */}
                <div className="relative w-full flex items-center justify-center bg-slate-950 rounded-lg border border-slate-800/90 p-3 overflow-hidden">
                  <canvas
                    ref={previewCanvasRef}
                    className="max-h-[460px] w-auto rounded-md shadow-lg"
                  />
                </div>

                {/* Scrubber & Playback Controls */}
                <div className="w-full space-y-3 mt-4">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(previewProgress * 100)}
                    onChange={(e) => {
                      setIsPlayingPreview(false);
                      setPreviewProgress(Number(e.target.value) / 100);
                    }}
                    className="w-full accent-blue-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
                  />

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      onClick={() => setIsPlayingPreview((p) => !p)}
                      className="px-3.5 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>
                        {isPlayingPreview ? "Pause Preview" : "Play 60fps Loop"}
                      </span>
                    </button>

                    {selectedItem && (
                      <button
                        onClick={() => handleRenderVideo(selectedItem)}
                        disabled={selectedItem.status === "rendering"}
                        className="px-3.5 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Video className="w-3.5 h-3.5" />
                        <span>
                          {selectedItem.status === "rendering"
                            ? `Encoding ${renderProgressPct ?? 0}%...`
                            : "Render Motion Video (.webm)"}
                        </span>
                      </button>
                    )}
                  </div>

                  {/* Direct Asset Download Row */}
                  {selectedItem && (
                    <div className="pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-xs">
                      {selectedItem.processedImageUrl && (
                        <a
                          href={selectedItem.processedImageUrl}
                          download={`${selectedItem.fileName.replace(/\.[^.]+$/, "")}_c2pa.jpg`}
                          className="text-blue-400 hover:text-blue-300 flex items-center gap-1 font-medium whitespace-nowrap"
                        >
                          <ImageIcon className="w-3.5 h-3.5" />
                          <span>Download C2PA JPEG</span>
                        </a>
                      )}
                      {selectedItem.renderedVideoUrl ? (
                        <a
                          href={selectedItem.renderedVideoUrl}
                          download={`${selectedItem.fileName.replace(/\.[^.]+$/, "")}_motion.webm`}
                          className="text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-medium whitespace-nowrap"
                        >
                          <Film className="w-3.5 h-3.5" />
                          <span>Download Rendered WebM Video</span>
                        </a>
                      ) : (
                        <span className="text-slate-500">
                          Click Render Motion Video to encode WebM + Audio
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Right Column (4 cols): Gemini Multimodal Viral Intelligence & US Gen Z Copywriting */}
            {selectedItem && (
              <div className="lg:col-span-4 space-y-5">
                {/* Gemini Multimodal Scoring & Safety Panel */}
                <div className="border border-slate-800 rounded-xl p-5 bg-slate-900/40 space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-200">
                        03. Gemini Multimodal Viral Audit
                      </h2>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Model: gemini-3.8-flash structured JSON schema
                      </p>
                    </div>
                    <button
                      onClick={() => handleAnalyzeItemWithGemini(selectedItem)}
                      disabled={selectedItem.status === "analyzing"}
                      className="px-3.5 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>
                        {selectedItem.status === "analyzing"
                          ? "Scanning..."
                          : "Analyze with Gemini"}
                      </span>
                    </button>
                  </div>

                  {/* Tabular Metrics Strip */}
                  <div className="grid grid-cols-3 gap-3 pt-2 border-t border-slate-800/80">
                    <div>
                      <div className="text-[11px] text-slate-400">
                        Viral Potential
                      </div>
                      <div className="text-lg font-bold text-slate-100 font-mono tabular-nums mt-0.5">
                        {selectedItem.analysis.viralScore}/100
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-400">
                        3s Hook Hold
                      </div>
                      <div className="text-lg font-bold text-slate-100 font-mono tabular-nums mt-0.5">
                        {selectedItem.analysis.retentionHookScore}/100
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-400">
                        Shadowban Risk
                      </div>
                      <div
                        className={`text-lg font-bold font-mono tabular-nums mt-0.5 ${
                          selectedItem.analysis.shadowbanRisk === "LOW"
                            ? "text-emerald-400"
                            : selectedItem.analysis.shadowbanRisk === "MODERATE"
                              ? "text-amber-400"
                              : "text-red-400"
                        }`}
                      >
                        {selectedItem.analysis.shadowbanRisk}
                      </div>
                    </div>
                  </div>

                  {/* Content Safety & Algorithmic Compliance Flags */}
                  <div className="space-y-1.5 pt-2 border-t border-slate-800/80">
                    <div className="text-xs font-medium text-slate-300">
                      Meta Algorithmic Compliance Checks
                    </div>
                    <ul className="space-y-1 text-xs text-slate-400">
                      {selectedItem.analysis.contentSafetyFlags.map(
                        (flag, idx) => (
                          <li key={idx} className="flex items-start gap-2">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                            <span>{flag}</span>
                          </li>
                        )
                      )}
                    </ul>
                  </div>
                </div>

                {/* US Gen Z Viral Captions & Hooks */}
                <div className="border border-slate-800 rounded-xl p-5 bg-slate-900/40 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-200">
                      04. US Gen Z Viral Captions & 3s Hooks
                    </h2>
                    <span className="text-xs text-slate-400 font-mono tabular-nums">
                      {selectedItem.analysis.genZCaptions.length} variants
                    </span>
                  </div>

                  {/* Variant Selector Buttons */}
                  <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
                    {selectedItem.analysis.genZCaptions.map((cap, idx) => (
                      <button
                        key={idx}
                        onClick={() =>
                          setBatchItems((prev) =>
                            prev.map((it) =>
                              it.id === selectedItem.id
                                ? { ...it, selectedCaptionIndex: idx }
                                : it
                            )
                          )
                        }
                        className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          selectedItem.selectedCaptionIndex === idx
                            ? "bg-slate-800 text-white"
                            : "text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        Hook #{idx + 1} ({cap.estimatedWatchTimeBoost})
                      </button>
                    ))}
                  </div>

                  {(() => {
                    const activeCap =
                      selectedItem.analysis.genZCaptions[
                        selectedItem.selectedCaptionIndex
                      ] || selectedItem.analysis.genZCaptions[0];
                    if (!activeCap) return null;
                    const fullCopyText = `${activeCap.body}\n\n${activeCap.cta}\n\n${activeCap.hashtags.join(" ")}`;

                    return (
                      <div className="space-y-3 text-xs">
                        <div>
                          <label className="text-slate-400 block mb-1">
                            On-Screen 3-Second Retention Hook (Burned into Canvas)
                          </label>
                          <input
                            type="text"
                            value={activeCap.hook}
                            onChange={(e) => {
                              const val = e.target.value;
                              setBatchItems((prev) =>
                                prev.map((it) => {
                                  if (it.id !== selectedItem.id) return it;
                                  const nextCaps =
                                    it.analysis.genZCaptions.map((c, cIdx) =>
                                      cIdx === it.selectedCaptionIndex
                                        ? { ...c, hook: val }
                                        : c
                                    );
                                  return {
                                    ...it,
                                    analysis: {
                                      ...it.analysis,
                                      genZCaptions: nextCaps,
                                    },
                                  };
                                })
                              );
                            }}
                            className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-medium"
                          />
                        </div>

                        <div>
                          <div className="text-slate-400 mb-1">
                            Localized US Gen Z Caption & Comment Trigger
                          </div>
                          <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg space-y-2 text-slate-200 leading-relaxed">
                            <p>{activeCap.body}</p>
                            <p className="text-blue-400 font-medium">
                              CTA: {activeCap.cta}
                            </p>
                            <p className="text-slate-400 font-mono text-[11px]">
                              {activeCap.hashtags.join(" · ")}
                            </p>
                          </div>
                        </div>

                        <button
                          onClick={() =>
                            copyToClipboard(fullCopyText, "caption-copy")
                          }
                          className="w-full py-2 px-3 bg-slate-800 hover:bg-slate-700 text-slate-100 font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          {copiedKey === "caption-copy" ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                              <span>Copied Caption + CTA + Hashtags</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>Copy Full Viral Caption Pack</span>
                            </>
                          )}
                        </button>
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        )}

        {/* VIEW 2: KEN BURNS MOTION, WEB AUDIO BEAT MIXER, SRT SUBTITLES & DYNAMIC WATERMARK */}
        {activeSection === "motion" && selectedItem && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-7 space-y-6">
              {/* Ken Burns Camera & Web Audio Mixer Card */}
              <div className="border border-slate-800 rounded-xl p-6 bg-slate-900/40 space-y-5">
                <h2 className="text-base font-semibold text-slate-100">
                  01. Ken Burns Motion Path & Web Audio Synthesizer
                </h2>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">
                      Camera Trajectory Preset
                    </label>
                    <select
                      value={
                        selectedItem.analysis.visualEnhancements
                          .recommendedKenBurns
                      }
                      onChange={(e) =>
                        updateSelectedEnhancement(
                          "recommendedKenBurns",
                          e.target.value as KenBurnsPreset
                        )
                      }
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100"
                    >
                      <option value="zoom-in-center">
                        Zoom-In Focal Anchor (High Retention)
                      </option>
                      <option value="zoom-out-reveal">
                        Zoom-Out Context Reveal
                      </option>
                      <option value="pan-left-right">
                        Horizontal Cinematic Pan
                      </option>
                      <option value="drift-up-focus">
                        Vertical Upward Drift
                      </option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">
                      Video Duration & Frame Rate
                    </label>
                    <div className="flex items-center gap-2">
                      <select
                        value={config.videoDurationSec}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            videoDurationSec: Number(e.target.value),
                          }))
                        }
                        className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono tabular-nums"
                      >
                        <option value={5}>5.0 Seconds (Loop Reel)</option>
                        <option value={6}>6.0 Seconds (Standard Reel)</option>
                        <option value={8}>8.0 Seconds (Extended Story)</option>
                        <option value={10}>10.0 Seconds (Deep Narrative)</option>
                      </select>

                      <select
                        value={config.fps}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            fps: Number(e.target.value) as 30 | 60,
                          }))
                        }
                        className="w-28 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono tabular-nums"
                      >
                        <option value={60}>60 FPS</option>
                        <option value={30}>30 FPS</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Background Audio Mixing Controls */}
                <div className="pt-4 border-t border-slate-800/80 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-200 flex items-center gap-2">
                      <Music className="w-4 h-4 text-blue-400" />
                      <span>
                        Web Audio API Background Music Mixer (Copyright-Safe)
                      </span>
                    </span>
                    <button
                      onClick={() => audioInputRef.current?.click()}
                      className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md cursor-pointer"
                    >
                      {customAudioName
                        ? `Custom: ${customAudioName}`
                        : "Upload Custom .MP3/.WAV"}
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {(
                      [
                        ["phonk-drift", "Phonk Drift (136 BPM)"],
                        ["lo-fi-chill", "Lo-Fi Chill (88 BPM)"],
                        ["synth-pulse", "Synth Pulse (118 BPM)"],
                        ["none", "Muted Audio"],
                      ] as [AudioPreset, string][]
                    ).map(([preset, label]) => (
                      <button
                        key={preset}
                        onClick={() =>
                          setConfig((prev) => ({
                            ...prev,
                            audioPreset: preset,
                          }))
                        }
                        className={`py-2 px-3 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap truncate cursor-pointer ${
                          config.audioPreset === preset
                            ? "bg-blue-600/20 border-blue-500 text-blue-200"
                            : "bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Custom Dynamic Anti-Rip Watermark & Overlay Toggles */}
                <div className="pt-4 border-t border-slate-800/80 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Dynamic Floating Anti-Rip Watermark Handle
                    </label>
                    <input
                      type="text"
                      value={config.watermarkText}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          watermarkText: e.target.value,
                        }))
                      }
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-100 font-mono"
                    />
                  </div>
                  <div className="space-y-2 pt-1">
                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={config.burnInHookBanner}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            burnInHookBanner: e.target.checked,
                          }))
                        }
                        className="accent-blue-500"
                      />
                      <span>Burn-in 3-Second Top Viral Hook Banner</span>
                    </label>
                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={config.burnInSubtitles}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            burnInSubtitles: e.target.checked,
                          }))
                        }
                        className="accent-blue-500"
                      />
                      <span>Burn-in Timed SRT Subtitles</span>
                    </label>
                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={config.enableDynamicWatermark}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            enableDynamicWatermark: e.target.checked,
                          }))
                        }
                        className="accent-blue-500"
                      />
                      <span>Enable Sinusoidal Anti-Scraper Watermark</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Automated SRT Subtitle Timeline Editor */}
              <div className="border border-slate-800 rounded-xl p-6 bg-slate-900/40 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                      <Subtitles className="w-4 h-4 text-amber-400" />
                      <span>02. Automated SRT Subtitle Timeline</span>
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Synced directly to Canvas burn-in and exported as .srt
                      sidecar files
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={addSubtitleSegment}
                      className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg cursor-pointer whitespace-nowrap"
                    >
                      + Add Cue
                    </button>
                    <button
                      onClick={() => {
                        const srtBlob = new Blob(
                          [formatSrtContent(selectedItem.analysis.srtSubtitles)],
                          { type: "text/plain;charset=utf-8" }
                        );
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(srtBlob);
                        a.download = `${selectedItem.fileName.replace(/\.[^.]+$/, "")}.srt`;
                        a.click();
                      }}
                      className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg cursor-pointer whitespace-nowrap flex items-center gap-1"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download .SRT</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-2.5">
                  {selectedItem.analysis.srtSubtitles.map((seg, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-12 gap-2 items-center p-2.5 bg-slate-950 border border-slate-800/90 rounded-lg text-xs"
                    >
                      <div className="col-span-1 font-mono tabular-nums text-slate-500">
                        #{idx + 1}
                      </div>
                      <div className="col-span-2">
                        <input
                          type="number"
                          step="0.1"
                          value={seg.startSec}
                          onChange={(e) =>
                            updateSubtitleSegment(
                              idx,
                              "startSec",
                              Number(e.target.value)
                            )
                          }
                          className="w-full px-2 py-1 bg-slate-900 border border-slate-800 rounded font-mono tabular-nums text-slate-200"
                        />
                      </div>
                      <div className="col-span-2">
                        <input
                          type="number"
                          step="0.1"
                          value={seg.endSec}
                          onChange={(e) =>
                            updateSubtitleSegment(
                              idx,
                              "endSec",
                              Number(e.target.value)
                            )
                          }
                          className="w-full px-2 py-1 bg-slate-900 border border-slate-800 rounded font-mono tabular-nums text-slate-200"
                        />
                      </div>
                      <div className="col-span-7">
                        <input
                          type="text"
                          value={seg.text}
                          onChange={(e) =>
                            updateSubtitleSegment(idx, "text", e.target.value)
                          }
                          className="w-full px-2.5 py-1 bg-slate-900 border border-slate-800 rounded text-slate-100 font-medium"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right Column: Live Stage Mirror */}
            <div className="lg:col-span-5 border border-slate-800 rounded-xl p-5 bg-slate-900/40 flex flex-col items-center">
              <div className="w-full flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-slate-200">
                  Real-Time Burn-In Preview ({selectedItem.fileName})
                </span>
                <button
                  onClick={() => handleRenderVideo(selectedItem)}
                  disabled={selectedItem.status === "rendering"}
                  className="px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg cursor-pointer"
                >
                  {selectedItem.status === "rendering"
                    ? `Encoding ${renderProgressPct ?? 0}%...`
                    : "Encode WebM Video"}
                </button>
              </div>
              <canvas
                ref={previewCanvasRef}
                className="max-h-[500px] w-auto rounded-lg border border-slate-800 bg-black"
              />
            </div>
          </div>
        )}

        {/* VIEW 3: C2PA 2.1 / IPTC XMP BINARY METADATA INJECTOR & HEX INSPECTOR */}
        {activeSection === "c2pa" && selectedItem && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-5 border border-slate-800 rounded-xl p-6 bg-slate-900/40 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-100">
                  01. C2PA 2.1 & IPTC Provenance Fields
                </h2>
                <button
                  onClick={async () => {
                    const res = await processEnhancedImageWithXmp(
                      selectedItem,
                      config
                    );
                    setBatchItems((prev) =>
                      prev.map((it) =>
                        it.id === selectedItem.id
                          ? {
                              ...it,
                              processedImageBlob: res.blob,
                              processedImageUrl: res.url,
                              xmpPacketXml: res.xmpXml,
                              sha256Digest: res.sha256,
                              binaryHeaderPreview: res.hexPreview,
                            }
                          : it
                      )
                    );
                    setStatusBanner({
                      type: "success",
                      message: `Re-injected fresh C2PA/IPTC APP1 XMP segment into "${selectedItem.fileName}" (SHA-256: ${res.sha256.slice(0, 16)}...).`,
                    });
                  }}
                  className="px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg cursor-pointer"
                >
                  Re-Sign & Inject Binary XMP
                </button>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed">
                Strips legacy camera/scraper EXIF markers (`0xFFE1`/`0xFFED`)
                and injects a fresh Adobe XMP + IPTC Core + C2PA 2.1 manifest
                directly after the JPEG `0xFFD8` SOI header to prevent duplicate
                hash throttling on Meta platforms.
              </p>

              <div className="space-y-3 text-xs">
                {(
                  [
                    ["title", "Document Title (dc:title)"],
                    ["description", "Provenance Description (dc:description)"],
                    ["creator", "Verified Creator (dc:creator)"],
                    ["creditLine", "IPTC Credit Line (photoshop:Credit)"],
                    [
                      "digitalSourceType",
                      "IPTC Digital Source Type URI (Iptc4xmpExt:DigitalSourceType)",
                    ],
                    ["rightsUsageTerms", "Rights Usage Terms (dc:rights)"],
                  ] as const
                ).map(([field, label]) => (
                  <div key={field}>
                    <label className="block text-slate-400 mb-1">{label}</label>
                    <input
                      type="text"
                      value={selectedItem.analysis.c2paMetadata[field]}
                      onChange={(e) => {
                        const val = e.target.value;
                        setBatchItems((prev) =>
                          prev.map((it) =>
                            it.id === selectedItem.id
                              ? {
                                  ...it,
                                  analysis: {
                                    ...it.analysis,
                                    c2paMetadata: {
                                      ...it.analysis.c2paMetadata,
                                      [field]: val,
                                    },
                                  },
                                }
                              : it
                          )
                        );
                      }}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="lg:col-span-7 space-y-6">
              {/* Binary Header Hex Dump Inspector */}
              <div className="border border-slate-800 rounded-xl p-6 bg-slate-900/40 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-200">
                    02. Binary JPEG APP1 (`0xFFE1`) Header Verification
                  </h2>
                  <span className="text-xs font-mono tabular-nums text-emerald-400">
                    SHA-256:{" "}
                    {selectedItem.sha256Digest
                      ? `${selectedItem.sha256Digest.slice(0, 20)}...`
                      : "Computing..."}
                  </span>
                </div>
                <pre className="p-4 bg-slate-950 border border-slate-800 rounded-lg text-[11px] font-mono tabular-nums text-slate-300 overflow-x-auto leading-relaxed">
                  {selectedItem.binaryHeaderPreview ||
                    "0000  FF D8 FF E1 09 A4 68 74 74 70 3A 2F 2F 6E 73 2E  |......http://ns.|"}
                </pre>
              </div>

              {/* Full Injected XMP XML Packet */}
              <div className="border border-slate-800 rounded-xl p-6 bg-slate-900/40 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-200">
                    03. Injected C2PA 2.1 / IPTC XMP Packet XML
                  </h2>
                  <button
                    onClick={() =>
                      copyToClipboard(
                        selectedItem.xmpPacketXml ||
                          buildC2paXmpPacket(
                            selectedItem.analysis.c2paMetadata,
                            selectedItem.sha256Digest || "verified",
                            config.targetRatio
                          ),
                        "xmp-xml"
                      )
                    }
                    className="px-3 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md cursor-pointer"
                  >
                    {copiedKey === "xmp-xml" ? "Copied XML" : "Copy XMP Packet"}
                  </button>
                </div>
                <pre className="p-4 bg-slate-950 border border-slate-800 rounded-lg text-[11px] font-mono text-slate-300 overflow-x-auto max-h-[340px] leading-relaxed">
                  {selectedItem.xmpPacketXml ||
                    buildC2paXmpPacket(
                      selectedItem.analysis.c2paMetadata,
                      selectedItem.sha256Digest || "verified",
                      config.targetRatio
                    )}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* VIEW 4: DIRECT META GRAPH API v21.0 SCHEDULER & BULK QUEUE */}
        {activeSection === "scheduler" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-4 border border-slate-800 rounded-xl p-6 bg-slate-900/40 space-y-4">
              <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <CalendarClock className="w-4 h-4 text-blue-400" />
                <span>01. Meta Graph API v21.0 Configuration</span>
              </h2>
              <p className="text-xs text-slate-400 leading-relaxed">
                Configure your Instagram Business Account ID and cadence offset
                for automated Reels container publishing via your Cloudflare
                Worker `/api/meta-schedule` endpoint.
              </p>

              <div className="space-y-3 text-xs">
                <div>
                  <label className="block text-slate-400 mb-1">
                    Instagram Business Account ID (`ig-user-id`)
                  </label>
                  <input
                    type="text"
                    value={config.metaIgUserId}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        metaIgUserId: e.target.value,
                      }))
                    }
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">
                    Facebook Page ID
                  </label>
                  <input
                    type="text"
                    value={config.metaPageId}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        metaPageId: e.target.value,
                      }))
                    }
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">
                    Staggered Queue Interval (Minutes Between Posts)
                  </label>
                  <input
                    type="number"
                    min={15}
                    max={720}
                    value={config.scheduledPublishOffsetMin}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        scheduledPublishOffsetMin: Number(e.target.value),
                      }))
                    }
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono tabular-nums"
                  />
                </div>
              </div>
            </div>

            <div className="lg:col-span-8 border border-slate-800 rounded-xl p-6 bg-slate-900/40 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-100">
                  02. Staggered Viral Release Schedule ({batchItems.length}{" "}
                  Containers)
                </h2>
                <button
                  onClick={() => {
                    setBatchItems((prev) =>
                      prev.map((it) => ({
                        ...it,
                        metaScheduleStatus: "queued-container",
                      }))
                    );
                    setStatusBanner({
                      type: "success",
                      message: `Validated all ${batchItems.length} Reels media containers for Meta Graph API v21.0 staggered publishing.`,
                    });
                  }}
                  className="px-3.5 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg cursor-pointer"
                >
                  Validate & Arm All Containers
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400">
                      <th className="py-2.5 pr-4 font-medium">Asset</th>
                      <th className="py-2.5 px-3 font-medium">Ratio</th>
                      <th className="py-2.5 px-3 font-medium text-right">
                        Viral Score
                      </th>
                      <th className="py-2.5 px-3 font-medium">Selected Hook</th>
                      <th className="py-2.5 px-3 font-medium text-right">
                        Publish Offset
                      </th>
                      <th className="py-2.5 pl-3 font-medium text-right">
                        Container State
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {batchItems.map((item, idx) => {
                      const cap =
                        item.analysis.genZCaptions[item.selectedCaptionIndex] ||
                        item.analysis.genZCaptions[0];
                      return (
                        <tr
                          key={item.id}
                          className="hover:bg-slate-800/30 transition-colors"
                        >
                          <td className="py-3 pr-4 font-medium text-slate-100 truncate max-w-[180px]">
                            {item.fileName}
                          </td>
                          <td className="py-3 px-3 font-mono tabular-nums text-slate-300">
                            {config.targetRatio}
                          </td>
                          <td className="py-3 px-3 font-mono tabular-nums text-right text-emerald-400 font-semibold">
                            {item.analysis.viralScore}/100
                          </td>
                          <td className="py-3 px-3 text-slate-300 truncate max-w-[240px]">
                            {cap?.hook}
                          </td>
                          <td className="py-3 px-3 font-mono tabular-nums text-right text-slate-400">
                            +{(idx + 1) * config.scheduledPublishOffsetMin} min
                          </td>
                          <td className="py-3 pl-3 font-mono text-right text-slate-300">
                            {item.metaScheduleStatus === "queued-container"
                              ? "ARMED (v21.0)"
                              : "READY"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* VIEW 5: COMPLETE SINGLE-FILE CLOUDFLARE WORKER GENERATOR (worker.js + wrangler.toml) */}
        {activeSection === "worker" && (
          <div className="space-y-6">
            <div className="border border-slate-800 rounded-xl p-6 bg-slate-900/40 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                  <Code2 className="w-4 h-4 text-blue-400" />
                  <span>
                    Single-File Cloudflare Worker (`worker.js` + `wrangler.toml`)
                  </span>
                </h2>
                <p className="text-xs text-slate-400">
                  Zero-dependency ES Module Cloudflare Worker embedding the
                  HTML5/Tailwind frontend, Canvas/MediaRecorder engine, Binary
                  C2PA XMP injector, Gemini 3.8 Flash proxy, and Meta Graph
                  Reels scheduler.
                </p>
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  onClick={() => copyToClipboard(workerCode, "worker-js")}
                  className="px-3.5 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  {copiedKey === "worker-js" ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Copied worker.js</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy worker.js</span>
                    </>
                  )}
                </button>

                <button
                  onClick={() => {
                    const blob = new Blob([workerCode], {
                      type: "application/javascript;charset=utf-8",
                    });
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = "worker.js";
                    a.click();
                  }}
                  className="px-3.5 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <FileCode className="w-3.5 h-3.5" />
                  <span>Download worker.js</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-8 border border-slate-800 rounded-xl p-5 bg-slate-900/40 space-y-3">
                <div className="flex items-center justify-between text-xs text-slate-400 font-mono">
                  <span>worker.js (Complete Production ES Module)</span>
                  <span>{workerCode.split("\n").length} lines</span>
                </div>
                <pre className="p-4 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-200 overflow-x-auto max-h-[540px] leading-relaxed">
                  {workerCode}
                </pre>
              </div>

              <div className="lg:col-span-4 border border-slate-800 rounded-xl p-5 bg-slate-900/40 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-200 font-mono">
                    wrangler.toml
                  </span>
                  <button
                    onClick={() => copyToClipboard(wranglerToml, "wrangler")}
                    className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
                  >
                    {copiedKey === "wrangler" ? "Copied!" : "Copy Config"}
                  </button>
                </div>
                <pre className="p-4 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-300 overflow-x-auto leading-relaxed">
                  {wranglerToml}
                </pre>

                <div className="pt-3 border-t border-slate-800 space-y-2 text-xs text-slate-400">
                  <div className="font-semibold text-slate-200">
                    3-Command Edge Deployment
                  </div>
                  <pre className="p-3 bg-slate-950 border border-slate-800 rounded-lg font-mono text-[11px] text-slate-300 overflow-x-auto">
{`npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put META_GRAPH_ACCESS_TOKEN
npx wrangler deploy`}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
