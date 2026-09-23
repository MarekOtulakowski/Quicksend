// Renders the post-pairing screen: a file picker + per-file progress
// for the sender, an incoming-file list for the receiver. Built on
// transfer.js (encryption/framing/flow-control) and file-writer.js
// (saving). Which side sends and which receives starts out following
// pairing role (host = receiver, guest = sender) but can be flipped
// independently via role swap — see pairing.js and docs/DECISIONS.md.

import { t } from "./i18n.js";
import { deriveEpochKey } from "./crypto.js";
import { sendFile, attachReceiver } from "./transfer.js";
import { createFileSink, chooseSaveDirectory, hasDirectoryAccess, BLOB_FALLBACK_WARN_BYTES } from "./file-writer.js";

/** Picks the status text for a canceled transfer: the relay's own
 * size-limit cancellation (see server/internal/session's
 * recordChunkBytes) gets a specific message; a cancel from either
 * side clicking Cancel just says "Canceled". */
function abortStatusText(reason) {
  return reason === "size_limit_exceeded" ? t("transferTooLarge") : t("transferCanceled");
}

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

  // Only ever shown for a received file saved via the Blob fallback
  // (see file-writer.js's getPreviewUrl) — a save via the File System
  // Access API already went to a location the user picked themselves,
  // so there's nothing this would add there.
  const openLink = document.createElement("a");
  openLink.className = "file-open";
  openLink.textContent = t("openFileLink");
  openLink.target = "_blank";
  openLink.rel = "noopener";
  openLink.hidden = true;

  li.appendChild(nameEl);
  li.appendChild(progressEl);
  li.appendChild(statusEl);
  li.appendChild(openLink);
  li.appendChild(cancelBtn);
  list.appendChild(li);

  return { progressEl, statusEl, cancelBtn, openLink };
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

  // A drop zone wrapping the native file input: the input itself picks
  // up a proper button style via CSS (::file-selector-button) instead
  // of the browser's small, easy-to-miss default control, and the
  // whole zone also accepts a drag-and-drop of files from the desktop.
  const dropZone = document.createElement("div");
  dropZone.className = "drop-zone";

  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  dropZone.appendChild(input);

  const dropHint = document.createElement("p");
  dropHint.className = "muted drop-hint";
  dropHint.textContent = t("dropHint");
  dropZone.appendChild(dropHint);

  container.appendChild(dropZone);

  const list = document.createElement("ul");
  list.className = "file-list";
  container.appendChild(list);

  let sending = false;

  async function sendFiles(files) {
    // Matches input.disabled's existing effect of making the file
    // picker unopenable mid-send: a drop while already sending isn't
    // queued, just ignored, so batches don't interleave.
    if (sending || files.length === 0) return;
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
        row.statusEl.textContent = err && err.name === "AbortError" ? abortStatusText(err.reason) : t("transferError");
      }
      row.cancelBtn.hidden = true;
    }

    sending = false;
    input.disabled = false;
  }

  input.addEventListener("change", () => {
    const files = Array.from(input.files || []);
    input.value = "";
    sendFiles(files);
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add("drop-zone-active");
    }),
  );
  ["dragleave", "dragend", "drop"].forEach((evt) =>
    dropZone.addEventListener(evt, () => dropZone.classList.remove("drop-zone-active")),
  );
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    sendFiles(Array.from(e.dataTransfer.files || []));
  });

  return { detach: () => {}, isActive: () => sending };
}

/** Picks a name that isn't already in usedNames, appending " (1)",
 * " (2)", etc. before the extension if needed, and records whichever
 * name it returns. Only matters once files are written straight into
 * a chosen folder (see chooseSaveDirectory) without per-file dialogs
 * — a per-file showSaveFilePicker or the Blob-download fallback both
 * already let the user (or the browser) handle a name collision on
 * their own. */
export function dedupeFilename(usedNames, name) {
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate;
  let i = 1;
  do {
    candidate = `${base} (${i})${ext}`;
    i++;
  } while (usedNames.has(candidate));
  usedNames.add(candidate);
  return candidate;
}

function renderReceiverTransfer(container, socket, epochKey) {
  const status = document.createElement("p");
  status.textContent = t("transferWaitingForFiles");
  container.appendChild(status);

  // Asking once for a destination folder — instead of a native save
  // dialog per incoming file — needs a directory handle obtained from
  // a real click (browsers require a user gesture for
  // showDirectoryPicker, so this can't happen automatically). If the
  // user never clicks it, or the browser doesn't support it at all,
  // each file falls back to its own per-file prompt as before.
  let saveDirHandle = null;
  const usedNames = new Set();

  if (hasDirectoryAccess()) {
    const folderRow = document.createElement("p");
    folderRow.className = "muted";
    const chooseBtn = document.createElement("button");
    chooseBtn.type = "button";
    chooseBtn.textContent = t("chooseSaveFolderButton");
    const folderStatus = document.createElement("span");
    chooseBtn.addEventListener("click", async () => {
      const handle = await chooseSaveDirectory();
      if (handle) {
        saveDirHandle = handle;
        usedNames.clear();
        chooseBtn.textContent = t("changeSaveFolderButton");
        folderStatus.textContent = ` ${t("saveFolderChosenPrefix")} "${handle.name}"`;
      }
    });
    folderRow.appendChild(chooseBtn);
    folderRow.appendChild(folderStatus);
    container.appendChild(folderRow);
  }

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
      const saveName = saveDirHandle ? dedupeFilename(usedNames, name) : name;
      const sink = await createFileSink(saveName, mime, saveDirHandle);
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
      const previewUrl = row.sink.getPreviewUrl();
      if (previewUrl) {
        row.openLink.href = previewUrl;
        row.openLink.hidden = false;
      }
    },
    onAborted: ({ fileId, reason }) => {
      receiving = false;
      status.textContent = t("transferWaitingForFiles");
      const row = rows[fileId];
      if (!row) return;
      row.done = true;
      row.cancelBtn.hidden = true;
      row.statusEl.textContent = abortStatusText(reason);
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
