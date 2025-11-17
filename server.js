const {
  bundleRemotionProject,
  renderVideo,
  getRenderMetadata,
  getDownloadStream,
  getActiveRenders,
  cancelRender,
} = require("./export-service");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs-extra");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const {
  convertToWav,
  transcribeWithWhisper,
  WHISPER_EXECUTABLE,
  WHISPER_MODEL,
} = require("./whisper-service");

const { translateSubtitles, translateToHindiScript } = require("./perplexity-service");

const { FFMPEG_AVAILABLE } = require("./config");

const UPLOADS_DIR = path.resolve(__dirname, "uploads");
const TEMP_DIR = path.resolve(__dirname, "temp");
const RENDERS_DIR = path.resolve(__dirname, "renders");

const PERPLEXITY_AVAILABLE = process.env.PERPLEXITY_API_KEY;
const backendURL = process.env.NEXT_PUBLIC_BACKEND_SERVER_URL;

fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(TEMP_DIR);
fs.ensureDirSync(RENDERS_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

const app = express();
app.use(cors());
app.use(express.json());

app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    setHeaders: (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if ([".mp4", ".webm", ".mkv", ".mov"].includes(ext)) {
        res.setHeader("Content-Type", "video/mp4");
      }
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
    },
  })
);

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "File missing" });

  const savedFilename = path.basename(req.file.path);

  res.json({
    success: true,
    filePath: req.file.path,
    filename: savedFilename,
    originalFilename: req.file.originalname,
    size: req.file.size,
  });
});

app.post("/transcribe", upload.single("file"), async (req, res) => {
  const language = req.body.language || "auto";

  let tempInput = null;
  let tempWav = null;
  let srtPath = null;
  let vttPath = null;
  let outputPrefix = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    console.log("📝 Received transcription request:");
    console.log(` - language (raw): ${language}`);

    tempInput = req.file.path;
    const suffix = path.extname(req.file.originalname).toLowerCase();
    const needsConversion = [".mp4", ".m4a", ".mov", ".avi", ".mkv", ".webm"].includes(suffix);
    let inputFile = tempInput;

    console.log(`📁 Processing: ${req.file.originalname} (${req.file.size} bytes)`);

    if (needsConversion) {
      if (!FFMPEG_AVAILABLE) {
        return res.status(400).json({
          error: "FFmpeg is required for video/MP4 files. Please install ffmpeg.",
        });
      }
      tempWav = path.resolve(TEMP_DIR, Date.now() + ".wav");
      console.log(`🔄 Converting ${suffix} to WAV...`);
      await convertToWav(tempInput, tempWav);
      inputFile = tempWav;
    }

    outputPrefix = path.resolve(TEMP_DIR, "output-" + Date.now());
    srtPath = outputPrefix + ".srt";
    vttPath = outputPrefix + ".vtt";

    console.log("🎤 Running whisper.cpp...");

    const { srtText: originalSrt, vttText: originalVtt } = await transcribeWithWhisper(
      inputFile,
      language,
      outputPrefix
    );

    if (!originalSrt && !originalVtt) {
      return res.status(500).json({
        error: "No subtitles were generated. Check if the audio file contains speech.",
      });
    }

    let srtText = originalSrt;
    let vttText = originalVtt;
    let translated = false;
    let translationType = null;

    if (PERPLEXITY_AVAILABLE) {
      const lang = language.toLowerCase();
      console.log(`🗣️ Normalized language: ${lang}`);
      console.log("🔍 Checking translation conditions...");

      if (lang === "en" || lang === "english") {
        console.log("ℹ️ English detected - no translation applied.");
      } else if (lang === "hinglish") {
        console.log("🌐 Translating to Hinglish via Perplexity...");
        if (srtText) {
          srtText = await translateSubtitles(srtText, false);
          console.log(" - SRT translated to Hinglish.");
        }
        if (vttText) {
          vttText = await translateSubtitles(vttText, true);
          console.log(" - VTT translated to Hinglish.");
        }
        translated = true;
        translationType = "hinglish";
        console.log("✓ Hinglish translation complete");
      } else if (lang === "hi" || lang === "hindi") {
        console.log("🌐 Translating to Hindi Devanagari script via Perplexity...");
        if (srtText) {
          srtText = await translateToHindiScript(srtText, false);
          console.log(" - SRT translated to Hindi script.");
        }
        if (vttText) {
          vttText = await translateToHindiScript(vttText, true);
          console.log(" - VTT translated to Hindi script.");
        }
        translated = true;
        translationType = "hindi_script";
        console.log("✓ Hindi script translation complete");
      } else {
        console.log(`⚠️ Unhandled language type: ${language} - skipping translation.`);
      }
    } else {
      console.log(
        "⚠️ Perplexity API not available - skipping all translations :::  .",
        PERPLEXITY_AVAILABLE
      );
    }

    console.log("✅ Transcription complete!");
    console.log("\n📤 Sending response to client...");

    res.json({
      success: true,
      filename: req.file.originalname,
      language,
      srt: srtText,
      vtt: vttText,
      converted: needsConversion,
      translated,
      translation_type: translationType,
    });
  } catch (e) {
    console.error("❌ Error:", e.message);
    res.status(500).json({ error: "Transcription failed: " + e.message });
  } finally {
    try {
      if (tempInput && (await fs.pathExists(tempInput))) await fs.remove(tempInput);
      if (tempWav && (await fs.pathExists(tempWav))) await fs.remove(tempWav);
      if (srtPath && (await fs.pathExists(srtPath))) await fs.remove(srtPath);
      if (vttPath && (await fs.pathExists(vttPath))) await fs.remove(vttPath);
      if (outputPrefix && (await fs.pathExists(outputPrefix))) await fs.remove(outputPrefix);
    } catch (cleanupError) {
      console.error("⚠️  Cleanup error:", cleanupError.message);
    }
  }
});

