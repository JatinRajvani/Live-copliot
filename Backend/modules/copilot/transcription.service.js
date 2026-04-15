import Groq from "groq-sdk";

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

// ── Whisper Initial Prompt ────────────────────────────────────────────────────
// IMPORTANT: Whisper's `prompt` must look like real transcript text, NOT a
// description/list. Whisper uses it to "prime" vocabulary and style.
// Write it as if it's the beginning of the conversation being transcribed.
const WHISPER_PROMPT =
  "My name is Jatin Rajvani. I am currently studying B.Tech at Rai University. " +
  "I live in a hostel, room number 95. I am pursuing my B.Tech degree from CodingGita " +
  "and Rai University. My friends are Rahul and Priya. We are doing a project on placement.";

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
function upsample8kTo16k(pcm8kBuffer) {
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

function muLawToWavBuffer(muLawBuffer) {
  const pcm8k   = muLawToPcm16Buffer(muLawBuffer);  // decode µ-law → 8 kHz PCM
  const pcm16k  = upsample8kTo16k(pcm8k);           // upsample to 16 kHz
  const header  = buildWavHeader(pcm16k.length, OUTPUT_SAMPLE_RATE);
  return Buffer.concat([header, pcm16k]);
}

export async function transcribeTwilioMuLawChunk(muLawBuffer) {
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

  console.log(`🎙️  Sending to Whisper | RMS: ${rms.toFixed(0)} | raw: ${muLawBuffer.length}B → upsampled WAV @ 16kHz`);

  const client = getGroqClient();
  if (!client) {
    console.warn("Skipping transcription: GROQ_API_KEY is missing");
    return "";
  }

  const wavBuffer = muLawToWavBuffer(muLawBuffer); // 8kHz µ-law → 16kHz WAV
  const wavFile   = new File([wavBuffer], "audio.wav", { type: "audio/wav" });

  const response = await client.audio.transcriptions.create({
    file:            wavFile,
    model:           "whisper-large-v3",  // full accuracy model (not turbo)
    language:        "en",
    response_format: "json",
    temperature:     0,
    prompt:          WHISPER_PROMPT,       // accent + domain context
  });

  const text = response?.text?.trim() || "";

  // ── Guard 3: Hallucination filter ────────────────────────────────────────
  // Whisper frequently outputs "Thank you.", "Thanks for watching." etc. on
  // near-silent audio. Drop these known false positives.
  if (isHallucination(text)) {
    console.log(`🚫 Filtered hallucination: "${text}"`);
    return "";
  }

  return text;
}
