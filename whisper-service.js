const { execFile } = require("child_process");
const fs = require("fs-extra");
const path = require("path");

const WHISPER_EXECUTABLE = path.resolve(__dirname, "model", "whisper-cli.exe");
const WHISPER_MODEL = path.resolve(__dirname, "model", "ggml-tiny.bin");

function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = "ffmpeg";
    const args = [
      "-i",
      inputPath,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-y",
      outputPath,
    ];
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ FFmpeg error:", stderr);
        reject(new Error(stderr));
      } else {
        console.log("✓ Conversion complete");
        resolve(true);
      }
    });
  });
}

async function transcribeWithWhisper(inputFile, language, outputPrefix) {
  return new Promise((resolve, reject) => {
    const args = [
      "-f",
      inputFile,
      "-m",
      WHISPER_MODEL,
      "-l",
      "auto",
      "-osrt",
      "-ovtt",
      "-of",
      outputPrefix,
    ];

    console.log(`🎤 Running whisper.cpp with language: ${language}`);
    console.log(`Command: ${WHISPER_EXECUTABLE} ${args.join(" ")}`);

    const child = execFile(
      WHISPER_EXECUTABLE,
      args,
      { timeout: 300000, cwd: "." },
      async (error, stdout, stderr) => {
        if (error) {
          console.error("❌ Whisper.cpp error:", stderr || stdout || error.message);
          console.error("   Return code:", error.code);
          reject(error);
          return;
        }

        if (stdout) {
          console.log(`Whisper output: ${stdout.substring(0, 500)}`);
        }

        const srtPath = `${outputPrefix}.srt`;
        const vttPath = `${outputPrefix}.vtt`;

        const srtExists = await fs.pathExists(srtPath);
        const vttExists = await fs.pathExists(vttPath);

        console.log(`SRT exists: ${srtExists}, VTT exists: ${vttExists}`);

        let srtText = null;
        let vttText = null;

        if (srtExists) {
          srtText = await fs.readFile(srtPath, "utf-8");
          // Normalize line endings
          srtText = srtText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          console.log(`✓ SRT generated (${srtText.length} chars)`);

          // Debug SRT format
          console.log("First 500 chars of SRT:");
          console.log(srtText.substring(0, 500));
          console.log("\nChecking SRT format:");
          console.log("Has double newlines:", srtText.includes("\n\n"));
          console.log("Has -->:", srtText.includes(" --> "));

          const blocks = srtText.trim().split("\n\n");
          console.log("Number of blocks:", blocks.length);

          if (blocks.length > 0) {
            console.log("First block structure:");
            const firstBlock = blocks[0];
            const firstBlockLines = firstBlock.split("\n");
            console.log(`  Line count: ${firstBlockLines.length}`);
            firstBlockLines.forEach((line, i) => console.log(`  [${i}]: "${line}"`));
          }
        }

        if (vttExists) {
          vttText = await fs.readFile(vttPath, "utf-8");
          // Normalize line endings
          vttText = vttText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          console.log(`✓ VTT generated (${vttText.length} chars)`);

          // Debug VTT format
          console.log("First 500 chars of VTT:");
          console.log(vttText.substring(0, 500));
          console.log("\nChecking VTT format:");
          console.log("Starts with WEBVTT:", vttText.startsWith("WEBVTT"));
          console.log("Has -->:", vttText.includes(" --> "));

          const lines = vttText.split("\n");
          console.log("Total lines:", lines.length);
          console.log("First 10 lines:");
          lines.slice(0, 10).forEach((line, i) => console.log(`  [${i}]: "${line}"`));
        }

        resolve({ srtText, vttText });
      }
    );
  });
}

module.exports = {
  convertToWav,
  transcribeWithWhisper,
  WHISPER_EXECUTABLE,
  WHISPER_MODEL,
};
