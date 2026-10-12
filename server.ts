import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getGenAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not configured.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Allow up to 25MB payloads for high-resolution image batch analysis
  app.use(express.json({ limit: "25mb" }));

  app.post("/api/analyze-media", async (req, res) => {
    try {
      const {
        imageBase64,
        mimeType = "image/jpeg",
        fileName = "asset.jpg",
        targetRatio = "9:16",
        niche = "Streetwear & Creator Lifestyle",
        videoDurationSec = 6,
        creatorHandle = "@edgepulse.creator",
      } = req.body;

      if (!imageBase64) {
        res.status(400).json({ error: "Missing imageBase64 payload." });
        return;
      }

      const ai = getGenAIClient();

      const prompt = `You are a Meta Platform (Instagram Reels & Facebook Feed) Algorithmic Viral Engineer, Visual Colorist, C2PA Metadata Architect, and US Gen Z Copywriter.
Analyze this media frame ("${fileName}") for a ${targetRatio} viral placement in the "${niche}" vertical (creator handle: ${creatorHandle}, target video duration: ${videoDurationSec} seconds).

Return a structured JSON analysis containing:
1. viralScore (0-100) and retentionHookScore (0-100) based on visual contrast, subject framing, scroll-stopping salience, and Meta Reels safe-zone compliance.
2. shadowbanRisk ("LOW", "MODERATE", or "HIGH") and 3 concrete contentSafetyFlags explaining Meta policy & algorithmic safety compliance.
3. visualEnhancements: optimal color grading adjustments (brightness -25 to +25, contrast -25 to +35, saturation -20 to +35, sharpness 0 to 50, warmth -20 to +25), recommendedKenBurns motion ("zoom-in-center", "pan-left-right", "zoom-out-reveal", or "drift-up-focus"), normalized focalPointX (0.15 to 0.85) and focalPointY (0.15 to 0.85) pointing to the main visual anchor, plus a concise engineering rationale.
4. genZCaptions: 3 high-converting US Gen Z viral caption variants, each with an on-screen 3-second text hook (max 8 words), authentic US Gen Z caption body, comment-bait engagement CTA, 5 high-velocity hashtags, and estimatedWatchTimeBoost (e.g., "+42% 3s hold").
5. srtSubtitles: 4 sequential timed subtitle segments spanning 0 to ${videoDurationSec} seconds (with index 1..4, startTime in "00:00:00,000" SRT format, endTime in "00:00:01,500" SRT format, startSec number, endSec number, and punchy spoken/on-screen text).
6. c2paMetadata: C2PA 2.1 / IPTC XMP compliant provenance fields (title, description, creator, creditLine, digitalSourceType, rightsUsageTerms).`;

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: imageBase64,
              },
            },
            {
              text: prompt,
            },
          ],
        },
        config: {
          temperature: 0.7,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              viralScore: { type: Type.NUMBER },
              retentionHookScore: { type: Type.NUMBER },
              shadowbanRisk: { type: Type.STRING },
              contentSafetyFlags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              visualEnhancements: {
                type: Type.OBJECT,
                properties: {
                  brightness: { type: Type.NUMBER },
                  contrast: { type: Type.NUMBER },
                  saturation: { type: Type.NUMBER },
                  sharpness: { type: Type.NUMBER },
                  warmth: { type: Type.NUMBER },
                  recommendedKenBurns: { type: Type.STRING },
                  focalPointX: { type: Type.NUMBER },
                  focalPointY: { type: Type.NUMBER },
                  rationale: { type: Type.STRING },
                },
                required: [
                  "brightness",
                  "contrast",
                  "saturation",
                  "sharpness",
                  "warmth",
                  "recommendedKenBurns",
                  "focalPointX",
                  "focalPointY",
                  "rationale",
                ],
              },
              genZCaptions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    hook: { type: Type.STRING },
                    body: { type: Type.STRING },
                    cta: { type: Type.STRING },
                    hashtags: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    estimatedWatchTimeBoost: { type: Type.STRING },
                  },
                  required: [
                    "hook",
                    "body",
                    "cta",
                    "hashtags",
                    "estimatedWatchTimeBoost",
                  ],
                },
              },
              srtSubtitles: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    index: { type: Type.INTEGER },
                    startTime: { type: Type.STRING },
                    endTime: { type: Type.STRING },
                    startSec: { type: Type.NUMBER },
                    endSec: { type: Type.NUMBER },
                    text: { type: Type.STRING },
                  },
                  required: [
                    "index",
                    "startTime",
                    "endTime",
                    "startSec",
                    "endSec",
                    "text",
                  ],
                },
              },
              c2paMetadata: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  creator: { type: Type.STRING },
                  creditLine: { type: Type.STRING },
                  digitalSourceType: { type: Type.STRING },
                  rightsUsageTerms: { type: Type.STRING },
                },
                required: [
                  "title",
                  "description",
                  "creator",
                  "creditLine",
                  "digitalSourceType",
                  "rightsUsageTerms",
                ],
              },
            },
            required: [
              "viralScore",
              "retentionHookScore",
              "shadowbanRisk",
              "contentSafetyFlags",
              "visualEnhancements",
              "genZCaptions",
              "srtSubtitles",
              "c2paMetadata",
            ],
          },
        },
      });

      const rawText = response.text;
      if (!rawText) {
        throw new Error("Empty response from Gemini multimodal analysis.");
      }

      const parsed = JSON.parse(rawText.trim());
      res.json({ analysis: parsed });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to analyze media via Gemini API.";
      console.error("Gemini multimodal analysis error:", message);
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`EdgePulse Studio server listening on http://localhost:${PORT}`);
  });
}

startServer();
