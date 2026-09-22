// Thin wrapper around the relay's WebSocket protocol (see
// docs/PROTOCOL.md). Deliberately minimal: it just opens the socket
// and (de)serializes the JSON envelope, leaving all session-lifecycle
// logic to callers (pairing.js today; transfer/reconnect later).

export function connect() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${scheme}//${location.host}/ws`);
}

export function sendEnvelope(socket, type, payload) {
  socket.send(JSON.stringify({ type, payload }));
}

/** Parses one WebSocket text-frame MessageEvent into an envelope, or
 * null if it isn't valid JSON (or is a binary frame). */
export function parseEnvelope(event) {
  if (typeof event.data !== "string") return null;
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}
