import { useRef, useState, useEffect } from "react";
import { io } from "socket.io-client";
import { Device } from "@twilio/voice-sdk";

const BACKEND = import.meta.env.VITE_API_BASE_URL;

function App() {
  // ── Call state ────────────────────────────────────────────────────────────
  const [identity, setIdentity]       = useState("");
  const [callTo, setCallTo]           = useState("");
  const [deviceReady, setDeviceReady] = useState(false);
  const [callStatus, setCallStatus]   = useState("idle"); // idle | calling | in-call
  const deviceRef   = useRef(null);
  const activeCall  = useRef(null);

  // ── Transcript state ──────────────────────────────────────────────────────
  const [transcripts, setTranscripts]     = useState([]);
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

    socketRef.current = socket;
    return () => socket.disconnect();
  }, []);

  // ── Twilio helpers ────────────────────────────────────────────────────────
  async function handleInit() {
    if (!identity.trim()) return alert("Enter your name first");

    const res  = await fetch(`${BACKEND}/token?identity=${encodeURIComponent(identity)}`);
    const data = await res.json();

    const device = new Device(data.token);

    device.on("registered", () => {
      console.log("✅ Twilio device registered");
      setDeviceReady(true);
    });

    device.on("incoming", (call) => {
      console.log("📞 Incoming call from", call.parameters.From);
      activeCall.current = call;
      setCallStatus("in-call");
      call.accept();

      call.on("disconnect", () => {
        activeCall.current = null;
        setCallStatus("idle");
      });
    });

    device.on("error", (err) => console.error("Twilio device error:", err));

    await device.register();
    deviceRef.current = device;
  }

  async function handleCall() {
    if (!deviceRef.current) return alert("Init your device first");
    if (!callTo.trim())     return alert("Enter who to call");

    setCallStatus("calling");
    const call = await deviceRef.current.connect({ params: { To: callTo } });
    activeCall.current = call;

    call.on("accept",     () => setCallStatus("in-call"));
    call.on("disconnect", () => { activeCall.current = null; setCallStatus("idle"); });
    call.on("cancel",     () => { activeCall.current = null; setCallStatus("idle"); });
    call.on("error",      (err) => { console.error(err); setCallStatus("idle"); });
  }

  function handleEndCall() {
    if (activeCall.current) {
      activeCall.current.disconnect();
      activeCall.current = null;
    }
    setCallStatus("idle");
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
          onClick={() => setTranscripts([])}
          style={{ marginTop: "10px", padding: "5px 12px", fontSize: "12px", cursor: "pointer",
            border: "1px solid #d1d5db", borderRadius: "4px", backgroundColor: "#fff" }}
        >
          Clear transcripts
        </button>
      )}
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

export default App;