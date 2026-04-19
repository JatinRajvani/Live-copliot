import Groq from "groq-sdk";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

// Twilio sends 8 kHz µ-law. We upsample to 16 kHz before sending to Whisper
// because Whisper is trained on 16 kHz audio — giving it 8 kHz causes it to
// mis-hear phonemes, especially in accented speech.
const INPUT_SAMPLE_RATE  = 8000;  // Twilio µ-law native rate
const OUTPUT_SAMPLE_RATE = 16000; // Whisper expected rate
const NUM_CHANNELS       = 1;
const BITS_PER_SAMPLE    = 16;

// ── Thresholds ────────────────────────────────────────────────────────────────
// µ-law PCM RMS > 300 = speech. Below = silence/background noise → skip Whisper.
const SILENCE_RMS_THRESHOLD = 300;

// Minimum raw µ-law bytes before sending to Whisper (~400 ms at 8 kHz).
// Checked BEFORE upsampling so the byte count stays consistent.
const MIN_PACKET_BYTES = 3200;
const ENABLE_FFMPEG_UPSAMPLE = (process.env.COPILOT_USE_FFMPEG_UPSAMPLE || "true").toLowerCase() !== "false";
const STT_PROVIDER = (process.env.COPILOT_STT_PROVIDER || "groq").toLowerCase().trim();
const STT_MODEL = process.env.COPILOT_STT_MODEL?.toString().trim() || "whisper-large-v3";
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL?.toString().trim() || "nova-2";
const DEEPGRAM_SMART_FORMAT = (process.env.DEEPGRAM_SMART_FORMAT || "true").toLowerCase() !== "false";
const DEEPGRAM_PUNCTUATE = (process.env.DEEPGRAM_PUNCTUATE || "true").toLowerCase() !== "false";
const DEEPGRAM_FALLBACK_TO_GROQ = (process.env.DEEPGRAM_FALLBACK_TO_GROQ || "true").toLowerCase() !== "false";
let hasLoggedSttConfig = false;

// ── Whisper Prompt/Language Configuration ─────────────────────────────────────
// Keep prompt neutral and domain-driven via env; avoid hardcoded personal text.
const WHISPER_PROMPT = process.env.COPILOT_STT_PROMPT?.toString().trim() || "";
// Use auto-detection by default. Set COPILOT_STT_LANGUAGE=en/hi/etc. to force one.
const WHISPER_LANGUAGE = process.env.COPILOT_STT_LANGUAGE?.toString().trim() || "";

// ── Hallucination Filter ──────────────────────────────────────────────────────
// Whisper hallucinates these phrases on low-quality/silent phone audio.
// "Subtitles by the Amara.org community" is one of the most common ones.
const HALLUCINATION_PATTERNS = [
  // Transcript/subtitle service hallucinations (very common on phone audio)
  /amara\.org/i,
  /subtitles by/i,
  /subscribed/i,
  /mooc-subtitles/i,
  /www\.[a-z0-9-]+\.[a-z]{2,}/i,      // any URL pattern

  // Generic Whisper silence hallucinations
  /^thank you\.?$/i,
  /^thanks\.?$/i,
  /^thanks for watching\.?$/i,
  /^thank you for watching\.?$/i,
  /^please subscribe\.?$/i,
  /^like and subscribe\.?$/i,
  /^you\.?$/i,
  /^\s*$/,

  // Non-speech Whisper tags
  /^\[.+\]$/,                          // e.g. "[music]", "[silence]", "[applause]"
  /^\(.+\)$/,                          // e.g. "(silence)", "(music)"

  // Single character / punctuation only
  /^[^a-z0-9]{0,3}$/i,
];

let groqClient = null;

function getGroqClient() {
  if (groqClient) {
    return groqClient;
  }

  const groqApiKey = process.env.GROQ_API_KEY?.toString().trim();
  if (!groqApiKey) {
    return null;
  }

  groqClient = new Groq({ apiKey: groqApiKey });
  return groqClient;
}

function decodeMuLawSample(muLawByte) {
  const MULAW_BIAS = 0x84;
  const mu = ~muLawByte & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;

  let sample = ((mantissa << 4) + 0x08) << exponent;
  sample -= MULAW_BIAS;

  return sign ? -sample : sample;
}

/**
 * Calculate the Root Mean Square energy of a µ-law buffer.
 * Returns a value roughly in the range 0–32767.
 */
function calculateRMS(muLawBuffer) {
  let sumSquares = 0;
  for (let i = 0; i < muLawBuffer.length; i++) {
    const sample = decodeMuLawSample(muLawBuffer[i]);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / muLawBuffer.length);
}