app.post("/api/render/video", async (req, res) => {
  try {
    if (!remotionBundle) await initializeRemotionBundle();

    const { compositionId, inputProps, renderConfig } = req.body;

    const result = await renderVideo({
      bundlePath: remotionBundle,
      compositionId,
      inputProps,
      outputDir: RENDERS_DIR,
      renderConfig,
    });

    // Generate the CLI command for local rendering
    const cliCommand = generateCliCommand({
      compositionId,
      inputProps,
      renderConfig,
    });

    res.json({
      success: true,
      renderId: result.renderId,
      downloadPath: result.downloadPath,
      downloadUrl: `${backendURL}${result.downloadPath}`,
      expiresAt: result.expiresAt,
      fileSize: result.fileSize,
      cliCommand, // Include the CLI command
    });
  } catch (err) {
    console.error("❌ Render error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

function generateCliCommand({ compositionId, inputProps, renderConfig }) {
  const propsStr = JSON.stringify(inputProps).replace(/"/g, '\\"');
  const codec = renderConfig?.codec || "h264";

  return `npx remotion render src/index.ts ${compositionId} output.mp4 --props='${propsStr}' --codec=${codec}`;
}

app.get("/api/render/download/:renderId", async (req, res) => {
  try {
    const { renderId } = req.params;
    const { stream, fileName, fileSize } = await getDownloadStream(renderId);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", fileSize);
    stream.pipe(res);
  } catch (err) {
    console.error("❌ Download error:", err.message);
    res.status(404).json({ error: err.message });
  }
});

app.get("/api/render/status/:renderId", (req, res) => {
  const { renderId } = req.params;
  const meta = getRenderMetadata(renderId);
  if (!meta) return res.status(404).json({ error: "Not found" });
  res.json(meta);
});

app.get("/api/render/list", (req, res) => {
  res.json({ activeRenders: getActiveRenders() });
});

app.delete("/api/render/:renderId", async (req, res) => {
  const { renderId } = req.params;
  await cancelRender(renderId);
  res.json({ success: true, message: "Render canceled" });
});

let remotionBundle = null;
let isBundling = false;

async function initializeRemotionBundle() {
  if (remotionBundle || isBundling) return remotionBundle;
  isBundling = true;
  try {
    const entryPoint = path.resolve(__dirname, "../frontend/remotion.root.tsx");
    remotionBundle = await bundleRemotionProject({ entryPoint });
    console.log("✅ Remotion bundle initialized");
    return remotionBundle;
  } catch (err) {
    console.error("❌ Bundle init error:", err.message);
    remotionBundle = null;
    throw err;
  } finally {
    isBundling = false;
  }
}

const PORT = process.env.PORT || 8000;

async function startServer() {
  try {
    await initializeRemotionBundle();
  } catch {
    console.warn("⚠️ Remotion bundle will be initialized on first render request");
  }

  app.listen(PORT, () => {
    console.log(`🚀 Server listening at ${backendURL}:${PORT}`);
  });
}

startServer();
