// Renders the post-pairing screen: a file picker + per-file progress
// for the sender, an incoming-file list for the receiver. Built on
// transfer.js (encryption/framing/flow-control) and file-writer.js
// (saving). Pairing "host" is always the file receiver and "guest"
// the sender for this initial session — see docs/DECISIONS.md.

import { t } from "./i18n.js";
import { deriveEpochKey } from "./crypto.js";
import { sendFile, attachReceiver } from "./transfer.js";
import { createFileSink, BLOB_FALLBACK_WARN_BYTES } from "./file-writer.js";

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function createFileRow(list, name, size) {
  const li = document.createElement("li");
  li.className = "file-row";

  const nameEl = document.createElement("span");
  nameEl.className = "file-name";
  nameEl.textContent = size !== undefined ? `${name} (${formatBytes(size)})` : name;

  const progressEl = document.createElement("progress");
  progressEl.max = 100;
  progressEl.value = 0;

  const statusEl = document.createElement("span");
  statusEl.className = "file-status muted";

  li.appendChild(nameEl);
  li.appendChild(progressEl);
  li.appendChild(statusEl);
  list.appendChild(li);

  return { progressEl, statusEl };
}

/**
 * Renders the transfer UI into container for the current epoch, and
 * returns a cleanup function the caller must invoke before rendering
 * over it again (e.g. on reconnect) or leaving the paired screen —
 * otherwise the receiver's socket listener from the previous render
 * outlives it (the socket itself isn't torn down on a reconnect that
 * only affects the *other* peer) and keeps trying to decrypt new
 * traffic with a now-stale epoch key.
 */
export async function renderTransferUI(container, session) {
  container.innerHTML = "";
  container.className = "transfer";

  // epoch advances by one on every successful reconnect (either side),
  // so files sent after a reconnect are encrypted under a fresh key —
  // see cryptoutil.DeriveEpochKey / docs/DECISIONS.md. Re-deriving it
  // here means a reconnect must re-render this UI (see pairing.js),
  // which also means an in-flight transfer at the time of the drop is
  // not resumed; the user resends the file.
  const epochKey = await deriveEpochKey(session.sessionKey, session.epoch || 0);

  if (session.role === "host") {
    return renderReceiverTransfer(container, session.socket, epochKey);
  }
  renderSenderTransfer(container, session.socket, epochKey);
  return () => {};
}

function renderSenderTransfer(container, socket, epochKey) {
  const hint = document.createElement("p");
  hint.textContent = t("transferSenderHint");
  container.appendChild(hint);

  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  container.appendChild(input);

  const list = document.createElement("ul");
  list.className = "file-list";
  container.appendChild(list);

  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    input.value = "";
    input.disabled = true;

    for (const file of files) {
      const row = createFileRow(list, file.name, file.size);
      row.statusEl.textContent = t("transferSending");
      try {
        await sendFile(socket, epochKey, file, {
          onProgress: ({ sent, total }) => {
            row.progressEl.value = total > 0 ? Math.round((sent / total) * 100) : 100;
          },
        });
        row.progressEl.value = 100;
        row.statusEl.textContent = t("transferSent");
      } catch {
        row.statusEl.textContent = t("transferError");
      }
    }

    input.disabled = false;
  });
}

function renderReceiverTransfer(container, socket, epochKey) {
  const status = document.createElement("p");
  status.textContent = t("transferWaitingForFiles");
  container.appendChild(status);

  const list = document.createElement("ul");
  list.className = "file-list";
  container.appendChild(list);

  const rows = {};

  return attachReceiver(socket, epochKey, {
    onFileStart: async ({ fileId, name, size, mime }) => {
      status.textContent = t("transferReceivingFiles");
      const row = createFileRow(list, name, size);
      const sink = await createFileSink(name, mime);
      rows[fileId] = { ...row, sink, received: 0, size };

      if (sink.mode === "blob" && size > BLOB_FALLBACK_WARN_BYTES) {
        row.statusEl.textContent = t("transferLargeFileWarning");
      }
    },
    onChunk: async ({ fileId, plaintext }) => {
      const row = rows[fileId];
      if (!row) return;
      await row.sink.write(plaintext);
      row.received += plaintext.length;
      row.progressEl.value = row.size > 0 ? Math.round((row.received / row.size) * 100) : 100;
    },
    onFileComplete: async ({ fileId }) => {
      const row = rows[fileId];
      if (!row) return;
      await row.sink.close();
      row.progressEl.value = 100;
      row.statusEl.textContent = row.sink.mode === "fsa" ? t("transferSavedToDisk") : t("transferDownloaded");
    },
    onError: (err) => {
      status.textContent = t("transferError");
      // A connection drop abandons whatever file was in flight; mark
      // it errored and discard its partial write rather than leaving
      // the progress bar frozen mid-way with no explanation.
      for (const row of Object.values(rows)) {
        if (!row.statusEl.textContent) {
          row.statusEl.textContent = t("transferError");
          row.sink.abort();
        }
      }
      // eslint-disable-next-line no-console
      console.error("transfer error:", err);
    },
  });
}
