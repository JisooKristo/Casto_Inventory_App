const statusNode = document.getElementById("mobile-status");
const sessionNode = document.getElementById("mobile-session");
const formatsNode = document.getElementById("scan-formats");
const stepAssetNode = document.getElementById("scan-step-asset");
const stepSerialNode = document.getElementById("scan-step-serial");
const promptNode = document.getElementById("scan-prompt");
const skipSerialButton = document.getElementById("skip-serial");
const previewCard = document.getElementById("scanner-preview-card");
const toastNode = document.getElementById("toast");
const manualInput = document.getElementById("manual-input");
const manualSend = document.getElementById("manual-send");

const STEP_ASSET = 1;
const STEP_SERIAL = 2;

const ASSET_FORMATS = [Html5QrcodeSupportedFormats.QR_CODE];
const SERIAL_FORMATS = [
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.CODE_93,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.ITF,
  Html5QrcodeSupportedFormats.CODABAR,
];

let socket = null;
let scanner = null;
let currentStep = STEP_ASSET;
let pendingAsset = null;
let isSubmitting = false;
let heartbeatTimer = null;
let successTimer = null;

function getSessionId() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get("session") || "").trim().toUpperCase();
}

function setStatus(message, mode = "pending") {
  statusNode.textContent = message;
  statusNode.className = `status-pill small ${mode}`;
}

function setStepState(step, promptText) {
  currentStep = step;

  if (stepAssetNode) {
    stepAssetNode.className = `scan-step ${step === STEP_ASSET ? "active" : "complete"}`;
  }

  if (stepSerialNode) {
    stepSerialNode.className = `scan-step ${step === STEP_SERIAL ? "active" : ""}`;
  }

  if (promptNode) {
    promptNode.textContent = promptText;
  }

  if (skipSerialButton) {
    skipSerialButton.classList.toggle("hidden", step !== STEP_SERIAL);
  }

  if (formatsNode) {
    formatsNode.textContent = step === STEP_ASSET
      ? "Active scan mode: QR Code for asset tags."
      : "Active scan mode: barcode serial numbers for supported 1D formats.";
  }

  if (step === STEP_ASSET) {
    setStatus("Listening for asset QR", "listening");
  } else {
    setStatus("Listening for serial barcode", "listening");
  }
}

function showToast(message, mode = "ok") {
  toastNode.textContent = message;
  toastNode.className = `toast ${mode}`;
  toastNode.classList.remove("hidden");
  window.setTimeout(() => toastNode.classList.add("hidden"), 1400);
}

function beep() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    return;
  }

  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 820;
  gainNode.gain.value = 0.06;
  oscillator.connect(gainNode);
  gainNode.connect(context.destination);
  oscillator.start();
  window.setTimeout(() => {
    oscillator.stop();
    context.close();
  }, 110);
}

function pulsePreview() {
  if (!previewCard) {
    return;
  }

  previewCard.classList.remove("scan-success");
  window.clearTimeout(successTimer);
  window.requestAnimationFrame(() => {
    previewCard.classList.add("scan-success");
    successTimer = window.setTimeout(() => {
      previewCard.classList.remove("scan-success");
    }, 520);
  });
}

