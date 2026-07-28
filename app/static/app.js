const wsStatus = document.getElementById("ws-status");
const sessionIdNode = document.getElementById("session-id");
const mobileLink = document.getElementById("mobile-link");
const qrNode = document.getElementById("pair-qr");
const sessionBody = document.getElementById("session-body");
const sessionCount = document.getElementById("session-count");
const lastScan = document.getElementById("last-scan");
const flash = document.getElementById("flash");
const clearButton = document.getElementById("clear-session");
const exportButton = document.getElementById("download-excel");

const seenTags = new Set();
let records = [];
let socket = null;

function createSessionId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i += 1) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function getSessionId() {
  const saved = window.localStorage.getItem("casto_session_id");
  if (saved && /^[A-Z0-9]{6}$/.test(saved)) {
    return saved;
  }
  const created = createSessionId();
  window.localStorage.setItem("casto_session_id", created);
  return created;
}

function notify(message, mode = "ok") {
  flash.textContent = message;
  flash.className = `flash ${mode}`;
  flash.classList.remove("hidden");
  setTimeout(() => flash.classList.add("hidden"), 1200);
}

function setWsStatus(message, mode = "pending") {
  wsStatus.textContent = message;
  wsStatus.className = `status-pill ${mode}`;
}

function ping() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    return;
  }
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 740;
  gainNode.gain.value = 0.05;
  oscillator.connect(gainNode);
  gainNode.connect(context.destination);
  oscillator.start();
  setTimeout(() => {
    oscillator.stop();
    context.close();
  }, 130);
}

function renderRows() {
  if (records.length === 0) {
    sessionBody.innerHTML = '<tr><td colspan="8" class="empty-state">Waiting for scans from mobile device...</td></tr>';
    sessionCount.textContent = "0";
    lastScan.textContent = "None";
    return;
  }

  sessionBody.innerHTML = "";
  for (const record of records) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><strong>${record["Item Name"]}</strong></td>
      <td>${record.Company}</td>
      <td>${record["Device Type"]}</td>
      <td>${record.Location}</td>
      <td>${record["Date Acquired"]}</td>
      <td>${record["Sequence Number"]}</td>
      <td>${record["Scan Timestamp"]}</td>
      <td>
        <button class="remove-btn" data-qr="${record["Item Name"]}" aria-label="Remove ${record["Item Name"]}">-</button>
      </td>
    `;
    sessionBody.appendChild(row);
  }

  sessionCount.textContent = String(records.length);
  lastScan.textContent = records[0]["Item Name"];
}

async function loadSession(sessionId) {
  const response = await fetch(`/api/session?session_id=${encodeURIComponent(sessionId)}`);
  const payload = await response.json();
  records = payload.items.slice().reverse();
  seenTags.clear();
  for (const record of records) {
    seenTags.add(record["Item Name"]);
  }
  renderRows();
}

async function persistScan(sessionId, qrCode) {
  const response = await fetch(`/api/scan?session_id=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qr_code: qrCode }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail || "Invalid barcode/tag format");
  }
  return payload.record;
}

async function removeScan(sessionId, qrCode) {
  const response = await fetch(`/api/remove-scan?session_id=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qr_code: qrCode }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail || "Failed to remove scan");
  }

  records = records.filter((record) => record["Item Name"] !== qrCode);
  seenTags.delete(qrCode);
  renderRows();
  notify("Scan removed", "ok");
}

function websocketUrl(sessionId) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/${encodeURIComponent(sessionId)}`;
}

function connectSocket(sessionId) {
  setWsStatus("Connecting...", "pending");
  socket = new WebSocket(websocketUrl(sessionId));

  socket.addEventListener("open", () => {
    setWsStatus("Connected", "online");
  });

  socket.addEventListener("message", async (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (!payload.qr_code) {
        return;
      }

      const qrCode = String(payload.qr_code).trim().toUpperCase();
      if (!qrCode || seenTags.has(qrCode)) {
        return;
      }

      const record = await persistScan(sessionId, qrCode);
      seenTags.add(qrCode);
      records.unshift(record);
      renderRows();
      ping();
      notify(`Received ${qrCode}`, "ok");
    } catch (error) {
      notify(error.message || "Invalid scan payload", "error");
    }
  });

  socket.addEventListener("close", () => {
    setWsStatus("Reconnecting...", "pending");
    window.setTimeout(() => connectSocket(sessionId), 1500);
  });

  socket.addEventListener("error", () => {
    setWsStatus("Connection error", "error");
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  const sessionId = getSessionId();
  sessionIdNode.textContent = sessionId;

  const scannerUrl = `${window.location.origin}/scanner?session=${encodeURIComponent(sessionId)}`;
  mobileLink.textContent = scannerUrl;
  mobileLink.href = scannerUrl;

  qrNode.innerHTML = "";
  // qrcode.js creates the pairing QR that phone users scan to join the same session.
  new QRCode(qrNode, {
    text: scannerUrl,
    width: 208,
    height: 208,
    colorDark: "#0f172a",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M,
  });

  await loadSession(sessionId);
  connectSocket(sessionId);

  clearButton.addEventListener("click", async () => {
    await fetch(`/api/clear-session?session_id=${encodeURIComponent(sessionId)}`, { method: "POST" });
    records = [];
    seenTags.clear();
    renderRows();
    notify("Session cleared", "ok");
  });

  exportButton.addEventListener("click", () => {
    window.location.href = `/api/export-excel?session_id=${encodeURIComponent(sessionId)}`;
  });

  sessionBody.addEventListener("click", async (event) => {
    const button = event.target.closest(".remove-btn");
    if (!button) {
      return;
    }
    const qrCode = button.getAttribute("data-qr");
    if (!qrCode) {
      return;
    }
    try {
      await removeScan(sessionId, qrCode);
    } catch (error) {
      notify(error.message || "Remove failed", "error");
    }
  });
});