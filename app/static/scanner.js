const statusNode = document.getElementById("mobile-status");
const sessionNode = document.getElementById("mobile-session");
const formatsNode = document.getElementById("scan-formats");
const previewCard = document.getElementById("scanner-preview-card");
const zoomRange = document.getElementById("zoom-range");
const zoomValue = document.getElementById("zoom-value");
const zoomStatus = document.getElementById("zoom-status");
const toastNode = document.getElementById("toast");
const manualInput = document.getElementById("manual-input");
const manualSend = document.getElementById("manual-send");

const SUPPORTED_FORMATS = [
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.CODE_93,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.ITF,
  Html5QrcodeSupportedFormats.CODABAR,
  Html5QrcodeSupportedFormats.PDF_417,
  Html5QrcodeSupportedFormats.DATA_MATRIX,
  Html5QrcodeSupportedFormats.AZTEC,
];

let socket = null;
let scanner = null;
let isSending = false;
const recent = new Set();
let heartbeatTimer = null;
let successTimer = null;
let currentZoom = 1;
let zoomCapabilities = null;

function getSessionId() {
  const params = new URLSearchParams(window.location.search);
  const value = String(params.get("session") || "").trim().toUpperCase();
  return value;
}

function setStatus(message, mode = "pending") {
  statusNode.textContent = message;
  statusNode.className = `status-pill small ${mode}`;
}

function setListeningState() {
  setStatus("Listening for QR + barcodes", "listening");
  if (formatsNode) {
    formatsNode.textContent = "Active scan modes: QR Code, Code 128, Code 39, Code 93, EAN-13, EAN-8, UPC-A, UPC-E, ITF, Codabar, PDF-417, Data Matrix, and Aztec.";
  }
}

function showToast(message, mode = "ok") {
  toastNode.textContent = message;
  toastNode.className = `toast ${mode}`;
  toastNode.classList.remove("hidden");
  setTimeout(() => toastNode.classList.add("hidden"), 1200);
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

function setZoomUi(value, enabled = true) {
  currentZoom = value;
  if (zoomRange) {
    zoomRange.value = String(value);
  }
  if (zoomValue) {
    zoomValue.textContent = `${Number(value).toFixed(1)}x`;
  }
  if (zoomStatus) {
    zoomStatus.textContent = enabled ? "Manual" : "Auto";
  }
}

async function applyZoom(value) {
  if (!scanner || !zoomCapabilities || !zoomCapabilities.zoom) {
    return;
  }

  const minZoom = Number(zoomCapabilities.zoom.min ?? 1);
  const maxZoom = Number(zoomCapabilities.zoom.max ?? minZoom);
  const boundedZoom = Math.max(minZoom, Math.min(maxZoom, value));

  try {
    await scanner.applyVideoConstraints({ advanced: [{ zoom: boundedZoom }] });
    setZoomUi(boundedZoom, true);
  } catch (error) {
    console.debug("Manual zoom adjustment failed:", error);
  }
}

function websocketUrl(sessionId) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/${encodeURIComponent(sessionId)}`;
}

function sendScan(qrCode, sessionId) {
  const normalized = String(qrCode || "").trim().toUpperCase();
  if (!normalized || !socket || socket.readyState !== WebSocket.OPEN || isSending) {
    return;
  }

  if (recent.has(normalized)) {
    return;
  }

  isSending = true;
  socket.send(JSON.stringify({
    type: "scan",
    qr_code: normalized,
    timestamp: new Date().toISOString(),
    source: "mobile",
    session_id: sessionId,
  }));

  recent.add(normalized);
  if (recent.size > 20) {
    const [first] = recent;
    recent.delete(first);
  }

  if (navigator.vibrate) {
    navigator.vibrate(100);
  }
  beep();
  pulsePreview();
  showToast(`Scanned: ${normalized}`, "ok");
  setTimeout(() => {
    isSending = false;
  }, 700);
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

async function startCamera(sessionId) {
  scanner = new Html5Qrcode("reader");

  await scanner.start(
    {
      facingMode: { ideal: "environment" },
      width: { ideal: 1600 },
      height: { ideal: 1200 },
      aspectRatio: { ideal: 4 / 3 },
      frameRate: { ideal: 24, max: 30 },
      resizeMode: "none",
      focusMode: { ideal: "continuous" },
    },
    {
      fps: 10,
      qrbox: { width: 300, height: 160 },
      formatsToSupport: SUPPORTED_FORMATS,
      disableFlip: true,
    },
    (decodedText) => sendScan(decodedText, sessionId),
    () => {}
  );

  try {
    zoomCapabilities = scanner.getRunningTrackCapabilities();
    if (zoomCapabilities && zoomCapabilities.zoom && zoomRange) {
      const minZoom = Number(zoomCapabilities.zoom.min ?? 1);
      const maxZoom = Number(zoomCapabilities.zoom.max ?? minZoom);
      const idealZoom = Math.max(minZoom, Math.min(maxZoom, 1.75));

      zoomRange.disabled = false;
      zoomRange.min = String(minZoom);
      zoomRange.max = String(maxZoom);
      zoomRange.step = maxZoom - minZoom > 2 ? "0.1" : "0.05";
      setZoomUi(idealZoom, true);
      await applyZoom(idealZoom);
    } else if (zoomStatus) {
      zoomStatus.textContent = "Auto";
    }
  } catch (error) {
    console.debug("Camera zoom adjustment skipped:", error);
  }

  setListeningState();
}

window.addEventListener("DOMContentLoaded", async () => {
  const sessionId = getSessionId();
  if (!sessionId) {
    setStatus("Missing session ID", "error");
    showToast("Open this page from laptop QR code", "error");
    return;
  }

  sessionNode.textContent = sessionId;
  connectSocket(sessionId);

  manualSend.addEventListener("click", () => {
    sendScan(manualInput.value, sessionId);
    manualInput.value = "";
  });

  manualInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendScan(manualInput.value, sessionId);
      manualInput.value = "";
    }
  });

  if (zoomRange) {
    zoomRange.addEventListener("input", async () => {
      const value = Number(zoomRange.value || 1);
      setZoomUi(value, true);
      await applyZoom(value);
    });
  }

  try {
    await startCamera(sessionId);
  } catch (error) {
    showToast(error.message || "Camera start failed", "error");
  }
});