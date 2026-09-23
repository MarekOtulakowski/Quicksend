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
// QUICKSEND_RECONNECT_GRACE_PERIOD (default 45s) — these add up to
// about the same total window, so the client keeps trying for
// roughly as long as the relay is actually still willing to accept a
// reconnect, instead of giving up early on a mobile connection that's
// still mid-handover (a real-world Android failure this used to be
// too short for — see docs/DECISIONS.md).
const RECONNECT_MAX_ATTEMPTS = 15;
const RECONNECT_RETRY_DELAY_MS = 3000;

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

// How long to wait for a role_swap_response before giving up on a
// swap request and re-enabling the button — protects against a peer
// that's mid-reconnect or otherwise unresponsive leaving the button
// disabled forever.
const ROLE_SWAP_TIMEOUT_MS = 8000;

let currentState = { screen: "role-select" };
let activeSocket = null;
let activeStopScan = null;
let activeTransferHandle = null;
let swapAwaitingResponse = false;

// Files picked while the sender's connection wasn't actually usable
// yet (see transfer-ui.js's handlePicked and docs/DECISIONS.md) — kept
// here, not just re-tried immediately, since the moment they were
// picked there may not be any live connection at all yet for anything
// to forward them to. Flushed the next time renderPaired sets up a
// transfer UI with a working socket. Last-write-wins is fine: a user
// picking again before ever getting a working connection is rare
// enough not to warrant a real queue.
let pendingSendFiles = null;

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
  // A pick queued for this session (see renderPaired) has nowhere
  // sensible to go once we've navigated away from it entirely.
  pendingSendFiles = null;
}

/** Detaches the current transfer UI's socket listener, if any. Must
 * run before rendering a new one over it (renderPaired does this
 * itself) and before leaving the paired screen entirely — otherwise a
 * receiver's listener from a torn-down render stays attached to a
 * socket that outlives it (e.g. a reconnect that only affected the
 * *other* peer leaves this socket untouched, or a role swap doesn't
 * touch the socket at all) and keeps trying to decrypt new traffic
 * under a stale epoch key or in the wrong direction. */
