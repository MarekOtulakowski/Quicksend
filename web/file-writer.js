// Saves incoming file bytes as they arrive. Two of the three tiers
// from the original design are implemented here: the File System
// Access API (writes straight to disk, works for files of any size)
// and an in-memory Blob fallback (buffers the whole file, so it's
// only reasonable for smaller files — see BLOB_FALLBACK_WARN_BYTES).
// The third tier, Service Worker streaming (for Firefox/Safari to get
// disk-backed writes without File System Access support), is not yet
// implemented — see docs/DECISIONS.md.

/** Above this size, the Blob fallback will hold the entire file in
 * memory at once; callers should warn the user before proceeding. */
export const BLOB_FALLBACK_WARN_BYTES = 200 * 1024 * 1024;

/** How long a Blob-mode sink's preview URL (see createFileSink's
 * getPreviewUrl) stays valid before being revoked automatically.
 * Generous enough that a user has time to notice and click "Open"
 * without worrying about a race, while still eventually freeing the
 * memory rather than holding every received file for the rest of the
 * page's life. */
const PREVIEW_URL_LIFETIME_MS = 10 * 60 * 1000;

export function hasFileSystemAccess() {
  return typeof window.showSaveFilePicker === "function";
}

export function hasDirectoryAccess() {
  return typeof window.showDirectoryPicker === "function";
}

/**
 * Lets the user pick a folder once; every file passed to createFileSink
 * afterward (via its dirHandle argument) is written straight into it,
 * with no further per-file save dialogs. Must be called directly from
 * a click handler — like showSaveFilePicker, browsers only allow this
 * in response to a genuine user gesture. Returns null if the user
 * cancels or the API isn't available, in which case callers should
 * fall back to createFileSink's per-file picker.
 */
export async function chooseSaveDirectory() {
  if (!hasDirectoryAccess()) return null;
  try {
    return await window.showDirectoryPicker({ mode: "readwrite" });
  } catch {
    return null; // cancelled, or permission denied
  }
}

/**
 * Creates a sink for one incoming file. Returns
 * { write(chunk), close(), abort(), mode: "fsa"|"blob", getPreviewUrl }.
 * write/close/abort all return Promises. getPreviewUrl() returns null
 * except in "blob" mode after close() resolves, where it returns an
 * object URL the caller can offer as an "Open" link — the file went
 * straight to the browser's downloads, so unlike the FSA modes (which
 * write to a location the user picked and can navigate back to
 * themselves) there's otherwise no way back to it without digging
 * through the downloads list.
 *
 * If dirHandle (a FileSystemDirectoryHandle from chooseSaveDirectory)
 * is given, the file is created directly inside it — no dialog at
 * all. Otherwise falls back to a per-file showSaveFilePicker prompt,
 * and finally to an in-memory Blob download if neither API is usable.
 */
export async function createFileSink(name, mime, dirHandle) {
  if (dirHandle) {
    try {
      const handle = await dirHandle.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      return {
        mode: "fsa",
        write: (chunk) => writable.write(chunk),
        close: () => writable.close(),
        abort: () => writable.abort(),
        getPreviewUrl: () => null,
      };
    } catch {
      // e.g. a name the filesystem rejects, or permission revoked
      // mid-session — fall through to the per-file picker below
      // rather than failing the transfer outright.
    }
  }

  if (hasFileSystemAccess()) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name });
      const writable = await handle.createWritable();
      return {
        mode: "fsa",
        write: (chunk) => writable.write(chunk),
        close: () => writable.close(),
        abort: () => writable.abort(),
        getPreviewUrl: () => null,
      };
    } catch {
      // Picker cancelled, or FSA otherwise unavailable at runtime —
      // fall back to the Blob sink below rather than failing the
      // transfer outright. Proper user-facing cancellation is part of
      // the dedicated "abort transfer" build step.
    }
  }

  const parts = [];
  let previewUrl = null;
  return {
    mode: "blob",
    write: (chunk) => {
      parts.push(chunk);
      return Promise.resolve();
    },
    close: () => {
      const blob = new Blob(parts, { type: mime || "application/octet-stream" });
      previewUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = previewUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = null;
      }, PREVIEW_URL_LIFETIME_MS);
      return Promise.resolve();
    },
    abort: () => {
      parts.length = 0;
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = null;
      }
      return Promise.resolve();
    },
    getPreviewUrl: () => previewUrl,
  };
}
