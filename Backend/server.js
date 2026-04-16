import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import twilio from "twilio";
import http from "http";
import { WebSocketServer } from "ws";
import { Server as SocketIOServer } from "socket.io";
import { transcribeTwilioMuLawChunk } from "./modules/copilot/transcription.service.js";

dotenv.config();

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
    methods: ["GET", "POST"],
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);

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

  socket.on("disconnect", () => {
    console.log("❌ Frontend disconnected", socket.id);
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url.startsWith("/media-stream")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
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

const agentIdentities = (process.env.AGENT_IDENTITIES || "")
  .split(",")
  .map((identity) => identity.trim().toLowerCase())
  .filter(Boolean);

const callRoleProfiles = new Map(); // callSid -> { initiatorRole, from, to, direction }
const streamToCallSid = new Map();  // streamSid -> callSid

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
    });
  }
  return streamStates.get(trackKey);
}

// ── Flush & Transcribe ────────────────────────────────────────────────────────
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
    const transcriptText = await transcribeTwilioMuLawChunk(audioBuffer);
    if (transcriptText) {
      const transcriptData = {
        streamSid: state.streamSid,
        trackKey,
        speaker,              // ← frontend uses this to colour-code the bubble
        packetCount,
        byteLength,
        text: transcriptText,
      };
      console.log(`📝 [${speaker}]:`, transcriptText);
      io.emit("transcript:chunk", transcriptData);
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
  void flushTranscriptionWindow(trackKey);
}

function cleanupStreamState(trackKey) {
  const state = streamStates.get(trackKey);
  if (!state) return;
  clearTimeout(state.silenceTimer);
  clearTimeout(state.maxTimer);
  streamStates.delete(trackKey);
}

// Flush both track buffers for a given streamSid
function flushAllTracks(streamSid) {
  vadFlush(`${streamSid}-inbound`,  "stream-end");
  vadFlush(`${streamSid}-outbound`, "stream-end");
}

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

// 🔑 TOKEN API

app.get('/health',(req, res) => {
  res.send('API is healthy');
});

app.get("/token", (req, res) => {
  const identity = req.query.identity?.toString().trim();

  if (!identity) {
    return res.status(400).json({ error: "identity query param is required" });
  }

  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY,
    process.env.TWILIO_API_SECRET,
    { identity }
  );

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
    incomingAllow: true,
  });

  token.addGrant(voiceGrant);

  res.json({ token: token.toJwt() });
});

// 📞 CALL HANDLER (TwiML)
app.post("/voice", (req, res) => {
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

  const mediaStreamUrl = process.env.TWILIO_MEDIA_STREAM_URL?.toString().trim();
  if (mediaStreamUrl) {
    // Start streaming call audio to backend while preserving the existing dial flow.
    const start = response.start();
    start.stream({
      url: mediaStreamUrl,
      track: "both_tracks",
    });
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

    switch (message.event) {
      case "connected": {
        console.log("Media stream transport connected", {
          protocol: message.protocol || null,
          version: message.version || null,
        });
        break;
      }
      case "start": {
        streamSid = message.start?.streamSid || message.streamSid || null;
        const callSid = message.start?.callSid || null;
        if (streamSid && callSid) {
          streamToCallSid.set(streamSid, callSid);
        }

        const mappedCallSid = callSid || (streamSid ? streamToCallSid.get(streamSid) : null);
        if (streamSid) {
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
          setTimeout(() => {
            cleanupStreamState(`${rawSid}-inbound`);
            cleanupStreamState(`${rawSid}-outbound`);
          }, 100);
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