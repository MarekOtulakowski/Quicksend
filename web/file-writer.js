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

/**
 * Creates a sink for one incoming file. Returns
 * { write(chunk), close(), abort(), mode: "fsa"|"blob" }.
 * write/close/abort all return Promises.
 */
export async function createFileSink(name, mime) {
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
