import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const TRANSCRIPTION_SAMPLE_SECONDS = 60;
export const TRANSCRIPTION_AUDIO_LIMIT = 2 * 1024 * 1024;

// Extract original audio, never the rendered/censored/music-mixed output.
export async function transcriptionAudio(filename) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", filename], { timeout: 15000 });
  const duration = Number(JSON.parse(stdout).format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Source duration could not be determined.");
  const { stdout: audio } = await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", filename, "-map", "0:a:0",
    "-vn", "-af", "aresample=async=1:first_pts=0", "-t", String(TRANSCRIPTION_SAMPLE_SECONDS), "-ac", "1", "-ar", "16000",
    "-c:a", "pcm_s16le", "-f", "wav", "pipe:1",
  ], { timeout: 30000, maxBuffer: TRANSCRIPTION_AUDIO_LIMIT, encoding: "buffer" });
  if (audio.length <= 44 || audio.length > TRANSCRIPTION_AUDIO_LIMIT) throw new Error("Source audio sample is invalid.");
  // A pipe is not seekable: repair FFmpeg's unknown RIFF/data sizes before
  // uploading this now-complete buffer to an external WAV decoder.
  audio.writeUInt32LE(audio.length - 8, 4);
  let offset = 12, dataSize = 0;
  while (offset + 8 <= audio.length) {
    const size = audio.readUInt32LE(offset + 4);
    if (audio.toString("ascii", offset, offset + 4) === "data") {
      dataSize = audio.length - offset - 8;
      audio.writeUInt32LE(dataSize, offset + 4);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!dataSize) throw new Error("Source audio sample contains no PCM data.");
  return { audio, sourceDuration: duration, sampleDuration: dataSize / 32000, complete: duration <= TRANSCRIPTION_SAMPLE_SECONDS };
}
