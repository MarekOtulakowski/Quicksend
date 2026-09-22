import qrcode from "./vendor/qrcode-generator.js";

const QUIET_ZONE_MODULES = 4;

/**
 * Renders text as a QR code onto canvas, sized to fit targetSizePx
 * (including the required quiet-zone margin).
 */
export function renderQR(canvas, text, targetSizePx = 240) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const cellSize = Math.max(1, Math.floor(targetSizePx / (moduleCount + QUIET_ZONE_MODULES * 2)));
  const size = cellSize * (moduleCount + QUIET_ZONE_MODULES * 2);

  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000000";

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.isDark(row, col)) {
        const x = (col + QUIET_ZONE_MODULES) * cellSize;
        const y = (row + QUIET_ZONE_MODULES) * cellSize;
        ctx.fillRect(x, y, cellSize, cellSize);
      }
    }
  }
}