/**
 * Returns true if the text looks like a Whisper hallucination on silence.
 */
function isHallucination(text) {
  return HALLUCINATION_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

function muLawToPcm16Buffer(muLawBuffer) {
  const pcmBuffer = Buffer.alloc(muLawBuffer.length * 2);

  for (let i = 0; i < muLawBuffer.length; i += 1) {
    const pcmSample = decodeMuLawSample(muLawBuffer[i]);
    pcmBuffer.writeInt16LE(pcmSample, i * 2);
  }

  return pcmBuffer;
}

/**
 * Upsample a 16-bit PCM buffer from 8 kHz to 16 kHz using linear interpolation.
 * This doubles the buffer length. Whisper is trained on 16 kHz audio, so this
 * significantly improves phoneme recognition accuracy.
 */
function upsample8kTo16kLinear(pcm8kBuffer) {
  const sampleCount = pcm8kBuffer.length / 2; // 16-bit samples
  const out = Buffer.alloc(sampleCount * 4);  // 2× samples × 2 bytes each

  for (let i = 0; i < sampleCount; i++) {
    const cur  = pcm8kBuffer.readInt16LE(i * 2);
    const next = i + 1 < sampleCount ? pcm8kBuffer.readInt16LE((i + 1) * 2) : cur;
    const interp = Math.round((cur + next) / 2); // midpoint interpolation

    out.writeInt16LE(cur,    i * 4);     // original sample
    out.writeInt16LE(interp, i * 4 + 2); // interpolated sample between cur & next
  }

  return out;
}

function upsample8kTo16kFFmpeg(pcm8kBuffer) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg-static binary not found"));
      return;
    }

    const ffmpeg = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(INPUT_SAMPLE_RATE),
      "-ac",
      String(NUM_CHANNELS),
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ar",
      String(OUTPUT_SAMPLE_RATE),
      "-ac",
      String(NUM_CHANNELS),
      "pipe:1",
    ]);

    const stdoutChunks = [];
    const stderrChunks = [];

    ffmpeg.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    ffmpeg.on("error", (error) => reject(error));
    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrText}`));
        return;
      }

      resolve(Buffer.concat(stdoutChunks));
    });

    ffmpeg.stdin.end(pcm8kBuffer);
  });
}

async function upsample8kTo16k(pcm8kBuffer) {
  if (!ENABLE_FFMPEG_UPSAMPLE) {
    return upsample8kTo16kLinear(pcm8kBuffer);
  }

  try {
    return await upsample8kTo16kFFmpeg(pcm8kBuffer);
  } catch (error) {
    console.warn(`FFmpeg upsampling failed, falling back to linear interpolation: ${error.message}`);
    return upsample8kTo16kLinear(pcm8kBuffer);
  }
}

export async function upsamplePcm16From8kTo16k(pcm8kBuffer) {
  if (!Buffer.isBuffer(pcm8kBuffer)) {
    throw new TypeError("Expected a Buffer containing 16-bit PCM samples");
  }

  return upsample8kTo16k(pcm8kBuffer);
}

function buildWavHeader(dataLength, sampleRate) {
  const blockAlign = (NUM_CHANNELS * BITS_PER_SAMPLE) / 8;
  const byteRate   = sampleRate * blockAlign;
  const wavHeader  = Buffer.alloc(44);

  wavHeader.write("RIFF", 0);
  wavHeader.writeUInt32LE(36 + dataLength, 4);
  wavHeader.write("WAVE", 8);
  wavHeader.write("fmt ", 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(NUM_CHANNELS, 22);
  wavHeader.writeUInt32LE(sampleRate, 24); // ← dynamic now
  wavHeader.writeUInt32LE(byteRate, 28);
  wavHeader.writeUInt16LE(blockAlign, 32);
  wavHeader.writeUInt16LE(BITS_PER_SAMPLE, 34);
  wavHeader.write("data", 36);
  wavHeader.writeUInt32LE(dataLength, 40);

  return wavHeader;
}

async function muLawToWavBuffer(muLawBuffer) {
  const pcm8k   = muLawToPcm16Buffer(muLawBuffer);  // decode µ-law → 8 kHz PCM
  const pcm16k  = await upsample8kTo16k(pcm8k);     // upsample to 16 kHz
  const header  = buildWavHeader(pcm16k.length, OUTPUT_SAMPLE_RATE);
  return Buffer.concat([header, pcm16k]);
}

async function transcribeWithGroq(wavBuffer) {
  const client = getGroqClient();
  if (!client) {
    console.warn("Skipping Groq transcription: GROQ_API_KEY is missing");
    return "";
  }

  const wavFile = new File([wavBuffer], "audio.wav", { type: "audio/wav" });
  const requestPayload = {
    file: wavFile,
    model: STT_MODEL,
    response_format: "json",
    temperature: 0,
  };

  if (WHISPER_LANGUAGE) {
    requestPayload.language = WHISPER_LANGUAGE;
  }

  if (WHISPER_PROMPT) {
    requestPayload.prompt = WHISPER_PROMPT;
  }

  const response = await client.audio.transcriptions.create(requestPayload);
  return response?.text?.trim() || "";
}

function buildDeepgramUrl() {
  const query = new URLSearchParams();
  query.set("model", DEEPGRAM_MODEL);
  query.set("smart_format", DEEPGRAM_SMART_FORMAT ? "true" : "false");
  query.set("punctuate", DEEPGRAM_PUNCTUATE ? "true" : "false");

  if (WHISPER_LANGUAGE) {
    query.set("language", WHISPER_LANGUAGE);
  }

  return `https://api.deepgram.com/v1/listen?${query.toString()}`;
}

