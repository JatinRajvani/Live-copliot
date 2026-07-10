import "dotenv/config";
import express from "express";
import cors from "cors";
import twilio from "twilio";
import jwt from "jsonwebtoken";
import http from "http";
import { WebSocketServer } from "ws";
import { Server as SocketIOServer } from "socket.io";
import { transcribeTwilioMuLawChunk } from "./modules/copilot/transcription.service.js";
import { generateRealtimeHint } from "./modules/copilot/hint.service.js";
import { generateSessionSummary } from "./modules/copilot/summary.service.js";
import { getUserFromTokenClaims, loginUser, registerUser } from "./modules/auth/auth.service.js";

const rawAllowedOrigins = process.env.ALLOWED_ORIGINS || "http://localhost:5173";

if (!process.env.ALLOWED_ORIGINS) {
  console.warn("ALLOWED_ORIGINS is not set. Falling back to http://localhost:5173");
}

const allowedOrigins = rawAllowedOrigins
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

function normalizeOrigin(origin) {
  return origin.replace(/\/$/, "");
}

function isAllowedOrigin(origin) {
  return !!origin && allowedOrigins.includes(normalizeOrigin(origin));
}

const app = express();
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin not allowed"));
    },
    credentials: true,
    methods: ["GET", "POST"],
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);

function getRequestProtocol(req) {
  const forwardedProto = req.headers["x-forwarded-proto"]?.toString().split(",")[0]?.trim();
  return forwardedProto || req.protocol || "http";
}

function buildExternalRequestUrl(req) {
  const protocol = getRequestProtocol(req);
  const host = req.get("host");
  return `${protocol}://${host}${req.originalUrl}`;
}

function toUrlEncodedFormBody(body) {
  const params = new URLSearchParams();

  if (!body || typeof body !== "object") {
    return params;
  }

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) {
      continue;
    }
    params.append(key, value.toString());
  }

  return params;
}

function verifyTwilioWebhookRequest(req) {
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN?.toString().trim();
  if (!twilioAuthToken) {
    console.error("TWILIO_AUTH_TOKEN is required for webhook signature validation");
    return false;
  }

  const signature = req.headers["x-twilio-signature"]?.toString().trim() || "";
  if (!signature) {
    return false;
  }

  const webhookUrl = buildExternalRequestUrl(req);
  const formParams = Object.fromEntries(toUrlEncodedFormBody(req.body));

  return twilio.validateRequest(twilioAuthToken, signature, webhookUrl, formParams);
}

function getMediaStreamSecretFromUrl(rawUrl) {
  const parsedUrl = new URL(rawUrl || "/", "http://localhost");
  return parsedUrl.searchParams.get("secret")?.toString().trim() || "";
}

function normalizeMediaStreamSecret(secret) {
  return secret?.toString().trim().replace(/ /g, "+") || "";
}

function extractMediaStreamSecretFromStartPayload(startPayload) {
  const customParameters = startPayload?.customParameters || {};
  const candidate =
    customParameters.secret ||
    customParameters.SECRET ||
    customParameters.streamSecret ||
    customParameters.streamsecret;

  return normalizeMediaStreamSecret(candidate);
}

function isAllowedMediaEvent(message) {
  return ["connected", "start", "media", "stop"].includes(message?.event);
}

function isValidMediaMessage(message) {
  if (!message || typeof message !== "object" || !isAllowedMediaEvent(message)) {
    return false;
  }

  switch (message.event) {
    case "connected":
      return true;
    case "start":
      return !!(message.start?.streamSid || message.streamSid);
    case "media": {
      const streamSid = message.streamSid;
      const payload = message.media?.payload;
      const track = message.media?.track;
      const isTrackValid = !track || ["inbound", "outbound"].includes(track);

      if (!streamSid || !payload || !isTrackValid) {
        return false;
      }

      const isBase64Payload = /^[A-Za-z0-9+/=]+$/.test(payload);
      return isBase64Payload;
    }
    case "stop":
      return !!(message.streamSid || message.stop?.streamSid);
    default:
      return false;
  }
}

// 🔌 Socket.IO for Real-Time Transcript Streaming
const io = new SocketIOServer(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (!origin || isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback("Origin not allowed", false);
  },
});

