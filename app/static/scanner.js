const statusNode = document.getElementById("mobile-status");
const sessionNode = document.getElementById("mobile-session");
const toastNode = document.getElementById("toast");
const manualInput = document.getElementById("manual-input");
const manualSend = document.getElementById("manual-send");

let socket = null;
let scanner = null;
let isSending = false;
const recent = new Set();
let heartbeatTimer = null;

function getSessionId() {
  const params = new URLSearchParams(window.location.search);
  const value = String(params.get("session") || "").trim().toUpperCase();
  return value;
}

function setStatus(message, mode = "pending") {
  statusNode.textContent = message;
  statusNode.className = `status-pill small ${mode}`;
}

function showToast(message, mode = "ok") {
  toastNode.textContent = message;
  toastNode.className = `toast ${mode}`;
  toastNode.classList.remove("hidden");
  setTimeout(() => toastNode.classList.add("hidden"), 1200);
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
  const cameras = await Html5Qrcode.getCameras();
  if (!cameras || cameras.length === 0) {
    throw new Error("No camera detected on this device.");
  }

  const rear = cameras.find((camera) => /back|rear|environment/i.test(camera.label)) || cameras[0];

  await scanner.start(
    rear.id,
    {
      fps: 12,
      qrbox: { width: 250, height: 250 },
      disableFlip: true,
    },
    (decodedText) => sendScan(decodedText, sessionId),
    () => {}
  );
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

  try {
    await startCamera(sessionId);
  } catch (error) {
    showToast(error.message || "Camera start failed", "error");
  }
});