async function transcribeWithDeepgram(wavBuffer) {
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY?.toString().trim();
  if (!deepgramApiKey) {
    console.warn("Skipping Deepgram transcription: DEEPGRAM_API_KEY is missing");
    return "";
  }

  const response = await fetch(buildDeepgramUrl(), {
    method: "POST",
    headers: {
      Authorization: `Token ${deepgramApiKey}`,
      "Content-Type": "audio/wav",
    },
    body: wavBuffer,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Deepgram request failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  return payload?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.toString().trim() || "";
}

function logSttConfigOnce() {
  if (hasLoggedSttConfig) {
    return;
  }

  const providerModel = STT_PROVIDER === "deepgram" ? DEEPGRAM_MODEL : STT_MODEL;
  console.log("[STT] Active configuration", {
    provider: STT_PROVIDER,
    model: providerModel,
    language: WHISPER_LANGUAGE || "auto",
    ffmpegUpsample: ENABLE_FFMPEG_UPSAMPLE,
    deepgramFallbackToGroq: STT_PROVIDER === "deepgram" ? DEEPGRAM_FALLBACK_TO_GROQ : false,
  });

  hasLoggedSttConfig = true;
}

export async function transcribeTwilioMuLawChunk(muLawBuffer) {
  logSttConfigOnce();

  if (!muLawBuffer || muLawBuffer.length === 0) {
    return "";
  }

  // ── Guard 1: Minimum audio length ────────────────────────────────────────
  // Sending tiny buffers (< ~400 ms) to Whisper almost always produces garbage.
  if (muLawBuffer.length < MIN_PACKET_BYTES) {
    console.log(
      `⏭️  Skipping chunk — too short (${muLawBuffer.length} bytes < ${MIN_PACKET_BYTES} min)`
    );
    return "";
  }

  // ── Guard 2: RMS silence detection ───────────────────────────────────────
  // Skip the Whisper API call entirely when the chunk is silence/background.
  const rms = calculateRMS(muLawBuffer);
  if (rms < SILENCE_RMS_THRESHOLD) {
    console.log(
      `🔇 Skipping silent chunk (RMS: ${rms.toFixed(0)} < ${SILENCE_RMS_THRESHOLD} threshold)`
    );
    return "";
  }

  console.log(`🎙️  Sending to ${STT_PROVIDER} STT | RMS: ${rms.toFixed(0)} | raw: ${muLawBuffer.length}B → upsampled WAV @ 16kHz`);

  const wavBuffer = await muLawToWavBuffer(muLawBuffer); // 8kHz µ-law → 16kHz WAV
  let text = "";

  try {
    if (STT_PROVIDER === "deepgram") {
      text = await transcribeWithDeepgram(wavBuffer);
      if (!text && DEEPGRAM_FALLBACK_TO_GROQ) {
        text = await transcribeWithGroq(wavBuffer);
      }
    } else {
      text = await transcribeWithGroq(wavBuffer);
    }
  } catch (error) {
    console.error("Primary STT provider failed", error?.message || error);

    if (STT_PROVIDER === "deepgram" && DEEPGRAM_FALLBACK_TO_GROQ) {
      text = await transcribeWithGroq(wavBuffer);
    } else {
      return "";
    }
  }

  // ── Guard 3: Hallucination filter ────────────────────────────────────────
  // Whisper frequently outputs "Thank you.", "Thanks for watching." etc. on
  // near-silent audio. Drop these known false positives.
  if (isHallucination(text)) {
    console.log(`🚫 Filtered hallucination: "${text}"`);
    return "";
  }

  return text;
}
