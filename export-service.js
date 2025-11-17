const path = require("path");
const fs = require("fs-extra");
const { bundle } = require("@remotion/bundler");
const { selectComposition, renderMedia } = require("@remotion/renderer");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

const {
  convertToWav,
  transcribeWithWhisper,
  WHISPER_EXECUTABLE,
  WHISPER_MODEL,
} = require("./whisper-service");

const {
  translateSubtitles,
  translateToHindiScript,
  isPerplexityAvailable,
} = require("./perplexity-service");

const { FFMPEG_AVAILABLE, PERPLEXITY_AVAILABLE } = require("./config");

// Setup temp folders
const UPLOADS_DIR = path.resolve(__dirname, "uploads");
const TEMP_DIR = path.resolve(__dirname, "temp");
const RENDERS_DIR = path.resolve(__dirname, "renders");

fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(TEMP_DIR);
fs.ensureDirSync(RENDERS_DIR);

// ✅ FIX 1: Initialize activeRenders Map to track all active renders
const activeRenders = new Map();

// Setup for tracking render cleanups
const cleanupTimeouts = new Map();

// Multer setup for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

// Express setup
const app = express();
app.use(cors());
app.use(express.json());

// ✅ FIX 2: Serve uploaded files with proper CORS and Range headers
app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    setHeaders: (res, path, stat) => {
      // Critical headers for ORB compliance and video seeking
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  })
);

