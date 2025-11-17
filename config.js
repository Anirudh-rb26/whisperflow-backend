const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Paths
const WHISPER_EXECUTABLE = path.resolve(__dirname, "model", "whisper-cli.exe");
const WHISPER_MODEL = path.resolve(__dirname, "model", "ggml-tiny.bin");

// Check FFmpeg availability
function checkFfmpegAvailable() {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Check Perplexity availability
function checkPerplexityAvailable() {
  return !!process.env.PERPLEXITY_API_KEY;
}

const FFMPEG_AVAILABLE = checkFfmpegAvailable();
const PERPLEXITY_AVAILABLE = checkPerplexityAvailable();

module.exports = {
  WHISPER_EXECUTABLE,
  WHISPER_MODEL,
  FFMPEG_AVAILABLE,
  PERPLEXITY_AVAILABLE,
};