io.on("connection", (socket) => {
  console.log("✅ Frontend connected via Socket.IO", socket.id);

  socket.on("join:identity", (payload) => {
    const identity = payload?.identity?.toString().trim().toLowerCase();
    if (!identity) {
      return;
    }

    const roomName = roomNameForIdentity(identity);
    socket.join(roomName);
    console.log("Socket joined identity room", { socketId: socket.id, roomName });
  });

  socket.on("leave:identity", (payload) => {
    const identity = payload?.identity?.toString().trim().toLowerCase();
    if (!identity) {
      return;
    }

    const roomName = roomNameForIdentity(identity);
    socket.leave(roomName);
    console.log("Socket left identity room", { socketId: socket.id, roomName });
  });

  socket.on("disconnect", () => {
    console.log("❌ Frontend disconnected", socket.id);
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const parsedUrl = new URL(request.url || "/", "http://localhost");
  if (parsedUrl.pathname === "/media-stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
    return;
  }
  // Other paths (like /socket.io/) are ignored by ws and picked up by Socket.IO
});

// ── VAD (Voice Activity Detection) Constants ──────────────────────────────────
// Industry approach: compute RMS on every incoming µ-law packet.
// When the speaker goes silent (RMS drops below threshold), fire a debounce timer.
// After SILENCE_DEBOUNCE_MS of silence → flush the buffer to Whisper immediately.
// This produces tight, sentence-level transcription instead of blind 4-second windows.
//
// RMS scale for 8-kHz µ-law: ~0–32767. Speech typically >300, silence <150.
const SPEECH_RMS_THRESHOLD  = 280;   // RMS above this = speaking
const SILENCE_RMS_THRESHOLD = 180;   // RMS below this (with hysteresis) = silence
const SILENCE_DEBOUNCE_MS   = 600;   // flush 600 ms after last speech packet
const MAX_UTTERANCE_MS      = 14000; // safety: force-flush after 14 s of speech
const MIN_FLUSH_BYTES       = 3200;  // ~400 ms of 8-kHz audio — skip shorter clips
const STT_STABILIZATION_MS  = Number(process.env.STT_STABILIZATION_MS || 350); // wait before STT to merge trailing packets
const STABLE_TRANSCRIPT_DEDUP_MS = Number(process.env.STABLE_TRANSCRIPT_DEDUP_MS || 1200);
const MIN_TRANSCRIPT_CHARS = Number(process.env.MIN_TRANSCRIPT_CHARS || 3);
const ENABLE_TRANSCRIPT_QUALITY_GATE = (process.env.ENABLE_TRANSCRIPT_QUALITY_GATE || "true").toLowerCase() !== "false";

const TRANSCRIPT_CORRECTIONS = [
  { from: /\byatin\b/gi, to: "Jatin" },
  { from: /\byapin\b/gi, to: "Jatin" },
  { from: /\braul\b/gi, to: "Rahul" },
  { from: /\bexxon\b/gi, to: "Nexon" },
  { from: /\bexon\b/gi, to: "Nexon" },
  { from: /\bnixon\b/gi, to: "Nexon" },
  { from: /\btexon\b/gi, to: "Nexon" },
  { from: /\bherrier\b/gi, to: "Harrier" },
  { from: /\bhairier\b/gi, to: "Harrier" },
  { from: /\bbarrier\b/gi, to: "Harrier" },
  { from: /\bhead\s+what\s+to\s+do\b/gi, to: "Harrier" },
  { from: /\bsting\s+voice\s+systems\s+pro\b/gi, to: "VoiceStream Pro" },
  { from: /\bvoice\s*stream\s*pro\b/gi, to: "VoiceStream Pro" },
  { from: /\bvoice\s*sync\b/gi, to: "voice" },
  { from: /\becna\s+voice\s+system\b/gi, to: "Acme Voice Systems" },
  { from: /\becmo\s+oil\s+systems\b/gi, to: "Acme Voice Systems" },
];

const REJECTED_TRANSCRIPT_PATTERNS = [
  /^\W+$/,
  /^\d+(\s+\d+){0,1}$/,
  /^thanks for watching\.?$/i,
  /^thank you for watching\.?$/i,
  /^you for watching\.?$/i,
  /^you for (?:today|help|the help)\.?$/i,
  /^this line is punctuation test only\.?$/i,
  /^voice\s*stream\s*pro\.?$/i,
];

const agentIdentities = (process.env.AGENT_IDENTITIES || "")
  .split(",")
  .map((identity) => identity.trim().toLowerCase())
  .filter(Boolean);

const callRoleProfiles = new Map(); // callSid -> { initiatorRole, from, to, direction }
const streamToCallSid = new Map();  // streamSid -> callSid
const streamAudienceRooms = new Map(); // streamSid -> [identity room names]
const copilotSessions = new Map();   // streamSid -> { conversation: [], hints: [] }
const sessionSummaryLocks = new Set();

function roomNameForIdentity(identity) {
  return `identity:${identity.toLowerCase().trim()}`;
}

function getOrCreateCopilotSession(streamSid) {
  if (!copilotSessions.has(streamSid)) {
    copilotSessions.set(streamSid, {
      conversation: [],
      hints: [],
    });
  }
  return copilotSessions.get(streamSid);
}

async function emitSessionSummaryForStream(streamSid, reason) {
  if (!streamSid || sessionSummaryLocks.has(streamSid)) {
    return;
  }

  sessionSummaryLocks.add(streamSid);
  const session = getOrCreateCopilotSession(streamSid);

  try {
    const summary = await generateSessionSummary({
      conversation: session.conversation,
      hints: session.hints,
    });

    emitToStreamAudience(streamSid, "session:summary", {
      streamSid,
      reason,
      ...summary,
      transcriptLines: session.conversation.length,
      hintsGenerated: session.hints.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to emit session summary", { streamSid, error: error?.message || error });
  } finally {
    copilotSessions.delete(streamSid);
    streamAudienceRooms.delete(streamSid);
    setTimeout(() => {
      sessionSummaryLocks.delete(streamSid);
    }, 10 * 60 * 1000);
  }
}

// Inline µ-law → PCM decoder (avoids importing from transcription service)
function decodeMuLawByte(b) {
  const BIAS = 0x84;
  const mu   = ~b & 0xff;
  const sign = mu & 0x80;
  const exp  = (mu >> 4) & 0x07;
  const mant = mu & 0x0f;
  let sample = ((mant << 4) + 0x08) << exp;
  sample -= BIAS;
  return sign ? -sample : sample;
}

function muLawPayloadRMS(base64Payload) {
  const buf = Buffer.from(base64Payload, "base64");
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    const s = decodeMuLawByte(buf[i]);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / buf.length);
}

function parseClientIdentity(rawEndpoint) {
  const endpoint = rawEndpoint?.toString().trim() || "";
  if (!endpoint) return "";
  return endpoint.startsWith("client:") ? endpoint.slice(7) : endpoint;
}

function getAudienceRoomsForCall(callSid) {
  const profile = callSid ? callRoleProfiles.get(callSid) : null;
  if (!profile) {
    return [];
  }

  const fromIdentity = parseClientIdentity(profile.from).toLowerCase();
  const toIdentity = parseClientIdentity(profile.to).toLowerCase();
  const identities = new Set();

  if (fromIdentity) {
    identities.add(fromIdentity);
  }

  if (toIdentity) {
    identities.add(toIdentity);
  }

  return Array.from(identities).map(roomNameForIdentity);
}

function emitToStreamAudience(streamSid, eventName, payload) {
  const audienceRooms = streamAudienceRooms.get(streamSid) || [];
  if (audienceRooms.length === 0) {
    console.warn("Skipping emit: no audience rooms mapped", { streamSid, eventName });
    return;
  }

  for (const roomName of audienceRooms) {
    io.to(roomName).emit(eventName, payload);
  }
}

function inferInitiatorRole({ from, to, direction }) {
  const normalizedDirection = (direction || "").toLowerCase();
  const fromIdentity = parseClientIdentity(from).toLowerCase();
  const toIdentity = parseClientIdentity(to).toLowerCase();

  if (fromIdentity && agentIdentities.includes(fromIdentity)) {
    return "agent";
  }

  if (toIdentity && agentIdentities.includes(toIdentity)) {
    return "customer";
  }

  if (normalizedDirection.startsWith("outbound")) {
    return "agent";
  }

  if (normalizedDirection.startsWith("inbound")) {
    return "customer";
  }

  return "unknown";
}

function resolveSpeakerForTrack(callSid, track) {
  const profile = callSid ? callRoleProfiles.get(callSid) : null;
  const normalizedTrack = track === "outbound" ? "outbound" : "inbound";

  if (!profile || profile.initiatorRole === "unknown") {
    // Backward-compatible fallback: outbound sales model.
    return normalizedTrack === "inbound" ? "agent" : "customer";
  }

  const initiatorSpeaker = profile.initiatorRole;
  const receiverSpeaker = initiatorSpeaker === "agent" ? "customer" : "agent";
  return normalizedTrack === "inbound" ? initiatorSpeaker : receiverSpeaker;
}

const streamStates = new Map();

function getOrCreateStreamState(trackKey, streamSid, speaker) {
  if (!streamStates.has(trackKey)) {
    streamStates.set(trackKey, {
      chunks: [],
      bytes: 0,
      packetCount: 0,
      isTranscribing: false,
      streamSid,            // original Twilio streamSid
      speaker,              // "customer" (inbound) | "agent" (outbound)
      // VAD state
      isSpeaking: false,
      silenceTimer: null,
      maxTimer: null,
      sttStabilizeTimer: null,
      lastStableTextKey: "",
      lastStableAt: 0,
    });
  }
  return streamStates.get(trackKey);
}

function normalizeTranscriptText(text) {
  return (text || "")
    .toString()
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeForDedup(text) {
  return normalizeTranscriptText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

function shouldAcceptStableTranscript(state, transcriptText) {
  const dedupKey = normalizeForDedup(transcriptText);
  if (!dedupKey) {
    return { accepted: false, reason: "empty-normalized" };
  }

  const now = Date.now();
  const isRecentDuplicate =
    dedupKey === state.lastStableTextKey &&
    now - state.lastStableAt < STABLE_TRANSCRIPT_DEDUP_MS;

  if (isRecentDuplicate) {
    return { accepted: false, reason: "duplicate-stable-window", dedupKey };
  }

  state.lastStableTextKey = dedupKey;
  state.lastStableAt = now;
  return { accepted: true, dedupKey };
}

function applyDeterministicCorrections(transcriptText) {
  let corrected = normalizeTranscriptText(transcriptText);

  for (const rule of TRANSCRIPT_CORRECTIONS) {
    corrected = corrected.replace(rule.from, rule.to);
  }

  return corrected;
}

function evaluateTranscriptQuality(transcriptText) {
  const text = normalizeTranscriptText(transcriptText);

  if (!ENABLE_TRANSCRIPT_QUALITY_GATE) {
    return { accepted: true, text };
  }

  if (!text) {
    return { accepted: false, reason: "empty" };
  }

  if (text.length < MIN_TRANSCRIPT_CHARS) {
    return { accepted: false, reason: `too-short:${text.length}` };
  }

  // Single short token utterances are usually unstable artifacts in call audio.
  const tokenCount = text.split(/\s+/).filter(Boolean).length;
  if (tokenCount === 1 && text.length <= 4) {
    return { accepted: false, reason: `single-short-token:${text}` };
  }

  for (const pattern of REJECTED_TRANSCRIPT_PATTERNS) {
    if (pattern.test(text)) {
      return { accepted: false, reason: `pattern-rejected:${pattern}` };
    }
  }

  return { accepted: true, text };
}

function logTranscriptStage(stage, payload) {
  const entry = {
    ts: new Date().toISOString(),
    stage,
    ...payload,
  };
  console.log(`[TRANSCRIPT:${stage}]`, entry);
}

const NUMBER_WORDS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

const MONTH_INDEX = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

const ORDINAL_WORDS = {
  first: "01",
  second: "02",
  third: "03",
  fourth: "04",
  fifth: "05",
  sixth: "06",
  seventh: "07",
  eighth: "08",
  ninth: "09",
  tenth: "10",
  eleventh: "11",
  twelfth: "12",
  thirteenth: "13",
  fourteenth: "14",
  fifteenth: "15",
  sixteenth: "16",
  seventeenth: "17",
  eighteenth: "18",
  nineteenth: "19",
  twentieth: "20",
  twentyfirst: "21",
  twentysecond: "22",
  twentythird: "23",
  twentyfourth: "24",
  twentyfifth: "25",
  twentysixth: "26",
  twentyseventh: "27",
  twentyeighth: "28",
  twentyninth: "29",
  thirtieth: "30",
  thirtyfirst: "31",
};

function wordToNumberToken(token) {
  const normalized = token?.toLowerCase().trim() || "";
  if (!normalized) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, normalized)) {
    return String(NUMBER_WORDS[normalized]);
  }

  if (/^\d+$/.test(normalized)) {
    return normalized;
  }

  return null;
}

function normalizeSpokenId(rawId) {
  return (rawId || "")
    .toUpperCase()
    .replace(/ZED/gi, "Z")
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeSpokenDateTime(text) {
  const match = text.match(/\b(twenty\s+fifth|[a-z]+)\s+([a-z]+)\s+twenty\s+twenty\s+(six|seven|eight|nine)\b(?:\s+at\s+(\d{1,2}:\d{2}\s*(?:am|pm)?))?/i);
  if (!match) {
    return null;
  }

  const ordinalToken = match[1].toLowerCase().replace(/\s+/g, "");
  const monthToken = match[2].toLowerCase();
  const yearTailToken = match[3].toLowerCase();
  const timeToken = match[4] ? match[4].toUpperCase().replace(/\s+/g, "") : "";

  const day = ORDINAL_WORDS[ordinalToken] || null;
  const month = MONTH_INDEX[monthToken] || null;
  const yearTail = wordToNumberToken(yearTailToken);

  if (!day || !month || yearTail === null) {
    return null;
  }

  const year = `20${yearTail.padStart(2, "0")}`;
  return {
    source: match[0],
    normalized: `${day}/${month}/${year}${timeToken ? ` ${timeToken}` : ""}`,
  };
}

function normalizeCriticalEntitiesForAi(inputText) {
  let normalizedText = normalizeTranscriptText(inputText);
  const entities = {
    orderIds: [],
    pricesInr: [],
    versions: [],
    dateTimes: [],
    longNumbers: [],
  };

  const orderIdMatch = normalizedText.match(/\b(?:backup\s+|pickup\s+)?order\s*(?:id|number)?\s*(?:is|:)\s*([a-z0-9\s-]{6,})\b/i);
  if (orderIdMatch) {
    const rawOrderId = normalizeSpokenId(orderIdMatch[1]);
    if (rawOrderId.length >= 6) {
      entities.orderIds.push(rawOrderId);
      normalizedText = normalizedText.replace(orderIdMatch[1], rawOrderId);
    }
  }

  const priceMatch = normalizedText.match(/\b(\d{1,3}(?:,\d{3})+|\d+)\s*(?:rupees|rs\.?|inr)\b/i);
  if (priceMatch) {
    const value = priceMatch[1].replace(/,/g, "");
    entities.pricesInr.push(value);
    normalizedText = normalizedText.replace(priceMatch[0], `INR ${value}`);
  }

  const spokenVersion = normalizedText.match(/\b([a-z0-9]+)\s+point\s+([a-z0-9]+)\s+point\s+([a-z0-9]+)\b/i);
  if (spokenVersion) {
    const major = wordToNumberToken(spokenVersion[1]);
    const minor = wordToNumberToken(spokenVersion[2]);
    const patch = wordToNumberToken(spokenVersion[3]);
    if (major !== null && minor !== null && patch !== null) {
      const normalizedVersion = `${major}.${minor}.${patch}`;
      entities.versions.push(normalizedVersion);
      normalizedText = normalizedText.replace(spokenVersion[0], normalizedVersion);
    }
  }

  const numericVersion = normalizedText.match(/\b\d+(?:\.\d+){2,}\b/);
  if (numericVersion) {
    entities.versions.push(numericVersion[0]);
  }

  const splitNumericVersion = normalizedText.match(/\b(\d+)\s+(\d+\.\d+)\b/);
  if (splitNumericVersion) {
    const normalizedVersion = `${splitNumericVersion[1]}.${splitNumericVersion[2]}`;
    entities.versions.push(normalizedVersion);
    normalizedText = normalizedText.replace(splitNumericVersion[0], normalizedVersion);
  }

  const dateTimeMatch = normalizedText.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b(?:\s+at\s+\d{1,2}:\d{2}\s*(?:am|pm)?)?/i);
  if (dateTimeMatch) {
    entities.dateTimes.push(dateTimeMatch[0]);
  }

  const spokenDateTime = normalizeSpokenDateTime(normalizedText);
  if (spokenDateTime) {
    entities.dateTimes.push(spokenDateTime.normalized);
    normalizedText = normalizedText.replace(spokenDateTime.source, spokenDateTime.normalized);
  }

  const longNumberMatches = normalizedText.match(/\b\d{8,}\b/g) || [];
  if (longNumberMatches.length) {
    entities.longNumbers.push(...longNumberMatches);
  }

  return {
    normalizedText,
    entities,
  };
}

// ── Flush & Transcribe ────────────────────────────────────────────────────────
function scheduleSttFlush(trackKey, reason, delayMs = STT_STABILIZATION_MS) {
  const state = streamStates.get(trackKey);
  if (!state) return;

  clearTimeout(state.sttStabilizeTimer);
  state.sttStabilizeTimer = setTimeout(() => {
    const latest = streamStates.get(trackKey);
    if (latest) {
      latest.sttStabilizeTimer = null;
    }
    console.log(`🧊 STT stabilize flush (${reason}) [${state.speaker}] — delay ${delayMs}ms`);
    void flushTranscriptionWindow(trackKey);
  }, Math.max(0, delayMs));
}

async function flushTranscriptionWindow(trackKey) {
  const state = streamStates.get(trackKey);
  if (!state || state.isTranscribing) return;

  if (state.chunks.length === 0 || state.bytes < MIN_FLUSH_BYTES) {
    state.chunks = [];
    state.bytes  = 0;
    state.packetCount = 0;
    return;
  }

  state.isTranscribing = true;
  const audioBuffer = Buffer.concat(state.chunks);
  const packetCount = state.packetCount;
  const byteLength  = state.bytes;
  const speaker     = state.speaker;  // ← "customer" | "agent"

  state.chunks = [];
  state.bytes  = 0;
  state.packetCount = 0;

  try {
    const transcriptTextRaw = await transcribeTwilioMuLawChunk(audioBuffer);
    if (transcriptTextRaw) {
      logTranscriptStage("RAW", {
        streamSid: state.streamSid,
        trackKey,
        speaker,
        packetCount,
        byteLength,
        text: transcriptTextRaw,
      });

      const stability = shouldAcceptStableTranscript(state, transcriptTextRaw);
      if (!stability.accepted) {
        logTranscriptStage("DROPPED_STABLE", {
          streamSid: state.streamSid,
          trackKey,
          speaker,
          reason: stability.reason,
          text: transcriptTextRaw,
        });
        return;
      }

      const correctedTranscript = applyDeterministicCorrections(transcriptTextRaw);
      logTranscriptStage("CORRECTED", {
        streamSid: state.streamSid,
        trackKey,
        speaker,
        text: correctedTranscript,
      });

      const quality = evaluateTranscriptQuality(correctedTranscript);
      if (!quality.accepted) {
        logTranscriptStage("DROPPED_QUALITY", {
          streamSid: state.streamSid,
          trackKey,
          speaker,
          reason: quality.reason,
          text: correctedTranscript,
        });
        return;
      }

      const aiInputText = quality.text;
      logTranscriptStage("AI_INPUT", {
        streamSid: state.streamSid,
        trackKey,
        speaker,
        text: aiInputText,
      });

      const entityValidation = normalizeCriticalEntitiesForAi(aiInputText);
      logTranscriptStage("ENTITY_VALIDATION", {
        streamSid: state.streamSid,
        trackKey,
        speaker,
        text: entityValidation.normalizedText,
        entities: entityValidation.entities,
      });

      const transcriptData = {
        streamSid: state.streamSid,
        trackKey,
        speaker,              // ← frontend uses this to colour-code the bubble
        packetCount,
        byteLength,
        text: aiInputText,
      };

      const session = getOrCreateCopilotSession(state.streamSid);
      session.conversation.push({
        speaker,
        text: aiInputText,
        timestamp: Date.now(),
      });

      if (session.conversation.length > 250) {
        session.conversation = session.conversation.slice(-250);
      }

      console.log(`📝 [${speaker}]:`, aiInputText);
      emitToStreamAudience(state.streamSid, "transcript:chunk", transcriptData);

      const hint = await generateRealtimeHint({
        latestText: entityValidation.normalizedText,
        conversation: session.conversation,
        entityContext: entityValidation.entities,
      });

      if (hint) {
        logTranscriptStage("AI_OUTPUT", {
          streamSid: state.streamSid,
          trackKey,
          speaker,
          hint,
        });

        const hintData = {
          streamSid: state.streamSid,
          speaker,
          ...hint,
          timestamp: new Date().toISOString(),
        };

        session.hints.push(hintData);
        if (session.hints.length > 100) {
          session.hints = session.hints.slice(-100);
        }

        emitToStreamAudience(state.streamSid, "copilot:hint", hintData);
      }
    }
  } catch (error) {
    console.error("Transcription flush failed", { trackKey, error: error?.message || error });
  } finally {
    state.isTranscribing = false;
  }
}

// Called by VAD debounce and max-utterance timer
function vadFlush(trackKey, reason) {
  const state = streamStates.get(trackKey);
  if (!state) return;

  // Clear all VAD timers
  clearTimeout(state.silenceTimer);
  clearTimeout(state.maxTimer);
  state.silenceTimer = null;
  state.maxTimer     = null;
  state.isSpeaking   = false;

  console.log(`🔊→🤫 VAD flush (${reason}) [${state.speaker}] — ${state.bytes} bytes buffered`);
  const stabilizationDelay = reason === "stream-end" ? 0 : STT_STABILIZATION_MS;
  scheduleSttFlush(trackKey, reason, stabilizationDelay);
}

function cleanupStreamState(trackKey) {
  const state = streamStates.get(trackKey);
  if (!state) return;
  clearTimeout(state.silenceTimer);
  clearTimeout(state.maxTimer);
  clearTimeout(state.sttStabilizeTimer);
  streamStates.delete(trackKey);
}

// Flush both track buffers for a given streamSid
function flushAllTracks(streamSid) {
  vadFlush(`${streamSid}-inbound`,  "stream-end");
  vadFlush(`${streamSid}-outbound`, "stream-end");
}

function scheduleSessionSummary(streamSid, reason) {
  // Give VAD-triggered transcription flushes a short window to complete,
  // then generate summary from the finalized conversation/hint buffers.
  setTimeout(() => {
    void emitSessionSummaryForStream(streamSid, reason);
  }, 450 + STT_STABILIZATION_MS);
}

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const tokenRateLimitStore = new Map();

const TOKEN_RATE_LIMIT_WINDOW_MS = Number(process.env.TOKEN_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const TOKEN_RATE_LIMIT_MAX = Number(process.env.TOKEN_RATE_LIMIT_MAX || 30);

function sanitizeIdentity(rawIdentity) {
  const candidate = rawIdentity?.toString().trim().toLowerCase() || "";
  if (!candidate) {
    return "";
  }

  return candidate.replace(/[^a-z0-9_.@-]/g, "").slice(0, 120);
}

function extractBearerToken(authHeader) {
  const value = authHeader?.toString().trim() || "";
  if (!value.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return value.slice(7).trim();
}

function extractTokenFromRequest(req) {
  return extractBearerToken(req.headers.authorization);
}

function extractIdentityFromClaims(claims) {
  const candidate =
    claims?.twilio_identity ||
    claims?.identity ||
    claims?.preferred_username ||
    claims?.email ||
    claims?.sub;

  return sanitizeIdentity(candidate);
}

function getRequesterIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim();
  return forwardedFor || req.ip || req.socket?.remoteAddress || "unknown";
}

function enforceTokenRateLimit(req, res, next) {
  const now = Date.now();
  const ip = getRequesterIp(req);
  const authSubject = req.authClaims?.sub || req.authClaims?.email || "anonymous";
  const key = `${ip}:${authSubject}`;

  const current = tokenRateLimitStore.get(key);
  if (!current || now - current.windowStart >= TOKEN_RATE_LIMIT_WINDOW_MS) {
    tokenRateLimitStore.set(key, { windowStart: now, count: 1 });
    return next();
  }

  current.count += 1;
  if (current.count > TOKEN_RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: "Too many token requests. Please retry later.",
      retryAfterMs: Math.max(0, current.windowStart + TOKEN_RATE_LIMIT_WINDOW_MS - now),
    });
  }

  return next();
}

async function requireTokenAuth(req, res, next) {
  const secret = process.env.JWT_SECRET?.toString().trim();
  if (!secret) {
    return res.status(500).json({ error: "JWT server secret is not configured" });
  }

  const bearerToken = extractTokenFromRequest(req);
  if (!bearerToken) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  try {
    const claims = jwt.verify(bearerToken, secret, {
      algorithms: ["HS256"],
    });

    const authenticatedUser = await getUserFromTokenClaims(claims);
    if (!authenticatedUser) {
      return res.status(401).json({ error: "Authenticated user not found or inactive" });
    }

    req.authClaims = claims;
    req.authUser = authenticatedUser;
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of tokenRateLimitStore.entries()) {
    if (now - value.windowStart >= TOKEN_RATE_LIMIT_WINDOW_MS) {
      tokenRateLimitStore.delete(key);
    }
  }
}, Math.min(TOKEN_RATE_LIMIT_WINDOW_MS, 60 * 1000)).unref();

// 🔑 TOKEN API

app.get('/health',(req, res) => {
  res.send('API is healthy');
});

app.post("/auth/signup", async (req, res) => {
  try {
    const result = await registerUser({
      name: req.body?.name,
      email: req.body?.email,
      password: req.body?.password,
      identity: req.body?.identity,
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    return res.status(result.status).json({
      token: result.token,
      user: result.user,
    });
  } catch (error) {
    console.error("Signup failed", error?.message || error);
    return res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const result = await loginUser({
      email: req.body?.email,
      password: req.body?.password,
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    return res.status(result.status).json({
      token: result.token,
      user: result.user,
    });
  } catch (error) {
    console.error("Login failed", error?.message || error);
    return res.status(500).json({ error: "Login failed" });
  }
});

app.get("/auth/me", requireTokenAuth, (req, res) => {
  return res.json({ user: req.authUser });
});

app.post("/auth/logout", (_req, res) => {
  return res.status(204).send();
});

app.get("/token", requireTokenAuth, enforceTokenRateLimit, (req, res) => {
  const identityFromToken = extractIdentityFromClaims(req.authClaims);
  if (!identityFromToken) {
    return res.status(403).json({ error: "No valid identity claim found in auth token" });
  }

  const requestedIdentity = sanitizeIdentity(req.query.identity);
  if (requestedIdentity && requestedIdentity !== identityFromToken) {
    return res.status(403).json({
      error: "Requested identity does not match authenticated identity",
    });
  }

  if (
    !process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_API_KEY ||
    !process.env.TWILIO_API_SECRET ||
    !process.env.TWILIO_TWIML_APP_SID
  ) {
    return res.status(500).json({ error: "Twilio credentials are not fully configured" });
  }

  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY,
    process.env.TWILIO_API_SECRET,
    { identity: identityFromToken }
  );

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
    incomingAllow: true,
  });

  token.addGrant(voiceGrant);

  res.json({ token: token.toJwt(), identity: identityFromToken });
});

// 📞 CALL HANDLER (TwiML)
app.post("/voice", (req, res) => {
  if (!verifyTwilioWebhookRequest(req)) {
    return res.status(403).send("Invalid Twilio signature");
  }

  const to = req.body.To?.toString().trim();
  const callSid = req.body.CallSid?.toString().trim() || "";
  const from = req.body.From?.toString().trim() || "";
  const direction = req.body.Direction?.toString().trim() || "";

  if (!to) {
    return res.status(400).send("Missing 'To' parameter");
  }

  if (callSid) {
    const initiatorRole = inferInitiatorRole({ from, to, direction });
    callRoleProfiles.set(callSid, { initiatorRole, from, to, direction });
    console.log("Call role profiled", { callSid, initiatorRole, from, to, direction });
  }

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const baseMediaStreamUrl = process.env.TWILIO_MEDIA_STREAM_URL?.toString().trim();
  const mediaStreamSecret = normalizeMediaStreamSecret(process.env.TWILIO_MEDIA_STREAM_SECRET);
  const mediaStreamUrl = baseMediaStreamUrl;

  if (!mediaStreamUrl || !mediaStreamSecret) {
    console.warn("Media stream URL or secret missing; live transcript streaming is disabled for this call");
  }

  if (mediaStreamUrl) {
    // Start streaming call audio to backend while preserving the existing dial flow.
    const start = response.start();
    const stream = start.stream({
      url: mediaStreamUrl,
      track: "both_tracks",
    });

    if (mediaStreamSecret) {
      stream.parameter({
        name: "secret",
        value: mediaStreamSecret,
      });
    }
  }

  const dial = response.dial();
  dial.client(to);

  res.type("text/xml");
  res.send(response.toString());
});

wss.on("connection", (socket, request) => {
  console.log("Twilio media WebSocket connected", {
    path: request.url,
    remoteAddress: request.socket.remoteAddress,
  });

  let streamSid = null;
  let mediaPacketCount = 0;

  socket.on("message", (rawMessage) => {
    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch (error) {
      console.error("Invalid media stream message JSON", error);
      return;
    }

    if (!isValidMediaMessage(message)) {
      console.warn("Rejecting invalid Twilio media message", {
        event: message?.event,
        streamSid,
      });
      socket.close(1008, "Invalid media message");
      return;
    }

    switch (message.event) {
      case "connected": {
        console.log("Media stream transport connected", {
          protocol: message.protocol || null,
          version: message.version || null,
        });
        break;
      }
      case "start": {
        const expectedSecret = normalizeMediaStreamSecret(process.env.TWILIO_MEDIA_STREAM_SECRET);
        const providedSecret = extractMediaStreamSecretFromStartPayload(message.start);

        if (!expectedSecret || providedSecret !== expectedSecret) {
          console.warn("Rejected media stream start due to invalid secret", {
            streamSid,
            hasExpectedSecret: !!expectedSecret,
            providedSecretLength: providedSecret.length,
          });
          socket.close(1008, "Invalid stream secret");
          return;
        }

        streamSid = message.start?.streamSid || message.streamSid || null;
        const callSid = message.start?.callSid || null;
        if (streamSid && callSid) {
          streamToCallSid.set(streamSid, callSid);
        }

        const mappedCallSid = callSid || (streamSid ? streamToCallSid.get(streamSid) : null);
        if (streamSid) {
          streamAudienceRooms.set(streamSid, getAudienceRoomsForCall(mappedCallSid));

          // Pre-create both track states so VAD is ready before any packets arrive
          getOrCreateStreamState(
            `${streamSid}-inbound`,
            streamSid,
            resolveSpeakerForTrack(mappedCallSid, "inbound")
          );
          getOrCreateStreamState(
            `${streamSid}-outbound`,
            streamSid,
            resolveSpeakerForTrack(mappedCallSid, "outbound")
          );
        }
        console.log("Media stream started", {
          streamSid,
          callSid,
        });
        break;
      }
      case "media": {
        mediaPacketCount += 1;

        const rawSid  = message.streamSid || streamSid;
        const payload = message.media?.payload;
        const track   = message.media?.track || "inbound";

        // Each track gets its OWN buffer + VAD state.
        // Key = "<streamSid>-<track>" → "MZ123-inbound" / "MZ123-outbound"
        const trackKey = `${rawSid}-${track}`;

        const mappedCallSid = rawSid ? streamToCallSid.get(rawSid) : null;
        const speaker = resolveSpeakerForTrack(mappedCallSid, track);

        if (mediaPacketCount === 1) {
          console.log(`🔍 First packet — track: "${track}" → key: ${trackKey} → speaker: ${speaker}`);
        }

        if (!rawSid || !payload) break;

        const state = getOrCreateStreamState(trackKey, rawSid, speaker);
        state.speaker = speaker;

        // VAD: compute RMS on this packet
        const rms = muLawPayloadRMS(payload);

        const chunkBuf = Buffer.from(payload, "base64");
        state.chunks.push(chunkBuf);
        state.bytes       += chunkBuf.length;
        state.packetCount += 1;

        if (rms >= SPEECH_RMS_THRESHOLD) {
          clearTimeout(state.sttStabilizeTimer);
          state.sttStabilizeTimer = null;

          if (!state.isSpeaking) {
            state.isSpeaking = true;
            console.log(`🗣️  [${speaker}] Speech start (RMS: ${rms.toFixed(0)})`);

            state.maxTimer = setTimeout(() => {
              vadFlush(trackKey, "max-utterance");
            }, MAX_UTTERANCE_MS);
          }

          clearTimeout(state.silenceTimer);
          state.silenceTimer = setTimeout(() => {
            vadFlush(trackKey, "silence-debounce");
          }, SILENCE_DEBOUNCE_MS);

        } else if (rms < SILENCE_RMS_THRESHOLD && !state.isSpeaking) {
          // Drop leading silence
          state.chunks.pop();
          state.bytes       -= chunkBuf.length;
          state.packetCount -= 1;
        }


        break;
      }
      case "stop": {
        const rawSid = message.streamSid || streamSid;
        if (rawSid) {
          const mappedCallSid = streamToCallSid.get(rawSid);
          if (mappedCallSid) {
            streamToCallSid.delete(rawSid);
            callRoleProfiles.delete(mappedCallSid);
          }

          flushAllTracks(rawSid);
          scheduleSessionSummary(rawSid, "stream-stop");
          setTimeout(() => {
            cleanupStreamState(`${rawSid}-inbound`);
            cleanupStreamState(`${rawSid}-outbound`);
          }, 100 + STT_STABILIZATION_MS);
        }
        console.log("Media stream stopped", { streamSid, mediaPacketCount });
        break;
      }
      default: {
        console.log("Unhandled media stream event", {
          event: message.event,
          streamSid,
        });
      }
    }
  });

  socket.on("close", () => {
    if (streamSid) {
      const mappedCallSid = streamToCallSid.get(streamSid);
      if (mappedCallSid) {
        streamToCallSid.delete(streamSid);
        callRoleProfiles.delete(mappedCallSid);
      }
      flushAllTracks(streamSid);
      scheduleSessionSummary(streamSid, "socket-close");
    }
    console.log("Twilio media WebSocket disconnected", { streamSid, mediaPacketCount });
  });

  socket.on("error", (error) => {
    console.error("Twilio media WebSocket error", error);
  });
});

server.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});