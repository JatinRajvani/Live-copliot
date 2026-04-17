import { useRef, useState, useEffect } from "react";
import { io } from "socket.io-client";
import {
  destroyTwilio,
  hangUpActiveCall,
  initDevice,
  makeCall,
  subscribeTwilioEvent,
} from "./twilio";

const BACKEND = import.meta.env.VITE_API_BASE_URL;

function App() {
  // ── Call state ────────────────────────────────────────────────────────────
  const [identity, setIdentity]       = useState("");
  const [callTo, setCallTo]           = useState("");
  const [deviceReady, setDeviceReady] = useState(false);
  const [callStatus, setCallStatus]   = useState("idle"); // idle | calling | in-call

  // ── Transcript state ──────────────────────────────────────────────────────
  const [transcripts, setTranscripts]     = useState([]);
  const [hints, setHints]                 = useState([]);
  const [sessionSummary, setSessionSummary] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const transcriptEndRef = useRef(null);
  const socketRef        = useRef(null);

  // Auto-scroll
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts]);

  // Socket.IO connection
  useEffect(() => {
    const socket = io(BACKEND, {
      transports: ["websocket", "polling"], // polling fallback for mobile browsers
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 4000,
      reconnectionAttempts: Infinity,       // never give up on mobile
    });

    socket.on("connect",    () => setSocketConnected(true));
    socket.on("disconnect", () => setSocketConnected(false));

    socket.on("transcript:chunk", (data) => {
      setTranscripts((prev) => [
        ...prev,
        { ...data, timestamp: new Date().toLocaleTimeString() },
      ]);
    });

    socket.on("copilot:hint", (data) => {
      setHints((prev) => {
        const next = [
          ...prev,
          {
            ...data,
            timestamp: new Date().toLocaleTimeString(),
          },
        ];
        return next.length > 80 ? next.slice(-80) : next;
      });
    });

    socket.on("session:summary", (data) => {
      setSessionSummary(data);
    });

    socketRef.current = socket;
    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    const unsubscribers = [
      subscribeTwilioEvent("device:registered", () => {
        setDeviceReady(true);
      }),
      subscribeTwilioEvent("device:error", (err) => {
        console.error("Twilio device error:", err);
        setCallStatus("idle");
      }),
      subscribeTwilioEvent("call:incoming", () => {
        setCallStatus("in-call");
      }),
      subscribeTwilioEvent("call:accepted", () => {
        setCallStatus("in-call");
      }),
      subscribeTwilioEvent("call:disconnected", () => {
        setCallStatus("idle");
      }),
      subscribeTwilioEvent("call:canceled", () => {
        setCallStatus("idle");
      }),
      subscribeTwilioEvent("call:rejected", () => {
        setCallStatus("idle");
      }),
      subscribeTwilioEvent("call:error", (payload) => {
        console.error("Twilio call error:", payload?.error || payload);
        setCallStatus("idle");
      }),
      subscribeTwilioEvent("device:destroyed", () => {
        setDeviceReady(false);
        setCallStatus("idle");
      }),
    ];

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      void destroyTwilio();
    };
  }, []);

  // ── Twilio helpers ────────────────────────────────────────────────────────
  async function handleInit() {
    if (!identity.trim()) return alert("Enter your name first");

    setDeviceReady(false);
    const initialized = await initDevice(identity);
    if (!initialized) {
      alert("Device initialization failed. Check backend token API.");
    }
  }

  async function handleCall() {
    if (!deviceReady) return alert("Init your device first");
    if (!callTo.trim())     return alert("Enter who to call");

    setCallStatus("calling");
    const call = await makeCall(callTo);
    if (!call) {
      setCallStatus("idle");
    }
  }

  function handleEndCall() {
    hangUpActiveCall();
    setCallStatus("idle");
  }

  async function copyTalkTrack(text) {
    try {
      await navigator.clipboard.writeText(text || "");
    } catch (error) {
      console.error("Failed to copy talk track", error);
    }
  }

  // ── Status label helpers ──────────────────────────────────────────────────
  const statusColor = {
    idle:     "#6b7280",
    calling:  "#d97706",
    "in-call": "#16a34a",
  }[callStatus];

  const statusLabel = {
    idle:     "Idle",
    calling:  "Calling…",
    "in-call": "In Call",
  }[callStatus];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: "24px", fontFamily: "sans-serif", maxWidth: "820px", margin: "0 auto" }}>
      <h2 style={{ marginBottom: "4px" }}>🎙️ Live Copilot</h2>
      <p style={{ fontSize: "12px", color: socketConnected ? "#16a34a" : "#dc2626", marginBottom: "20px" }}>
        ● Socket.IO: {socketConnected ? "Connected" : "Disconnected"}
      </p>

      {/* ── Call Controls ─────────────────────────────────────────────────── */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        flexWrap: "wrap",
        padding: "14px 16px",
        marginBottom: "20px",
        border: "1px solid #e5e7eb",
        borderRadius: "8px",
        backgroundColor: "#f9fafb",
      }}>

        {/* Identity + Init */}
        <input
          id="identity-input"
          placeholder="Your name"
          value={identity}
          onChange={(e) => setIdentity(e.target.value)}
          disabled={deviceReady}
          style={inputStyle}
        />
        <button
          id="init-btn"
          onClick={handleInit}
          disabled={deviceReady}
          style={{ ...btnStyle, backgroundColor: deviceReady ? "#d1fae5" : "#6366f1", color: deviceReady ? "#065f46" : "#fff" }}
        >
          {deviceReady ? "✓ Ready" : "Init"}
        </button>

        <span style={{ color: "#d1d5db" }}>|</span>

        {/* Call To + Call */}
        <input
          id="call-to-input"
          placeholder="Call to (identity)"
          value={callTo}
          onChange={(e) => setCallTo(e.target.value)}
          disabled={!deviceReady || callStatus !== "idle"}
          style={inputStyle}
        />
        <button
          id="call-btn"
          onClick={handleCall}
          disabled={!deviceReady || callStatus !== "idle"}
          style={{ ...btnStyle, backgroundColor: "#16a34a", color: "#fff", opacity: (!deviceReady || callStatus !== "idle") ? 0.5 : 1 }}
        >
          📞 Call
        </button>

        {/* End Call */}
        {callStatus !== "idle" && (
          <button
            id="end-call-btn"
            onClick={handleEndCall}
            style={{ ...btnStyle, backgroundColor: "#dc2626", color: "#fff" }}
          >
            ✕ End Call
          </button>
        )}

        {/* Call status badge */}
        <span style={{ marginLeft: "auto", fontSize: "12px", fontWeight: 600, color: statusColor }}>
          ● {statusLabel}
        </span>
      </div>

      {/* ── Live Transcript ───────────────────────────────────────────────── */}
      <div style={{
        border: "1px solid #d1d5db",
        borderRadius: "8px",
        padding: "16px",
        backgroundColor: "#f9fafb",
        maxHeight: "480px",
        overflowY: "auto",
      }}>
        {transcripts.length === 0 ? (
          <p style={{ color: "#9ca3af", textAlign: "center", marginTop: "40px" }}>
            Waiting for call audio… Transcripts will appear here.
          </p>
        ) : (
          transcripts.map((t, i) => {
            const isCustomer = t.speaker === "customer";
            return (
              <div key={i} style={{
                padding: "10px 12px",
                marginBottom: "8px",
                backgroundColor: "#fff",
                border: "1px solid #e5e7eb",
                borderRadius: "6px",
                borderLeft: `4px solid ${isCustomer ? "#6366f1" : "#10b981"}`,
              }}>
                <div style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  color: isCustomer ? "#6366f1" : "#10b981",
                  marginBottom: "3px",
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                }}>
                  {isCustomer ? "👤 Customer" : "🎧 Agent"}
                </div>
                <div style={{ fontSize: "13px", color: "#374151" }}>{t.text}</div>
                <div style={{ fontSize: "11px", color: "#9ca3af", marginTop: "4px" }}>
                  {t.timestamp}
                </div>
              </div>
            );
          })
        )}
        <div ref={transcriptEndRef} />
      </div>

      {transcripts.length > 0 && (
        <button
          onClick={() => {
            setTranscripts([]);
            setHints([]);
            setSessionSummary(null);
          }}
          style={{ marginTop: "10px", padding: "5px 12px", fontSize: "12px", cursor: "pointer",
            border: "1px solid #d1d5db", borderRadius: "4px", backgroundColor: "#fff" }}
        >
          Clear copilot feed
        </button>
      )}

      {/* ── AI Hints ─────────────────────────────────────────────────────── */}
      <div style={{ marginTop: "22px" }}>
        <h3 style={{ marginBottom: "8px" }}>Live AI Hints</h3>
        <div style={{
          border: "1px solid #d1d5db",
          borderRadius: "8px",
          padding: "16px",
          backgroundColor: "#f9fafb",
          maxHeight: "380px",
          overflowY: "auto",
        }}>
          {hints.length === 0 ? (
            <p style={{ color: "#9ca3af", margin: 0 }}>
              No hints yet. Start talking and AI coaching will appear here.
            </p>
          ) : (
            hints.map((hint, index) => {
              const typeColors = {
                OBJECTION: "#dc2626",
                QUESTION: "#2563eb",
                BUYING_SIGNAL: "#16a34a",
                COACHING: "#ca8a04",
              };

              const borderColor = typeColors[hint.type] || "#6b7280";

              return (
                <div
                  key={`${hint.timestamp}-${index}`}
                  style={{
                    backgroundColor: "#fff",
                    border: "1px solid #e5e7eb",
                    borderLeft: `4px solid ${borderColor}`,
                    borderRadius: "6px",
                    padding: "12px",
                    marginBottom: "10px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                    <span style={{ color: borderColor, fontSize: "11px", fontWeight: 700, letterSpacing: "0.04em" }}>
                      {hint.type}
                    </span>
                    <span style={{ color: "#9ca3af", fontSize: "11px" }}>{hint.timestamp}</span>
                  </div>

                  <div style={{ marginTop: "6px", fontSize: "14px", fontWeight: 600, color: "#111827" }}>
                    {hint.hint}
                  </div>

                  <div style={{ marginTop: "4px", fontSize: "13px", color: "#374151" }}>
                    {hint.detail}
                  </div>

                  <div style={{ marginTop: "10px", fontSize: "11px", fontWeight: 700, color: "#6b7280" }}>
                    SAY THIS
                  </div>
                  <div style={{ marginTop: "4px", padding: "8px", backgroundColor: "#f3f4f6", borderRadius: "6px", fontSize: "13px", color: "#1f2937" }}>
                    {hint.talkTrack}
                  </div>

                  <div style={{ marginTop: "8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "11px", color: "#6b7280" }}>
                      Confidence: {Math.round((hint.confidence || 0) * 100)}%
                    </span>
                    <button
                      onClick={() => copyTalkTrack(hint.talkTrack)}
                      style={{ ...btnStyle, backgroundColor: "#111827", color: "#fff", padding: "5px 10px", fontSize: "11px" }}
                    >
                      Copy
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── Session Summary ──────────────────────────────────────────────── */}
      <div style={{ marginTop: "22px", marginBottom: "20px" }}>
        <h3 style={{ marginBottom: "8px" }}>Post-Session Summary</h3>
        <div style={{ border: "1px solid #d1d5db", borderRadius: "8px", padding: "16px", backgroundColor: "#f9fafb" }}>
          {!sessionSummary ? (
            <p style={{ color: "#9ca3af", margin: 0 }}>Summary appears after the call ends.</p>
          ) : (
            <>
              <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", marginBottom: "10px" }}>
                <span style={badgeStyle}>Sentiment: {sessionSummary.sentiment}</span>
                <span style={badgeStyle}>Deal Probability: {sessionSummary.dealProbability}%</span>
                <span style={badgeStyle}>Rep Score: {sessionSummary.repScore}/10</span>
              </div>

              <div style={{ marginBottom: "10px", color: "#374151", fontSize: "13px" }}>
                {sessionSummary.executiveSummary}
              </div>

              <div style={{ marginBottom: "10px" }}>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#4b5563", marginBottom: "5px" }}>Next Best Action</div>
                <div style={{ fontSize: "13px", color: "#111827" }}>{sessionSummary.nextBestAction}</div>
              </div>

              <div style={{ marginBottom: "10px" }}>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#4b5563", marginBottom: "5px" }}>Action Items</div>
                {(sessionSummary.actionItems || []).map((item, idx) => (
                  <div key={idx} style={{ fontSize: "13px", color: "#374151", marginBottom: "4px" }}>
                    [{(item.priority || "medium").toUpperCase()}] {item.task}
                  </div>
                ))}
              </div>

              <div style={{ marginBottom: "10px" }}>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#4b5563", marginBottom: "5px" }}>Hint Breakdown</div>
                <div style={{ fontSize: "13px", color: "#374151" }}>
                  OBJECTION {sessionSummary?.hintBreakdown?.OBJECTION || 0} | QUESTION {sessionSummary?.hintBreakdown?.QUESTION || 0} | BUYING_SIGNAL {sessionSummary?.hintBreakdown?.BUYING_SIGNAL || 0} | COACHING {sessionSummary?.hintBreakdown?.COACHING || 0}
                </div>
              </div>

              <div>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#4b5563", marginBottom: "5px" }}>Follow-Up Email Draft</div>
                <div style={{ fontSize: "13px", color: "#1f2937", backgroundColor: "#fff", border: "1px solid #e5e7eb", borderRadius: "6px", padding: "10px" }}>
                  {sessionSummary.followUpEmail}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────
const inputStyle = {
  padding: "7px 10px",
  fontSize: "13px",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  outline: "none",
  width: "160px",
};

const btnStyle = {
  padding: "7px 14px",
  fontSize: "13px",
  fontWeight: 600,
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const badgeStyle = {
  fontSize: "12px",
  color: "#111827",
  backgroundColor: "#e5e7eb",
  borderRadius: "999px",
  padding: "5px 10px",
  fontWeight: 600,
};

export default App;