app.use(
  "/renders",
  express.static(RENDERS_DIR, {
    setHeaders: (res, path, stat) => {
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  })
);

// Helper to validate src URLs
function validateSrcUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url, "file://");
    // Allow http, https URLs or files under uploaded or renders directory
    if (["http:", "https:"].includes(u.protocol)) return true;
    // Accept only files under uploads or renders folder
    if (
      u.protocol === "file:" &&
      (u.pathname.startsWith(UPLOADS_DIR) || u.pathname.startsWith(RENDERS_DIR))
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Generate unique id for render tracking
 */
function generateRenderId() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Bundle Remotion project once on startup
 */
async function bundleRemotionProject({ entryPoint, onProgress }) {
  try {
    console.log("📦 Starting Remotion bundle...");
    const bundlePath = await bundle({
      entryPoint: path.resolve(entryPoint),
      onProgress: (progress) => {
        if (onProgress) {
          onProgress(progress);
        }
        console.log(` 📊 Bundle progress: ${Math.round(progress * 100)}%`);
      },
      ignoreRegisterRootWarning: true,
    });
    console.log(`✅ Bundle complete at: ${bundlePath}`);
    return bundlePath;
  } catch (error) {
    console.error("❌ Bundling failed:", error.message);
    throw error;
  }
}

/**
 * Render video using Remotion
 */
async function renderVideo({
  bundlePath,
  compositionId,
  inputProps = {},
  outputDir,
  renderConfig = {},
}) {
  const renderId = generateRenderId();
  const tempFilePath = path.join(outputDir, `render-${renderId}.mp4`);

  // Validate src URL early
  if (inputProps.src && !validateSrcUrl(inputProps.src)) {
    throw new Error(
      `Invalid or unsafe src URL: ${inputProps.src}. Must be HTTP(S) or local under uploads/renders.`
    );
  }

  try {
    console.log(`🎬 Starting render for composition: ${compositionId}`);
    console.log(` Render ID: ${renderId}`);
    console.log("🔍 Selecting composition...");

    const composition = await selectComposition({
      serveUrl: bundlePath,
      id: compositionId,
      inputProps: inputProps,
      logLevel: "info",
    });

    console.log(`✓ Composition selected: ${composition.id}`);
    console.log(` - Dimensions: ${composition.width}x${composition.height}`);
    console.log(` - Duration: ${composition.durationInFrames} frames @ ${composition.fps} fps`);

    const defaultConfig = {
      codec: "h264",
      logLevel: "info",
    };

    const finalConfig = { ...defaultConfig, ...renderConfig };

    console.log("🎥 Rendering video...");

    const renderResult = await renderMedia({
      composition,
      serveUrl: bundlePath,
      outputLocation: tempFilePath,
      inputProps: inputProps,
      ...finalConfig,
      onProgress: ({ progress }) => {
        console.log(` 📺 Render progress: ${Math.round(progress * 100)}%`);
      },
    });

    const fileExists = await fs.pathExists(tempFilePath);
    if (!fileExists) {
      throw new Error(`Render completed but file not found at ${tempFilePath}`);
    }

    const fileStats = await fs.stat(tempFilePath);
    console.log(`✅ Video rendered successfully`);
    console.log(` File size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);

    const expiresIn = renderConfig.expirationSeconds || 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    // Store metadata and schedule cleanup
    activeRenders.set(renderId, {
      filePath: tempFilePath,
      compositionId,
      createdAt: Date.now(),
      expiresAt,
      fileSize: fileStats.size,
    });

    if (cleanupTimeouts.has(renderId)) {
      clearTimeout(cleanupTimeouts.get(renderId));
    }

    const timeoutId = setTimeout(async () => {
      try {
        await fs.remove(tempFilePath);
        activeRenders.delete(renderId);
        cleanupTimeouts.delete(renderId);
        console.log(`🗑️ Cleaned up expired render: ${renderId}`);
      } catch (error) {
        console.error(`❌ Cleanup failed for ${renderId}:`, error.message);
      }
    }, expiresIn * 1000);

    cleanupTimeouts.set(renderId, timeoutId);

    return {
      renderId,
      filePath: tempFilePath,
      downloadPath: `/api/render/download/${renderId}`,
      expiresIn,
      expiresAt: new Date(expiresAt).toISOString(),
      fileSize: fileStats.size,
    };
  } catch (error) {
    console.error("❌ Render failed:", error.message);
    if (await fs.pathExists(tempFilePath)) {
      await fs.remove(tempFilePath);
    }

    activeRenders.delete(renderId);
    throw error;
  }
}

function getRenderMetadata(renderId) {
  const render = activeRenders.get(renderId);
  if (!render) return null;

  // Check expiration
  if (Date.now() > render.expiresAt) {
    activeRenders.delete(renderId);
    return null;
  }

  return render;
}

function getActiveRenders() {
  const now = Date.now();
  const active = [];

  for (const [renderId, render] of activeRenders.entries()) {
    if (now <= render.expiresAt) {
      active.push({
        renderId,
        compositionId: render.compositionId,
        createdAt: new Date(render.createdAt).toISOString(),
        expiresAt: new Date(render.expiresAt).toISOString(),
        fileSize: render.fileSize,
        timeRemainingSeconds: Math.ceil((render.expiresAt - now) / 1000),
      });
    }
  }

  return active;
}

async function cancelRender(renderId) {
  const render = activeRenders.get(renderId);
  if (!render) return false;

  try {
    await fs.remove(render.filePath);
    activeRenders.delete(renderId);

    if (cleanupTimeouts.has(renderId)) {
      clearTimeout(cleanupTimeouts.get(renderId));
      cleanupTimeouts.delete(renderId);
    }

    console.log(`✅ Render cancelled: ${renderId}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to cancel render ${renderId}:`, error.message);
    return false;
  }
}

async function getDownloadStream(renderId) {
  const render = getRenderMetadata(renderId);
  if (!render) throw new Error("Render not found or expired");

  const fileExists = await fs.pathExists(render.filePath);
  if (!fileExists) {
    activeRenders.delete(renderId);
    throw new Error("File no longer available");
  }

  const stream = fs.createReadStream(render.filePath);
  const fileName = `video-${renderId.substring(0, 8)}.mp4`;

  return {
    stream,
    fileName,
    fileSize: render.fileSize,
  };
}

module.exports = {
  bundleRemotionProject,
  renderVideo,
  getRenderMetadata,
  getDownloadStream,
  getActiveRenders,
  cancelRender,
  generateRenderId,
};