function websocketUrl(sessionId) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/${encodeURIComponent(sessionId)}`;
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail || "Request failed");
  }
  return payload;
}

async function stopCamera() {
  if (!scanner) {
    return;
  }

  try {
    await scanner.stop();
  } catch (error) {
    // Ignore stop errors when the camera is already idle or still initializing.
  }
}

function selectRearCamera(cameras) {
  return cameras.find((camera) => /back|rear|environment/i.test(camera.label)) || cameras[0];
}

function scanConfigForStep(step) {
  if (step === STEP_SERIAL) {
    return {
      fps: 12,
      qrbox: { width: 320, height: 170 },
      formatsToSupport: SERIAL_FORMATS,
      disableFlip: true,
    };
  }

  return {
    fps: 10,
    qrbox: { width: 260, height: 260 },
    formatsToSupport: ASSET_FORMATS,
    disableFlip: true,
  };
}

async function startCamera(sessionId, step, promptText) {
  if (!scanner) {
    scanner = new Html5Qrcode("reader");
  }

  const cameras = await Html5Qrcode.getCameras();
  if (!cameras || cameras.length === 0) {
    throw new Error("No camera detected on this device.");
  }

  const rear = selectRearCamera(cameras);
  await scanner.start(
    rear.id,
    scanConfigForStep(step),
    (decodedText) => handleScan(decodedText, sessionId),
    () => {}
  );

  setStepState(
    step,
    promptText || (
      step === STEP_ASSET
        ? "Step 1 active. Scan the asset QR sticker."
        : "Step 2 active. Scan the barcode serial number or skip it if the item has none."
    )
  );
}

async function restartCamera(sessionId, step, promptText) {
  await stopCamera();
  await startCamera(sessionId, step, promptText);
}

function broadcastCompletedRecord(record, sessionId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: "scan_completed",
    source: "mobile",
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    record,
  }));
}

function celebrateCompletion(record, sessionId, message) {
  if (navigator.vibrate) {
    navigator.vibrate(100);
  }
  beep();
  pulsePreview();
  showToast(message, "ok");
  broadcastCompletedRecord(record, sessionId);
}

async function completeSerialStep(sessionId, serialNumber, skipSerialNumber = false) {
  if (!pendingAsset) {
    throw new Error("Scan the asset QR code first.");
  }

  const payload = await postJson(`/api/complete-scan?session_id=${encodeURIComponent(sessionId)}`, {
    serial_number: serialNumber,
    skip_serial_number: skipSerialNumber,
  });

  pendingAsset = null;
  celebrateCompletion(
    payload.record,
    sessionId,
    skipSerialNumber ? "Serial number skipped. Scan completed." : "Serial number captured. Scan completed."
  );
  await restartCamera(sessionId, STEP_ASSET, "Scan the asset QR sticker to start the workflow.");
}

async function handleAssetStep(sessionId, decodedText) {
  const payload = await postJson(`/api/scan?session_id=${encodeURIComponent(sessionId)}`, {
    qr_code: decodedText,
  });

  if (payload.requires_serial_number) {
    pendingAsset = payload.asset;
    setStepState(
      STEP_SERIAL,
      "Asset Tag Captured! Now scan the item's Barcode Serial Number."
    );
    showToast("Asset Tag Captured! Now scan the item's Barcode Serial Number.", "ok");
    await restartCamera(sessionId, STEP_SERIAL, "Asset Tag Captured! Now scan the item's Barcode Serial Number.");
    return;
  }

  celebrateCompletion(payload.record, sessionId, "Scan completed.");
  await restartCamera(sessionId, STEP_ASSET, "Scan the asset QR sticker to start the workflow.");
}

async function handleSerialStep(sessionId, decodedText) {
  await completeSerialStep(sessionId, decodedText, false);
}

async function handleScan(decodedText, sessionId) {
  const normalized = String(decodedText || "").trim().toUpperCase();
  if (!normalized || isSubmitting) {
    return;
  }

  isSubmitting = true;
  try {
    if (currentStep === STEP_ASSET) {
      await handleAssetStep(sessionId, normalized);
    } else {
      await handleSerialStep(sessionId, normalized);
    }
  } catch (error) {
    showToast(error.message || "Scan failed", "error");
  } finally {
    isSubmitting = false;
  }
}

function connectSocket(sessionId) {
  setStatus("Connecting...", "pending");
  socket = new WebSocket(websocketUrl(sessionId));

  socket.addEventListener("open", () => {
    setStatus("Connected to Laptop", "online");
    socket.send(JSON.stringify({
      type: "hello_mobile",
      session_id: sessionId,
      source: "mobile",
      timestamp: new Date().toISOString(),
    }));

    if (heartbeatTimer) {
      window.clearInterval(heartbeatTimer);
    }

    heartbeatTimer = window.setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({
        type: "hello_mobile",
        session_id: sessionId,
        source: "mobile",
        timestamp: new Date().toISOString(),
      }));
    }, 10000);
  });

  socket.addEventListener("close", () => {
    setStatus("Reconnecting...", "pending");
    if (heartbeatTimer) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    window.setTimeout(() => connectSocket(sessionId), 1500);
  });

  socket.addEventListener("error", () => {
    setStatus("Connection error", "error");
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  const sessionId = getSessionId();
  if (!sessionId) {
    setStatus("Missing session ID", "error");
    showToast("Open this page from laptop QR code", "error");
    return;
  }

  sessionNode.textContent = sessionId;
  setStepState(STEP_ASSET, "Scan the asset QR sticker to start the workflow.");
  connectSocket(sessionId);

  skipSerialButton.addEventListener("click", async () => {
    if (currentStep !== STEP_SERIAL || isSubmitting) {
      return;
    }

    isSubmitting = true;
    try {
      await completeSerialStep(sessionId, "N/A", true);
    } catch (error) {
      showToast(error.message || "Skip failed", "error");
    } finally {
      isSubmitting = false;
    }
  });

  manualSend.addEventListener("click", async () => {
    const value = manualInput.value;
    manualInput.value = "";
    await handleScan(value, sessionId);
  });

  manualInput.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const value = manualInput.value;
      manualInput.value = "";
      await handleScan(value, sessionId);
    }
  });

  try {
    await startCamera(sessionId, STEP_ASSET, "Scan the asset QR sticker to start the workflow.");
  } catch (error) {
    showToast(error.message || "Camera start failed", "error");
  }
});