function detachActiveTransfer() {
  if (activeTransferHandle) {
    activeTransferHandle.detach();
    activeTransferHandle = null;
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
  // Everything past the initial QR-fragment key exchange (PAKE
  // confirmation, reconnect tokens, and all file encryption) needs
  // crypto.subtle, which browsers only expose in a secure context
  // (HTTPS, or the literal hosts localhost/127.0.0.1) — never plain
  // HTTP to a LAN IP, even though *reaching* the page and parsing a
  // pairing link both still work there (they only need
  // crypto.getRandomValues, which has no such restriction). Without
  // this check, that mismatch used to fail silently: pairing itself
  // would appear to succeed, then every screen after it would just
  // never render, with the actual TypeError only visible in the
  // browser console. See docs/DECISIONS.md.
  if (!window.isSecureContext) {
    currentState = { screen: "insecure-context" };
    render(container);
    return;
  }

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

/** Returns the active paired session for transfer-ui.js to use, or
 * null if not currently paired. epoch advances by one on every
 * successful reconnect (either peer). transferRole ("sender" or
 * "receiver") starts out matching pairing role (host = receiver,
 * guest = sender) but can be flipped independently by a role swap —
 * see requestRoleSwap/wirePairedSocket and docs/DECISIONS.md. */
export function getPairedSession() {
  if (currentState.screen !== "paired") return null;
  return {
    socket: activeSocket,
    sessionId: currentState.sessionId,
    sessionKey: currentState.sessionKey,
    role: currentState.role,
    epoch: currentState.epoch,
    transferRole: currentState.transferRole,
  };
}

function render(container) {
  container.innerHTML = "";
  container.className = "pairing";
  switch (currentState.screen) {
    case "role-select":
      renderRoleSelect(container);
      break;
    case "code-role-select":
      renderCodeRoleSelect(container);
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
    case "insecure-context":
      renderInsecureContext(container);
      break;
  }
}

function renderInsecureContext(container) {
  container.appendChild(paragraph(t("insecureContextTitle"), "error-text"));
  container.appendChild(paragraph(t("insecureContextBody"), "muted"));
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

// The start screen used to be role (Receive/Send) then method (QR/
// code) as two separate screens, plus a third screen for Send+QR
// (scan/paste) — three clicks before a first-time user saw anything
// concrete. QR-with-both-devices-together is overwhelmingly the
// common case, so it's now the direct action on the very first
// screen; the code+PAKE path (remote devices) is a single small link
// below it rather than an equally-weighted option, and only reveals
// its own receive/send choice if actually clicked. See docs/DECISIONS.md.
function renderRoleSelect(container) {
  container.appendChild(paragraph(t("appTagline"), "tagline"));

  const row = document.createElement("div");
  row.className = "role-row";
  row.appendChild(button(t("startReceive"), () => startReceiverFlow(container), "primary-button start-button"));
  row.appendChild(button(t("startSend"), () => advance(container, { screen: "sender-scanning" }), "primary-button start-button"));
  container.appendChild(row);

  const link = button(t("remoteCodeLink"), () => advance(container, { screen: "code-role-select" }), "link-button");
  container.appendChild(link);
}

function renderCodeRoleSelect(container) {
  container.appendChild(paragraph(t("codeRoleChooseTitle")));

  const row = document.createElement("div");
  row.className = "role-row";
  row.appendChild(button(t("roleReceive"), () => startReceiverCodeFlow(container)));
  row.appendChild(button(t("roleSend"), () => advance(container, { screen: "code-sender-entry" })));
  container.appendChild(row);

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

  const shareStatus = paragraph("", "muted");
  shareStatus.hidden = true;
  container.appendChild(button(t("copyCodeButton"), () => shareOrCopy({ text: formatted }, shareStatus)));
  container.appendChild(shareStatus);

  container.appendChild(button(t("backButton"), () => setState(container, { screen: "code-role-select" })));
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
  container.appendChild(button(t("backButton"), () => setState(container, { screen: "code-role-select" })));
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

/**
 * Shares or copies a pairing secret (a URL carrying the QR link, or
 * plain text for a pairing code) via whatever the browser supports,
 * reporting the outcome in statusEl. Falls through in order:
 *   1. The native share sheet (`navigator.share`), if available — the
 *      user picking "cancel" there is not an error.
 *   2. Copying to the clipboard (`navigator.clipboard.writeText`).
 *   3. A hint to copy the already-visible text manually — the only
 *      option left on a plain-HTTP LAN connection, where Clipboard
 *      Write and often Web Share itself aren't available (both
 *      generally require a secure context) — see README's note on
 *      plain-HTTP LAN use still supporting manual paste.
 * Only ever called directly from a click handler: both APIs require
 * a user gesture.
 */
async function shareOrCopy({ url, text }, statusEl) {
  if (navigator.share) {
    try {
      await navigator.share(url ? { url } : { text });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return; // user dismissed the share sheet
      // Otherwise fall through to the clipboard fallback below.
    }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(url || text);
      statusEl.textContent = t("shareCopied");
      statusEl.hidden = false;
      return;
    } catch {
      // Fall through to the manual-copy hint below.
    }
  }
  statusEl.textContent = t("shareCopyManually");
  statusEl.hidden = false;
}

function renderReceiverWaiting(container) {
  container.appendChild(paragraph(t("receiverWaiting")));

  const canvas = document.createElement("canvas");
  canvas.className = "qr-canvas";
  container.appendChild(canvas);
  renderQR(canvas, currentState.url, 240);

  container.appendChild(paragraph(t("receiverLinkLabel"), "muted"));
  container.appendChild(paragraph(currentState.url, "pairing-link"));
  container.appendChild(paragraph(t("shareSecurityWarning"), "warning-text"));

  const shareStatus = paragraph("", "muted");
  shareStatus.hidden = true;
  container.appendChild(button(t("shareButton"), () => shareOrCopy({ url: currentState.url }, shareStatus)));
  container.appendChild(shareStatus);

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
    button(t("pasteLinkInsteadButton"), () => {
      cancelled = true;
      setState(container, { screen: "sender-paste" });
    }, "link-button"),
  );
  container.appendChild(
    button(t("backButton"), () => {
      cancelled = true;
      setState(container, { screen: "role-select" });
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
  container.appendChild(button(t("backButton"), () => setState(container, { screen: "sender-scanning" })));
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
let swapStatusEl = null;
let swapButtonEl = null;

function showReconnectStatus(text) {
  if (!reconnectStatusEl) return;
  reconnectStatusEl.textContent = text || "";
  reconnectStatusEl.hidden = !text;
}

function showSwapStatus(text) {
  if (!swapStatusEl) return;
  swapStatusEl.textContent = text || "";
  swapStatusEl.hidden = !text;
}

function renderPaired(container) {
  // Re-rendering (e.g. after a reconnect, a peer_reconnected
  // notification, or a role swap) must detach the previous transfer
  // UI's socket listener first — see detachActiveTransfer. Any swap
  // negotiation in flight before this render is now stale (the state
  // it was tracking just changed underneath it), so drop it too
  // rather than leave the button permanently disabled.
  detachActiveTransfer();
  swapAwaitingResponse = false;

  const text = currentState.role === "host" ? t("statusPairedHost") : t("statusPairedGuest");
  container.appendChild(paragraph(text, "status-paired"));

  reconnectStatusEl = paragraph("", "muted");
  reconnectStatusEl.hidden = true;
  container.appendChild(reconnectStatusEl);

  swapButtonEl = button(t("swapRolesButton"), () => requestRoleSwap(container));
  container.appendChild(swapButtonEl);
  swapStatusEl = paragraph("", "muted");
  swapStatusEl.hidden = true;
  container.appendChild(swapStatusEl);

  // Grouped with the other paired-session-level actions, above the
  // transfer UI, so it stays visible without scrolling once a file
  // list grows long — it was previously placed after the transfer UI
  // and users couldn't find it (see docs/DECISIONS.md).
  container.appendChild(button(t("disconnectButton"), () => disconnectSession(container), "danger-button"));

  const transferRoot = document.createElement("div");
  container.appendChild(transferRoot);
  renderTransferUI(transferRoot, getPairedSession(), (files) => {
    // The socket wasn't usable at the moment these were picked (see
    // transfer-ui.js's handlePicked) — most likely because this tab
    // was frozen by the browser for backgrounding into another app
    // (Google Photos in particular) for long enough that even
    // attemptReconnect's own retry loop couldn't start running until
    // just now. See docs/DECISIONS.md.
    //
    // A *different*, already-reconnected handle may already exist by
    // now, though (reconnect can finish before a slow picker
    // interaction returns) — check readiness explicitly and use it
    // right away in that case, rather than only ever queuing: nothing
    // else would trigger a flush of the queue if a fresh render
    // already happened before this fired. Checking readiness here
    // (instead of just calling activeTransferHandle.sendFiles and
    // letting *it* decide) also avoids a same-handle bounce loop —
    // sendFiles would otherwise call straight back into this same
    // callback if activeTransferHandle turns out to still be the
    // not-yet-superseded, not-ready handle currently running it.
    const live = getPairedSession();
    if (activeTransferHandle && activeTransferHandle.sendFiles && live && live.socket && live.socket.readyState === WebSocket.OPEN) {
      activeTransferHandle.sendFiles(files);
    } else {
      pendingSendFiles = files;
    }
  }).then((handle) => {
    activeTransferHandle = handle;
    if (pendingSendFiles && handle.sendFiles) {
      const files = pendingSendFiles;
      pendingSendFiles = null;
      handle.sendFiles(files);
    }
  });
}

/** Manually ends the session on request — the escape hatch for when a
 * user just wants out: stuck mid-reconnect (see attemptReconnect's
 * retry loop above), or simply done and not waiting for the other
 * side to notice. Tells the relay via `end_session` so the other peer
 * gets a clean `session_ended` (reason `ended_by_peer`) instead of
 * just seeing this side vanish — but only if there's actually a live
 * socket to send it on; mid-reconnect there isn't one yet (activeSocket
 * is nulled out as soon as the previous one drops — see
 * wirePairedSocket), and setState below still correctly abandons any
 * in-flight reconnect attempt either way, since attemptReconnect's own
 * closures bail out once currentState.screen is no longer "paired". */
function disconnectSession(container) {
  if (activeSocket) {
    try {
      sendEnvelope(activeSocket, "end_session", null);
    } catch {
      // Socket already unusable; nothing to notify — falls through to
      // the local cleanup below regardless.
    }
  }
  setState(container, { screen: "role-select" });
}

/** Flips this client's transferRole (sender<->receiver) and
 * re-renders. Used both when we initiate a swap (after the other side
 * accepts) and when we're on the receiving end of one (after we
 * accept it ourselves) — see wirePairedSocket. */
function flipTransferRole(container) {
  currentState = {
    ...currentState,
    transferRole: currentState.transferRole === "sender" ? "receiver" : "sender",
  };
  render(container);
}

/** Asks the other peer to swap sender/receiver roles. Refuses locally
 * if a transfer is currently active on this side (swapping mid-file
 * would corrupt it — see docs/DECISIONS.md); the other side applies
 * the same check before accepting. */
function requestRoleSwap(container) {
  if (activeTransferHandle && activeTransferHandle.isActive()) {
    showSwapStatus(t("swapBusyLocal"));
    return;
  }
  if (swapAwaitingResponse) return;

  swapAwaitingResponse = true;
  if (swapButtonEl) swapButtonEl.disabled = true;
  showSwapStatus(t("swapRequesting"));
  sendEnvelope(activeSocket, "role_swap_request", null);

  setTimeout(() => {
    if (!swapAwaitingResponse) return; // already resolved (accepted/rejected/re-rendered)
    swapAwaitingResponse = false;
    if (swapButtonEl) swapButtonEl.disabled = false;
    showSwapStatus(t("swapTimedOut"));
  }, ROLE_SWAP_TIMEOUT_MS);
}

/** Finishes the pairing flow common to all four pairing paths (QR
 * host/guest, code host/guest): registers this peer's reconnect token
 * with the relay, wires up automatic reconnection for the paired
 * socket, and moves to the "paired" screen. sessionId must be the
 * relay's session ID (from session_created for QR, or from paired's
 * payload for code+PAKE — see proto.PairedPayload). */
function finalizePaired(container, socket, sessionId, sessionKey, role) {
  currentState = {
    screen: "paired",
    sessionId,
    sessionKey,
    role,
    epoch: 0,
    transferRole: role === "host" ? "receiver" : "sender",
  };
  deriveReconnectToken(sessionKey, sessionId).then((token) => {
    currentState = { ...currentState, reconnectToken: token };
    sendEnvelope(socket, "reconnect_token", { tokenHex: toHex(token) });
  });
  wirePairedSocket(container, socket);
  render(container);
}

/** Attaches the listeners that keep a paired session alive across a
 * dropped connection (session_ended, peer_reconnected, close ->
 * attemptReconnect) and that handle the other side's role-swap
 * requests/responses. */
function wirePairedSocket(container, socket) {
  socket.addEventListener("message", (event) => {
    const env = parseEnvelope(event);
    if (!env) return;
    if (env.type === "session_ended") {
      // The specific reason (ended_by_peer / peer_timeout /
      // inactivity_timeout — see docs/PROTOCOL.md) drives which
      // message is shown; using the literal message type here instead
      // would always show the same generic text regardless of why the
      // session actually ended.
      setState(container, { screen: "error", code: (env.payload && env.payload.reason) || "session_ended" });
    } else if (env.type === "peer_disconnected") {
      // The *other* side's connection dropped — ours is still fine.
      // Without this, a transfer in progress at that moment (the
      // receiver mid-file, or the sender about to send the next
      // chunk) just silently stops with no explanation: sendFile/
      // attachReceiver only notice their *own* socket closing, not a
      // peer_disconnected relayed about someone else's. Reusing the
      // same "reconnecting" wording/element as attemptReconnect below
      // since it's accurate from either side's perspective, and it's
      // replaced by a fresh render the moment peer_reconnected (or
      // session_ended, if they don't come back) arrives.
      showReconnectStatus(t("reconnecting"));
    } else if (env.type === "peer_reconnected") {
      // The fresh render() below clears the container (see its own
      // implementation), which discards whatever "reconnecting..."
      // status the peer_disconnected branch above may have shown —
      // no separate clear needed here.
      currentState = { ...currentState, epoch: currentState.epoch + 1 };
      render(container);
    } else if (env.type === "role_swap_request") {
      // Reject if we're mid-transfer (would corrupt it), or if we
      // ourselves already have a swap request in flight (a near-
      // simultaneous mutual request — reject both rather than risk a
      // double-flip; either side can just click again).
      const busy = (activeTransferHandle && activeTransferHandle.isActive()) || swapAwaitingResponse;
      sendEnvelope(socket, "role_swap_response", { accepted: !busy });
      if (!busy) flipTransferRole(container);
    } else if (env.type === "role_swap_response") {
      if (!swapAwaitingResponse) return; // already timed out, or state moved on
      swapAwaitingResponse = false;
      if (env.payload && env.payload.accepted) {
        flipTransferRole(container);
      } else {
        showSwapStatus(t("swapRejected"));
        if (swapButtonEl) swapButtonEl.disabled = false;
      }
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
  ended_by_peer: "errEndedByPeer",
  peer_timeout: "errSessionEnded",
  inactivity_timeout: "errInactivityTimeout",
  invalid_reconnect_token: "errConnectionLost",
};

function renderError(container) {
  const key = ERROR_MESSAGE_KEYS[currentState.code] || "errGeneric";
  container.appendChild(paragraph(t(key), "error-text"));
  container.appendChild(button(t("tryAgain"), () => setState(container, { screen: "role-select" }), "primary-button"));
}
