// Orchestrates QR-based pairing (docs/PROTOCOL.md): the receiver
// creates a session and shows a QR/link carrying sessionId + a
// locally-generated sessionKey (in the URL fragment, never sent to the
// relay); the sender scans it (or pastes it, or opens it directly)
// and joins. Reaching "paired" is this build step's finish line — file
// transfer, reconnect, and role swap build on top of it later.

import { t } from "./i18n.js";
import { connect, sendEnvelope, parseEnvelope } from "./ws-client.js";
import { renderQR } from "./qr-encode.js";
import { startScanning } from "./qr-scan.js";
import * as b64url from "./base64url.js";

const SESSION_KEY_BYTES = 32;

let currentState = { screen: "role-select" };
let activeSocket = null;
let activeStopScan = null;

function buildPairingURL(sessionId, sessionKey) {
  const url = new URL(location.href);
  url.hash = `s=${sessionId}&k=${b64url.encode(sessionKey)}`;
  url.search = "";
  return url.toString();
}

function parsePairingText(text) {
  let hash = text.trim();
  const i = hash.indexOf("#");
  if (i !== -1) hash = hash.slice(i + 1);
  const params = new URLSearchParams(hash);
  const sessionId = params.get("s");
  const keyStr = params.get("k");
  if (!sessionId || !keyStr) return null;
  let sessionKey;
  try {
    sessionKey = b64url.decode(keyStr);
  } catch {
    return null;
  }
  if (sessionKey.length !== SESSION_KEY_BYTES) return null;
  return { sessionId, sessionKey };
}

function suggestedRole() {
  const coarsePointer = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  return coarsePointer ? "send" : "receive";
}

function cleanupActive() {
  if (activeStopScan) {
    activeStopScan();
    activeStopScan = null;
  }
  if (activeSocket) {
    try {
      activeSocket.close();
    } catch {
      // Already closed; nothing to do.
    }
    activeSocket = null;
  }
}

/** Tears down any in-flight connection/camera and moves to a new
 * screen. Use for user-initiated navigation (back/cancel/retry). */
function setState(container, next) {
  cleanupActive();
  currentState = next;
  render(container);
}

/** Moves to a new screen without tearing down the active
 * socket/camera. Use for progressing within the same flow (e.g.
 * session_created -> receiver-waiting -> paired keep the same
 * socket). */
function advance(container, next) {
  currentState = next;
  render(container);
}

export function initPairing(container) {
  const detected = location.hash.length > 1 ? parsePairingText(location.hash) : null;
  if (detected) {
    // Don't leave sessionKey sitting in the visible URL/history any
    // longer than necessary.
    history.replaceState(null, "", location.pathname + location.search);
    currentState = { screen: "join-detected", sessionId: detected.sessionId, sessionKey: detected.sessionKey };
  } else {
    currentState = { screen: "role-select" };
  }
  render(container);
}

/** Returns the active paired session for later build steps (transfer,
 * role swap, reconnect) to use, or null if not currently paired. */
export function getPairedSession() {
  if (currentState.screen !== "paired") return null;
  return {
    socket: activeSocket,
    sessionId: currentState.sessionId,
    sessionKey: currentState.sessionKey,
    role: currentState.role,
  };
}

function render(container) {
  container.innerHTML = "";
  container.className = "pairing";
  switch (currentState.screen) {
    case "role-select":
      renderRoleSelect(container);
      break;
    case "join-detected":
      renderJoinDetected(container);
      break;
    case "receiver-generating":
      renderStatus(container, t("receiverGenerating"));
      break;
    case "receiver-waiting":
      renderReceiverWaiting(container);
      break;
    case "sender-select":
      renderSenderSelect(container);
      break;
    case "sender-scanning":
      renderSenderScanning(container);
      break;
    case "sender-paste":
      renderSenderPaste(container);
      break;
    case "joining":
      renderStatus(container, t("statusJoining"));
      break;
    case "paired":
      renderPaired(container);
      break;
    case "error":
      renderError(container);
      break;
  }
}

