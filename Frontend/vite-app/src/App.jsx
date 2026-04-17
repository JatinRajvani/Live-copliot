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
const AUTH_STORAGE_KEY = "aisiAuthToken";

function App() {
  // ── Auth state ────────────────────────────────────────────────────────────
  const [authMode, setAuthMode] = useState("login"); // login | signup
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");

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
  const joinedIdentityRef = useRef(null);

  // Auto-scroll
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts]);

  function readAuthToken() {
    try {
      return window.localStorage.getItem(AUTH_STORAGE_KEY)?.trim() || "";
    } catch {
      return "";
    }
  }

  function persistAuthToken(token) {
    try {
      window.localStorage.setItem(AUTH_STORAGE_KEY, token);
      window.localStorage.setItem("authToken", token);
    } catch (error) {
      console.error("Unable to save auth token", error);
    }
  }

  function clearAuthToken() {
    try {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
      window.localStorage.removeItem("authToken");
    } catch (error) {
      console.error("Unable to clear auth token", error);
    }
  }

  async function fetchAuthMe(token) {
    const response = await fetch(`${BACKEND}/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      return { ok: false };
    }

    const payload = await response.json();
    return { ok: true, user: payload.user };
  }

  useEffect(() => {
    async function bootstrapAuth() {
      const token = readAuthToken();
      if (!token) {
        setAuthLoading(false);
        return;
      }

      const result = await fetchAuthMe(token);
      if (!result.ok || !result.user) {
        clearAuthToken();
        setAuthLoading(false);
        return;
      }

      setAuthUser(result.user);
      setIdentity(result.user.identity || "");
      setAuthLoading(false);
    }

    void bootstrapAuth();
  }, []);

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
    return () => {
      if (joinedIdentityRef.current) {
        socket.emit("leave:identity", { identity: joinedIdentityRef.current });
      }
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !socketConnected) {
      return;
    }

    const normalizedIdentity = identity.trim().toLowerCase();

    if (!deviceReady || !normalizedIdentity) {
      if (joinedIdentityRef.current) {
        socket.emit("leave:identity", { identity: joinedIdentityRef.current });
        joinedIdentityRef.current = null;
      }
      return;
    }

    if (joinedIdentityRef.current === normalizedIdentity) {
      return;
    }

    if (joinedIdentityRef.current) {
      socket.emit("leave:identity", { identity: joinedIdentityRef.current });
    }

    socket.emit("join:identity", { identity: normalizedIdentity });
    joinedIdentityRef.current = normalizedIdentity;
  }, [socketConnected, deviceReady, identity]);

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

  async function submitAuth(endpoint) {
    setAuthBusy(true);
    setAuthError("");

    try {
      const payload =
        endpoint === "signup"
          ? {
              name: authForm.name,
              email: authForm.email,
              password: authForm.password,
            }
          : {
              email: authForm.email,
              password: authForm.password,
            };

      const response = await fetch(`${BACKEND}/auth/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setAuthError(body?.error || "Authentication failed");
        return;
      }

      if (!body?.token || !body?.user) {
        setAuthError("Invalid auth response from server");
        return;
      }

      persistAuthToken(body.token);
      setAuthUser(body.user);
      setIdentity(body.user.identity || "");
      setAuthForm((prev) => ({ ...prev, password: "" }));
      setAuthMode("login");
    } catch (error) {
      setAuthError("Unable to reach auth server");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignup(e) {
    e.preventDefault();
    if (!authForm.name.trim()) {
      setAuthError("Name is required");
      return;
    }
    if (!authForm.email.trim()) {
      setAuthError("Email is required");
      return;
    }
    if (authForm.password.length < 8) {
      setAuthError("Password must be at least 8 characters");
      return;
    }
    await submitAuth("signup");
  }

  async function handleLogin(e) {
    e.preventDefault();
    if (!authForm.email.trim() || !authForm.password) {
      setAuthError("Email and password are required");
      return;
    }
    await submitAuth("login");
  }

  async function handleLogout() {
    clearAuthToken();
    setAuthUser(null);
    setIdentity("");
    setDeviceReady(false);
    setCallStatus("idle");
    setTranscripts([]);
    setHints([]);
    setSessionSummary(null);
    await destroyTwilio();
  }

  // ── Twilio helpers ────────────────────────────────────────────────────────
  async function handleInit() {
    if (!authUser?.identity) {
      alert("Please login first");
      return;
    }

    setDeviceReady(false);
    const result = await initDevice(authUser.identity);
    if (!result?.ok) {
      alert("Device initialization failed. Please login again and retry.");
      return;
    }

    if (result.identity) {
      setIdentity(result.identity);
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

      <div style={{
        padding: "14px 16px",
        marginBottom: "20px",
        border: "1px solid #e5e7eb",
        borderRadius: "8px",
        backgroundColor: "#f9fafb",
      }}>
        <h3 style={{ marginTop: 0, marginBottom: "10px" }}>Account Access</h3>

        {authLoading ? (
          <p style={{ margin: 0, color: "#6b7280", fontSize: "13px" }}>Checking active session...</p>
        ) : authUser ? (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "13px", color: "#111827" }}>
              Signed in as <strong>{authUser.name}</strong> ({authUser.email})
            </span>
            <span style={{ fontSize: "12px", color: "#4b5563" }}>Identity: {authUser.identity}</span>
            <button
              onClick={handleLogout}
              style={{ ...btnStyle, backgroundColor: "#111827", color: "#fff", padding: "6px 12px" }}
            >
              Logout
            </button>
          </div>
        ) : (
          <form onSubmit={authMode === "signup" ? handleSignup : handleLogin} style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            {authMode === "signup" && (
              <input
                placeholder="Full name"
                value={authForm.name}
                onChange={(e) => setAuthForm((prev) => ({ ...prev, name: e.target.value }))}
                style={inputStyle}
              />
            )}
            <input
              placeholder="Email"
              type="email"
              value={authForm.email}
              onChange={(e) => setAuthForm((prev) => ({ ...prev, email: e.target.value }))}
              style={inputStyle}
            />
            <input
              placeholder="Password"
              type="password"
              value={authForm.password}
              onChange={(e) => setAuthForm((prev) => ({ ...prev, password: e.target.value }))}
              style={inputStyle}
            />
            <button
              type="submit"
              disabled={authBusy}
              style={{ ...btnStyle, backgroundColor: "#2563eb", color: "#fff" }}
            >
              {authBusy ? "Please wait..." : authMode === "signup" ? "Create account" : "Login"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthError("");
                setAuthMode((prev) => (prev === "signup" ? "login" : "signup"));
              }}
              style={{ ...btnStyle, backgroundColor: "#fff", color: "#111827", border: "1px solid #d1d5db" }}
            >
              {authMode === "signup" ? "Have an account? Login" : "New user? Sign up"}
            </button>
            {authError && (
              <div style={{ width: "100%", fontSize: "12px", color: "#dc2626" }}>{authError}</div>
            )}
          </form>
        )}
      </div>

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
          placeholder="Identity"
          value={identity}
          onChange={(e) => setIdentity(e.target.value)}
          disabled={true}
          style={inputStyle}
        />
        <button
          id="init-btn"
          onClick={handleInit}
          disabled={deviceReady || !authUser}
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