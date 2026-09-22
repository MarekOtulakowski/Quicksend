import jsQR from "./vendor/jsQR.js";

const SCAN_INTERVAL_MS = 200;

/**
 * Starts scanning the device camera for a QR code, drawing frames into
 * videoEl (which the caller is responsible for showing/hiding). Calls
 * onDecode(text) once with the first successfully decoded payload.
 * Returns a stop() function that releases the camera; callers must
 * call it both on success and when abandoning the scan (e.g. the user
 * switches to manual paste instead).
 */
export async function startScanning(videoEl, onDecode, onError) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
  } catch (err) {
    onError(err);
    return () => {};
  }

  videoEl.srcObject = stream;
  await videoEl.play();

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let stopped = false;
  let timer = null;

  const tick = () => {
    if (stopped) return;
    if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(frame.data, frame.width, frame.height);
      if (result && result.data) {
        stop();
        onDecode(result.data);
        return;
      }
    }
    timer = setTimeout(tick, SCAN_INTERVAL_MS);
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    videoEl.srcObject = null;
  }

  tick();
  return stop;
}
