// Renders the post-pairing screen: a file picker + per-file progress
// for the sender, an incoming-file list for the receiver. Built on
// transfer.js (encryption/framing/flow-control) and file-writer.js
// (saving). Which side sends and which receives starts out following
// pairing role (host = receiver, guest = sender) but can be flipped
// independently via role swap — see pairing.js and docs/DECISIONS.md.

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

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "file-cancel";
  cancelBtn.textContent = t("cancelButton");
  cancelBtn.hidden = true;

  li.appendChild(nameEl);
  li.appendChild(progressEl);
  li.appendChild(statusEl);
  li.appendChild(cancelBtn);
  list.appendChild(li);

  return { progressEl, statusEl, cancelBtn };
}

/**
 * Renders the transfer UI into container for the current epoch and
 * transfer role, and returns { detach, isActive }:
 *   - detach() must be called before rendering over this UI again
 *     (e.g. on reconnect or role swap) or leaving the paired screen —
 *     otherwise the receiver's socket listener from the previous
 *     render outlives it (the socket itself isn't torn down by a
 *     reconnect that only affects the *other* peer, or by a role
 *     swap at all) and keeps trying to decrypt new traffic with a
 *     now-stale epoch key or in the wrong direction.
 *   - isActive() reports whether a send/receive is currently in
 *     progress, so pairing.js can refuse a role swap mid-transfer
 *     instead of corrupting it.
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

  if (session.transferRole === "receiver") {
    return renderReceiverTransfer(container, session.socket, epochKey);
  }
  return renderSenderTransfer(container, session.socket, epochKey);
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

  let sending = false;

  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    input.value = "";
    input.disabled = true;
    sending = true;

    for (const file of files) {
      const row = createFileRow(list, file.name, file.size);
      row.statusEl.textContent = t("transferSending");
      const controller = new AbortController();
      row.cancelBtn.hidden = false;
      row.cancelBtn.addEventListener("click", () => controller.abort(), { once: true });
      try {
        await sendFile(socket, epochKey, file, {
          signal: controller.signal,
          onProgress: ({ sent, total }) => {
            row.progressEl.value = total > 0 ? Math.round((sent / total) * 100) : 100;
          },
        });
        row.progressEl.value = 100;
        row.statusEl.textContent = t("transferSent");
      } catch (err) {
        row.statusEl.textContent = err && err.name === "AbortError" ? t("transferCanceled") : t("transferError");
      }
      row.cancelBtn.hidden = true;
    }

    sending = false;
    input.disabled = false;
  });

  return { detach: () => {}, isActive: () => sending };
}

function renderReceiverTransfer(container, socket, epochKey) {
  const status = document.createElement("p");
  status.textContent = t("transferWaitingForFiles");
  container.appendChild(status);

  const list = document.createElement("ul");
  list.className = "file-list";
  container.appendChild(list);

  const rows = {};
  let receiving = false;

  const { detach, abortCurrent } = attachReceiver(socket, epochKey, {
    onFileStart: async ({ fileId, name, size, mime }) => {
      receiving = true;
      status.textContent = t("transferReceivingFiles");
      const row = createFileRow(list, name, size);
      const sink = await createFileSink(name, mime);
      rows[fileId] = { ...row, sink, received: 0, size, done: false };

      if (sink.mode === "blob" && size > BLOB_FALLBACK_WARN_BYTES) {
        row.statusEl.textContent = t("transferLargeFileWarning");
      }

      row.cancelBtn.hidden = false;
      // Only one file is ever in flight, so this button always cancels
      // "whatever's current" — no need to track which fileId it maps to.
      row.cancelBtn.addEventListener("click", () => abortCurrent(), { once: true });
    },
    onChunk: async ({ fileId, plaintext }) => {
      const row = rows[fileId];
      // row.done guards against a chunk that was already in flight
      // when this file got aborted a moment ago (see transfer.js) —
      // writing to an already-closed/aborted sink would throw.
      if (!row || row.done) return;
      await row.sink.write(plaintext);
      row.received += plaintext.length;
      row.progressEl.value = row.size > 0 ? Math.round((row.received / row.size) * 100) : 100;
    },
    onFileComplete: async ({ fileId }) => {
      receiving = false;
      const row = rows[fileId];
      if (!row) return;
      row.done = true;
      row.cancelBtn.hidden = true;
      await row.sink.close();
      row.progressEl.value = 100;
      row.statusEl.textContent = row.sink.mode === "fsa" ? t("transferSavedToDisk") : t("transferDownloaded");
    },
    onAborted: ({ fileId }) => {
      receiving = false;
      status.textContent = t("transferWaitingForFiles");
      const row = rows[fileId];
      if (!row) return;
      row.done = true;
      row.cancelBtn.hidden = true;
      row.statusEl.textContent = t("transferCanceled");
      row.sink.abort();
    },
    onError: (err) => {
      receiving = false;
      status.textContent = t("transferError");
      // A connection drop abandons whatever file was in flight; mark
      // it errored and discard its partial write rather than leaving
      // the progress bar frozen mid-way with no explanation.
      for (const row of Object.values(rows)) {
        if (!row.done) {
          row.done = true;
          row.cancelBtn.hidden = true;
          row.statusEl.textContent = t("transferError");
          row.sink.abort();
        }
      }
      // eslint-disable-next-line no-console
      console.error("transfer error:", err);
    },
  });

  return { detach, isActive: () => receiving };
}