function button(label, onClick, className) {
  const btn = document.createElement("button");
  btn.type = "button";
  if (className) btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function paragraph(text, className) {
  const p = document.createElement("p");
  if (className) p.className = className;
  p.textContent = text;
  return p;
}

function renderStatus(container, text) {
  container.appendChild(paragraph(text, "muted"));
}

function renderRoleSelect(container) {
  const suggested = suggestedRole();
  container.appendChild(paragraph(t("roleChooseTitle")));

  const row = document.createElement("div");
  row.className = "role-row";
  row.appendChild(
    button(t("roleReceive"), () => startReceiverFlow(container), suggested === "receive" ? "primary-button" : ""),
  );
  row.appendChild(
    button(t("roleSend"), () => advance(container, { screen: "sender-select" }), suggested === "send" ? "primary-button" : ""),
  );
  container.appendChild(row);
}

function renderJoinDetected(container) {
  container.appendChild(paragraph(t("joinDetectedTitle")));
  container.appendChild(
    button(t("joinDetectedButton"), () => {
      const { sessionId, sessionKey } = currentState;
      startJoin(container, sessionId, sessionKey);
    }, "primary-button"),
  );
  container.appendChild(button(t("joinDetectedCancel"), () => setState(container, { screen: "role-select" })));
}

function startReceiverFlow(container) {
  advance(container, { screen: "receiver-generating" });

  const socket = connect();
  activeSocket = socket;

  socket.addEventListener("open", () => sendEnvelope(socket, "create_session", null));

  socket.addEventListener("message", (event) => {
    const env = parseEnvelope(event);
    if (!env) return;

    if (env.type === "session_created") {
      const sessionId = env.payload.sessionId;
      const sessionKey = crypto.getRandomValues(new Uint8Array(SESSION_KEY_BYTES));
      const url = buildPairingURL(sessionId, sessionKey);
      advance(container, { screen: "receiver-waiting", sessionId, sessionKey, url });
    } else if (env.type === "paired") {
      advance(container, {
        screen: "paired",
        role: "host",
        sessionId: currentState.sessionId,
        sessionKey: currentState.sessionKey,
      });
    } else if (env.type === "error") {
      setState(container, { screen: "error", code: env.payload && env.payload.code });
    }
  });

  socket.addEventListener("close", () => {
    if (currentState.screen !== "paired" && currentState.screen !== "error") {
      setState(container, { screen: "error", code: "connection_lost" });
    }
  });
}

function renderReceiverWaiting(container) {
  container.appendChild(paragraph(t("receiverWaiting")));

  const canvas = document.createElement("canvas");
  canvas.className = "qr-canvas";
  container.appendChild(canvas);
  renderQR(canvas, currentState.url, 240);

  container.appendChild(paragraph(t("receiverLinkLabel"), "muted"));
  container.appendChild(paragraph(currentState.url, "pairing-link"));

  container.appendChild(button(t("backButton"), () => setState(container, { screen: "role-select" })));
}

function renderSenderSelect(container) {
  container.appendChild(paragraph(t("senderChooseTitle")));
  container.appendChild(button(t("senderScan"), () => advance(container, { screen: "sender-scanning" }), "primary-button"));
  container.appendChild(button(t("senderPaste"), () => advance(container, { screen: "sender-paste" })));
  container.appendChild(button(t("backButton"), () => setState(container, { screen: "role-select" })));
}

function renderSenderScanning(container) {
  container.appendChild(paragraph(t("senderScanHint")));

  const video = document.createElement("video");
  video.className = "qr-video";
  video.setAttribute("playsinline", "");
  video.muted = true;
  container.appendChild(video);

  let cancelled = false;
  container.appendChild(
    button(t("backButton"), () => {
      cancelled = true;
      setState(container, { screen: "sender-select" });
    }),
  );

  startScanning(
    video,
    (text) => {
      const parsed = parsePairingText(text);
      if (!parsed) {
        setState(container, { screen: "error", code: "invalid_qr" });
        return;
      }
      startJoin(container, parsed.sessionId, parsed.sessionKey);
    },
    () => {
      setState(container, { screen: "error", code: "camera_error" });
    },
  ).then((stop) => {
    if (cancelled) {
      stop();
      return;
    }
    activeStopScan = stop;
  });
}

function renderSenderPaste(container) {
  const label = document.createElement("label");
  label.textContent = t("senderPasteLabel");
  container.appendChild(label);

  const input = document.createElement("textarea");
  input.className = "paste-input";
  container.appendChild(input);

  container.appendChild(
    button(
      t("senderPasteButton"),
      () => {
        const parsed = parsePairingText(input.value);
        if (!parsed) {
          setState(container, { screen: "error", code: "invalid_link" });
          return;
        }
        startJoin(container, parsed.sessionId, parsed.sessionKey);
      },
      "primary-button",
    ),
  );
  container.appendChild(button(t("backButton"), () => setState(container, { screen: "sender-select" })));
}

function startJoin(container, sessionId, sessionKey) {
  activeStopScan = null; // qr-scan.js already stopped its own stream before decoding.
  advance(container, { screen: "joining", sessionId, sessionKey });

  const socket = connect();
  activeSocket = socket;

  socket.addEventListener("open", () => sendEnvelope(socket, "join", { sessionId }));

  socket.addEventListener("message", (event) => {
    const env = parseEnvelope(event);
    if (!env) return;

    if (env.type === "paired") {
      advance(container, { screen: "paired", role: "guest", sessionId, sessionKey });
    } else if (env.type === "error") {
      setState(container, { screen: "error", code: env.payload && env.payload.code });
    }
  });

  socket.addEventListener("close", () => {
    if (currentState.screen !== "paired" && currentState.screen !== "error") {
      setState(container, { screen: "error", code: "connection_lost" });
    }
  });
}

function renderPaired(container) {
  const text = currentState.role === "host" ? t("statusPairedHost") : t("statusPairedGuest");
  container.appendChild(paragraph(text, "status-paired"));
}

const ERROR_MESSAGE_KEYS = {
  session_not_found: "errSessionNotFound",
  session_full: "errSessionFull",
  too_many_sessions: "errTooManySessions",
  invalid_qr: "senderPasteInvalid",
  invalid_link: "senderPasteInvalid",
  camera_error: "senderCameraError",
};

function renderError(container) {
  const key = ERROR_MESSAGE_KEYS[currentState.code] || "errGeneric";
  container.appendChild(paragraph(t(key), "error-text"));
  container.appendChild(button(t("tryAgain"), () => setState(container, { screen: "role-select" }), "primary-button"));
}
