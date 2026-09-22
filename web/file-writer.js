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
 * { write(chunk), close(), abort(), mode: "fsa"|"blob" }.
 * write/close/abort all return Promises.
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
      };
    } catch {
      // Picker cancelled, or FSA otherwise unavailable at runtime —
      // fall back to the Blob sink below rather than failing the
      // transfer outright. Proper user-facing cancellation is part of
      // the dedicated "abort transfer" build step.
    }
  }

  const parts = [];
  return {
    mode: "blob",
    write: (chunk) => {
      parts.push(chunk);
      return Promise.resolve();
    },
    close: () => {
      const blob = new Blob(parts, { type: mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return Promise.resolve();
    },
    abort: () => {
      parts.length = 0;
      return Promise.resolve();
    },
  };
}
