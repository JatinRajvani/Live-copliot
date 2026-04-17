import { Device } from "@twilio/voice-sdk";

let device = null;
let activeCall = null;
const listeners = new Map();
const CALL_HANDLER_KEY = "__copilotHandlersAttached";

const emit = (eventName, payload) => {
  const handlers = listeners.get(eventName);
  if (!handlers) return;
  handlers.forEach((handler) => {
    try {
      handler(payload);
    } catch (error) {
      console.error(`Twilio listener failed for ${eventName}:`, error);
    }
  });
};

export const subscribeTwilioEvent = (eventName, handler) => {
  if (!listeners.has(eventName)) {
    listeners.set(eventName, new Set());
  }

  listeners.get(eventName).add(handler);

  return () => {
    const handlers = listeners.get(eventName);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) {
      listeners.delete(eventName);
    }
  };
};

const attachCallDebugHandlers = (call, direction) => {
  if (call[CALL_HANDLER_KEY]) {
    return;
  }

  call[CALL_HANDLER_KEY] = true;

  const prefix = `[${direction}]`;
  let lastVolumeLog = 0;

  call.on("accept", () => {
    console.log(`${prefix} call accepted`);
    emit("call:accepted", { direction, call });
  });

  call.on("disconnect", () => {
    console.log(`${prefix} call disconnected`);
    if (activeCall === call) {
      activeCall = null;
    }
    emit("call:disconnected", { direction, call });
  });

  call.on("cancel", () => {
    console.log(`${prefix} call canceled`);
    if (activeCall === call) {
      activeCall = null;
    }
    emit("call:canceled", { direction, call });
  });

  call.on("reject", () => {
    console.log(`${prefix} call rejected`);
    if (activeCall === call) {
      activeCall = null;
    }
    emit("call:rejected", { direction, call });
  });

  call.on("error", (err) => {
    console.error(`${prefix} call error:`, err);
    emit("call:error", { direction, call, error: err });
  });

  call.on("volume", (inputVolume, outputVolume) => {
    emit("call:volume", { direction, call, inputVolume, outputVolume });
    const now = Date.now();

    // Limit logs so console stays readable while still showing live audio activity.
    if (now - lastVolumeLog >= 1000) {
      console.log(
        `${prefix} volume input=${inputVolume.toFixed(3)} output=${outputVolume.toFixed(3)}`
      );
      lastVolumeLog = now;
    }
  });
};

const BACKEND = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

function getAuthToken() {
  const storageKeys = [
    "authToken",
    "aisiAuthToken",
    "token",
    "jwt",
    "accessToken",
    import.meta.env.VITE_AUTH_TOKEN_STORAGE_KEY,
  ].filter(Boolean);

  for (const key of storageKeys) {
    try {
      const value = window.localStorage.getItem(key);
      if (value?.trim()) {
        return value.trim();
      }
    } catch (error) {
      console.warn("Unable to read auth token from localStorage", error);
      break;
    }
  }

  return "";
}

export const initDevice = async (identity) => {
  const authToken = getAuthToken();
  if (!authToken) {
    console.error("Missing auth token. Please login first.");
    return { ok: false, error: "missing-auth-token" };
  }

  const query = identity?.trim()
    ? `?identity=${encodeURIComponent(identity.trim().toLowerCase())}`
    : "";
  const res = await fetch(`${BACKEND}/token${query}`, {
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  });

  if (!res.ok) {
    let payload;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    console.error("Failed to fetch token", payload?.error || res.statusText);
    return { ok: false, error: payload?.error || "token-fetch-failed" };
  }

  const data = await res.json();
  const resolvedIdentity = data?.identity?.toString().trim().toLowerCase();

  if (!resolvedIdentity) {
    console.error("Token API did not return resolved identity");
    return { ok: false, error: "missing-identity" };
  }

  if (device) {
    await destroyTwilio();
  }

  device = new Device(data.token);

  device.on("registered", () => {
    console.log("Device registered");
    emit("device:registered", { identity: resolvedIdentity });
  });

  device.on("incoming", (call) => {
    console.log("Incoming call");
    activeCall = call;
    attachCallDebugHandlers(call, "incoming");
    emit("call:incoming", {
      call,
      from: call?.parameters?.From || null,
      to: call?.parameters?.To || null,
    });
    call.accept();
  });

  device.on("error", (err) => {
    console.error("Twilio device error:", err);
    emit("device:error", err);
  });

  await device.register();
  return { ok: true, identity: resolvedIdentity };
};



export const makeCall = async (to) => {
  if (!device) {
    console.error("Device not initialized");
    return;
  }

  if (!to?.trim()) {
    console.error("Please enter a valid target identity");
    return;
  }

  try {
    const call = await device.connect({ params: { To: to } });
    activeCall = call;
    attachCallDebugHandlers(call, "outgoing");
    emit("call:outgoing", { to, call });
    return call;
  } catch (err) {
    console.error("Failed to place call:", err);
    emit("call:error", { direction: "outgoing", call: null, error: err });
    return null;
  }
};

export const hangUpActiveCall = () => {
  if (activeCall) {
    activeCall.disconnect();
    activeCall = null;
  }
};

export const destroyTwilio = async () => {
  hangUpActiveCall();

  if (!device) {
    return;
  }

  try {
    if (typeof device.unregister === "function") {
      await device.unregister();
    }
  } catch (error) {
    console.warn("Twilio device unregister failed:", error);
  }

  try {
    if (typeof device.destroy === "function") {
      device.destroy();
    }
  } catch (error) {
    console.warn("Twilio device destroy failed:", error);
  }

  if (typeof device.removeAllListeners === "function") {
    device.removeAllListeners();
  }

  device = null;
  emit("device:destroyed", null);
};