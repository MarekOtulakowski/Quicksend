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
import * as pake from "./pake.js";
import { renderTransferUI } from "./transfer-ui.js";
import { toHex, fromHex } from "./hex.js";
import { deriveReconnectToken } from "./crypto.js";

// How many times to retry opening a new connection after the paired
// socket drops unexpectedly, and how long to wait between attempts,
// before giving up and showing the "connection lost" error screen.
// The relay itself keeps a session resumable for
// QUICKSEND_RECONNECT_GRACE_PERIOD (default 45s); this budget is
// comfortably inside that window without the client needing to know
// the exact server-side value.
const RECONNECT_MAX_ATTEMPTS = 6;
const RECONNECT_RETRY_DELAY_MS = 2000;

const SESSION_KEY_BYTES = 32;

/** Waits for the next message of a given type on socket. Safe to have
 * several of these (and other listeners) on the same socket at once —
 * each just ignores message types it isn't waiting for. */
function waitForType(socket, type) {
  return new Promise((resolve) => {
    function onMessage(event) {
      const env = parseEnvelope(event);
      if (env && env.type === type) {
        socket.removeEventListener("message", onMessage);
        resolve(env);
      }
    }
    socket.addEventListener("message", onMessage);
  });
}

/** Runs the code+PAKE key exchange over an already-paired socket and
 * returns the confirmed shared sessionKey, or throws if the other side
 * didn't derive the same key (wrong code). pakeRole 0 = host
 * (initiator), 1 = guest (responder) — see docs/PROTOCOL.md. */
async function runPakeExchange(socket, code, pakeRole) {
  const initResult = await pake.init(code, pakeRole);
  const handle = initResult.handle;

  if (pakeRole === 0) {
    sendEnvelope(socket, "pake_msg", { message: initResult.message });
  }
  const peerMsgEnv = await waitForType(socket, "pake_msg");
  const updateResult = await pake.update(handle, peerMsgEnv.payload.message);
  if (pakeRole === 1) {
    sendEnvelope(socket, "pake_msg", { message: updateResult.message });
  }

  const keyBytes = await pake.sessionKey(handle);
  const myTag = await pake.computeConfirmTag(keyBytes);
  sendEnvelope(socket, "pake_confirm", { tagHex: toHex(myTag) });
  const confirmEnv = await waitForType(socket, "pake_confirm");
  const peerTag = fromHex(confirmEnv.payload.tagHex);
  const ok = await pake.verifyConfirmTag(keyBytes, peerTag);

  await pake.free(handle);
  if (!ok) throw new Error("code_mismatch");
  return keyBytes;
}

let currentState = { screen: "role-select" };
let activeSocket = null;
let activeStopScan = null;
let activeTransferDetach = null;

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
  detachActiveTransfer();
}

/** Detaches the current transfer UI's socket listener, if any. Must
 * run before rendering a new one over it (renderPaired does this
 * itself) and before leaving the paired screen entirely — otherwise a
 * receiver's listener from a torn-down render stays attached to a
 * socket that outlives it (e.g. a reconnect that only affected the
 * *other* peer leaves this socket untouched) and keeps trying to
 * decrypt new traffic under a stale epoch key. */
