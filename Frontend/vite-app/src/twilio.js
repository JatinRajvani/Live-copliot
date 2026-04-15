import { Device } from "@twilio/voice-sdk";

let device = null;
let activeCall = null;

const attachCallDebugHandlers = (call, direction) => {
  const prefix = `[${direction}]`;
  let lastVolumeLog = 0;

  call.on("accept", () => {
    console.log(`${prefix} call accepted`);
  });

  call.on("disconnect", () => {
    console.log(`${prefix} call disconnected`);
    if (activeCall === call) {
      activeCall = null;
    }
  });

  call.on("cancel", () => {
    console.log(`${prefix} call canceled`);
  });

  call.on("reject", () => {
    console.log(`${prefix} call rejected`);
  });

  call.on("error", (err) => {
    console.error(`${prefix} call error:`, err);
  });

  call.on("volume", (inputVolume, outputVolume) => {
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

export const initDevice = async (identity) => {
  if (!identity?.trim()) {
    console.error("Please enter a valid identity");
    return;
  }

  const res = await fetch(`http://localhost:5000/token?identity=${identity}`);

  if (!res.ok) {
    console.error("Failed to fetch token");
    return;
  }

  const data = await res.json();

  device = new Device(data.token);

  device.on("registered", () => {
    console.log("Device registered");
  });

  device.on("incoming", (call) => {
    console.log("Incoming call");
    activeCall = call;
    attachCallDebugHandlers(call, "incoming");
    call.accept();
  });

  device.on("error", (err) => {
    console.error("Twilio device error:", err);
  });

  await device.register();
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
    return call;
  } catch (err) {
    console.error("Failed to place call:", err);
    return null;
  }
};