function detachActiveTransfer() {
  if (activeTransferDetach) {
    activeTransferDetach();
    activeTransferDetach = null;
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
 * role swap) to use, or null if not currently paired. epoch advances
 * by one on every successful reconnect (either peer) — see
 * transfer-ui.js's renderTransferUI. */
export function getPairedSession() {
  if (currentState.screen !== "paired") return null;
  return {
    socket: activeSocket,
    sessionId: currentState.sessionId,
    sessionKey: currentState.sessionKey,
    role: currentState.role,
    epoch: currentState.epoch,
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
    case "receive-method-select":
      renderReceiveMethodSelect(container);
      break;
    case "send-method-select":
      renderSendMethodSelect(container);
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
    case "code-receiver-generating":
      renderStatus(container, t("receiverGenerating"));
      break;
    case "code-receiver-waiting":
      renderCodeReceiverWaiting(container);
      break;
    case "code-sender-entry":
      renderCodeSenderEntry(container);
      break;
    case "verifying":
      renderStatus(container, t("statusVerifying"));
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
    button(
      t("roleReceive"),
      () => advance(container, { screen: "receive-method-select" }),
      suggested === "receive" ? "primary-button" : "",
    ),
  );
  row.appendChild(
    button(
      t("roleSend"),
      () => advance(container, { screen: "send-method-select" }),
      suggested === "send" ? "primary-button" : "",
    ),
  );
  container.appendChild(row);
}

function renderReceiveMethodSelect(container) {
  container.appendChild(paragraph(t("methodChooseTitle")));
  container.appendChild(button(t("methodQR"), () => startReceiverFlow(container), "primary-button"));
  container.appendChild(button(t("methodCode"), () => startReceiverCodeFlow(container)));
  container.appendChild(button(t("backButton"), () => setState(container, { screen: "role-select" })));
}

function renderSendMethodSelect(container) {
  container.appendChild(paragraph(t("methodChooseTitle")));
  container.appendChild(button(t("methodQR"), () => advance(container, { screen: "sender-select" }), "primary-button"));
  container.appendChild(button(t("methodCode"), () => advance(container, { screen: "code-sender-entry" })));
  container.appendChild(button(t("backButton"), () => setState(container, { screen: "role-select" })));
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
      finalizePaired(container, socket, currentState.sessionId, currentState.sessionKey, "host");
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

function startReceiverCodeFlow(container) {
  advance(container, { screen: "code-receiver-generating" });

  const socket = connect();
  activeSocket = socket;

  socket.addEventListener("open", () => sendEnvelope(socket, "create_code_session", null));

  socket.addEventListener("message", (event) => {
    const env = parseEnvelope(event);
    if (!env) return;

    if (env.type === "code_session_created") {
      advance(container, {
        screen: "code-receiver-waiting",
        code: env.payload.code,
        expiresAt: env.payload.expiresAt,
      });
    } else if (env.type === "paired") {
      const code = currentState.code;
      const sessionId = env.payload && env.payload.sessionId;
      advance(container, { screen: "verifying" });
      runPakeExchange(socket, code, 0)
        .then((sessionKey) => {
          finalizePaired(container, socket, sessionId, sessionKey, "host");
        })
        .catch(() => {
          setState(container, { screen: "error", code: "code_mismatch" });
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

function renderCodeReceiverWaiting(container) {
  container.appendChild(paragraph(t("codeReceiverWaiting")));

  const formatted = currentState.code.slice(0, 3) + "-" + currentState.code.slice(3);
  container.appendChild(paragraph(formatted, "pairing-code"));

  container.appendChild(paragraph(t("codeExpiryNote"), "muted"));
  container.appendChild(button(t("backButton"), () => setState(container, { screen: "receive-method-select" })));
}

function renderCodeSenderEntry(container) {
  container.appendChild(paragraph(t("codeSenderLabel")));

  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.maxLength = 7; // 6 digits + 1 dash
  input.className = "code-input";
  input.placeholder = "000-000";
  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "").slice(0, 6);
    input.value = digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
  });
  container.appendChild(input);

  container.appendChild(
    button(
      t("senderPasteButton"),
      () => {
        const digits = input.value.replace(/\D/g, "");
        if (digits.length !== 6) {
          setState(container, { screen: "error", code: "invalid_code" });
          return;
        }
        startJoinByCode(container, digits);
      },
      "primary-button",
    ),
  );
  container.appendChild(button(t("backButton"), () => setState(container, { screen: "send-method-select" })));
}

function startJoinByCode(container, code) {
  advance(container, { screen: "joining" });

  const socket = connect();
  activeSocket = socket;

  socket.addEventListener("open", () => sendEnvelope(socket, "join_by_code", { code }));

  socket.addEventListener("message", (event) => {
    const env = parseEnvelope(event);
    if (!env) return;

    if (env.type === "paired") {
      const sessionId = env.payload && env.payload.sessionId;
      advance(container, { screen: "verifying" });
      runPakeExchange(socket, code, 1)
        .then((sessionKey) => {
          finalizePaired(container, socket, sessionId, sessionKey, "guest");
        })
        .catch(() => {
          setState(container, { screen: "error", code: "code_mismatch" });
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

  container.appendChild(button(t("backButton"), () => setState(container, { screen: "receive-method-select" })));
}

function renderSenderSelect(container) {
  container.appendChild(paragraph(t("senderChooseTitle")));
  container.appendChild(button(t("senderScan"), () => advance(container, { screen: "sender-scanning" }), "primary-button"));
  container.appendChild(button(t("senderPaste"), () => advance(container, { screen: "sender-paste" })));
  container.appendChild(button(t("backButton"), () => setState(container, { screen: "send-method-select" })));
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
      finalizePaired(container, socket, sessionId, sessionKey, "guest");
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

let reconnectStatusEl = null;

function showReconnectStatus(text) {
  if (!reconnectStatusEl) return;
  reconnectStatusEl.textContent = text || "";
  reconnectStatusEl.hidden = !text;
}

function renderPaired(container) {
  // Re-rendering (e.g. after a reconnect or a peer_reconnected
  // notification) must detach the previous transfer UI's socket
  // listener first — see detachActiveTransfer.
  detachActiveTransfer();

  const text = currentState.role === "host" ? t("statusPairedHost") : t("statusPairedGuest");
  container.appendChild(paragraph(text, "status-paired"));

  reconnectStatusEl = paragraph("", "muted");
  reconnectStatusEl.hidden = true;
  container.appendChild(reconnectStatusEl);

  const transferRoot = document.createElement("div");
  container.appendChild(transferRoot);
  renderTransferUI(transferRoot, getPairedSession()).then((detach) => {
    activeTransferDetach = detach;
  });
}

/** Finishes the pairing flow common to all four pairing paths (QR
 * host/guest, code host/guest): registers this peer's reconnect token
 * with the relay, wires up automatic reconnection for the paired
 * socket, and moves to the "paired" screen. sessionId must be the
 * relay's session ID (from session_created for QR, or from paired's
 * payload for code+PAKE — see proto.PairedPayload). */
function finalizePaired(container, socket, sessionId, sessionKey, role) {
  currentState = { screen: "paired", sessionId, sessionKey, role, epoch: 0 };
  deriveReconnectToken(sessionKey, sessionId).then((token) => {
    currentState = { ...currentState, reconnectToken: token };
    sendEnvelope(socket, "reconnect_token", { tokenHex: toHex(token) });
  });
  wirePairedSocket(container, socket);
  render(container);
}

/** Attaches the listeners that keep a paired session alive across a
 * dropped connection: session_ended ends things for good, peer_reconnected
 * bumps the local epoch (the other side reconnected, we didn't), and an
 * unexpected close of our own socket triggers attemptReconnect. */
function wirePairedSocket(container, socket) {
  socket.addEventListener("message", (event) => {
    const env = parseEnvelope(event);
    if (!env) return;
    if (env.type === "session_ended") {
      setState(container, { screen: "error", code: "session_ended" });
    } else if (env.type === "peer_reconnected") {
      currentState = { ...currentState, epoch: currentState.epoch + 1 };
      render(container);
    }
  });
  socket.addEventListener("close", () => {
    if (currentState.screen !== "paired" || activeSocket !== socket) return;
    activeSocket = null;
    attemptReconnect(container, 1);
  });
}

/** Tries to resume the paired session on a fresh socket after the
 * previous one dropped unexpectedly (network blip, backgrounded tab,
 * etc). Any file transfer that was in flight at the time of the drop
 * is not resumed — sendFile/attachReceiver both fail fast on a closed
 * socket (see transfer.js) rather than hanging, and this rebuilds the
 * transfer UI from scratch once reconnected. See docs/DECISIONS.md. */
function attemptReconnect(container, attempt) {
  if (currentState.screen !== "paired") return;
  showReconnectStatus(t("reconnecting"));

  const { sessionId, role, reconnectToken } = currentState;
  if (!reconnectToken) {
    // Dropped before this peer even finished registering its token —
    // nothing the relay would accept a reconnect for.
    setState(container, { screen: "error", code: "connection_lost" });
    return;
  }

  const socket = connect();

  socket.addEventListener("open", () => {
    sendEnvelope(socket, "reconnect", { sessionId, role, tokenHex: toHex(reconnectToken) });
  });

  socket.addEventListener("message", (event) => {
    const env = parseEnvelope(event);
    if (!env) return;
    if (env.type === "reconnected") {
      activeSocket = socket;
      showReconnectStatus(null);
      currentState = { ...currentState, epoch: currentState.epoch + 1 };
      wirePairedSocket(container, socket);
      render(container);
    } else if (env.type === "error") {
      setState(container, { screen: "error", code: (env.payload && env.payload.code) || "connection_lost" });
    }
  });

  socket.addEventListener("close", () => {
    if (currentState.screen !== "paired" || activeSocket === socket) return;
    if (attempt >= RECONNECT_MAX_ATTEMPTS) {
      setState(container, { screen: "error", code: "connection_lost" });
      return;
    }
    setTimeout(() => attemptReconnect(container, attempt + 1), RECONNECT_RETRY_DELAY_MS);
  });
}

const ERROR_MESSAGE_KEYS = {
  session_not_found: "errSessionNotFound",
  session_full: "errSessionFull",
  too_many_sessions: "errTooManySessions",
  invalid_qr: "senderPasteInvalid",
  invalid_link: "senderPasteInvalid",
  camera_error: "senderCameraError",
  invalid_code: "errInvalidCode",
  too_many_attempts: "errTooManyAttempts",
  code_mismatch: "errCodeMismatch",
  connection_lost: "errConnectionLost",
  session_ended: "errSessionEnded",
  invalid_reconnect_token: "errConnectionLost",
};

function renderError(container) {
  const key = ERROR_MESSAGE_KEYS[currentState.code] || "errGeneric";
  container.appendChild(paragraph(t(key), "error-text"));
  container.appendChild(button(t("tryAgain"), () => setState(container, { screen: "role-select" }), "primary-button"));
}
