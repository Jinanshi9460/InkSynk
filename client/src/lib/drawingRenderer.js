// Pure canvas rendering helpers (no React, no sockets).
//
// Stroke points are normalized (0..1). They are scaled to the canvas bitmap size at draw
// time, and the brush size (in "virtual pixels" of an 800px-wide canvas) scales with the
// canvas width - so the same stroke looks identical on any screen size, and a resize is
// just "redraw everything from history".

export const VIRTUAL_WIDTH = 800;
export const ASPECT = 3 / 4; // canvas height / width, fixed so normalized x/y stay aligned
export const ERASER_COLOR = '#ffffff';

export function clearCanvas(ctx, w, h) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
}

/**
 * Draw `stroke.points` from `fromIndex` onward.
 * - fromIndex 0: draws the starting dot (so a single tap leaves a mark) plus any segments.
 * - fromIndex n: draws only the new segments from point n-1 -> n, n+1, ...
 * Used both incrementally (live drawing) and for full redraws, giving identical output.
 */
export function drawSegments(ctx, stroke, fromIndex, w, h) {
  const pts = stroke.points;
  if (!pts.length) return;
  const color = stroke.mode === 'eraser' ? ERASER_COLOR : stroke.color;
  const lineWidth = Math.max(1, (stroke.size * w) / VIRTUAL_WIDTH);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;

  if (fromIndex === 0) {
    ctx.beginPath();
    ctx.arc(pts[0][0] * w, pts[0][1] * h, lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  // One path per segment (not one long path): the result is then identical no matter how the
  // points were batched, so live (incremental) drawing == a full redraw from history.
  for (let i = Math.max(1, fromIndex); i < pts.length; i += 1) {
    ctx.beginPath();
    ctx.moveTo(pts[i - 1][0] * w, pts[i - 1][1] * h);
    ctx.lineTo(pts[i][0] * w, pts[i][1] * h);
    ctx.stroke();
  }
}

export function renderAll(ctx, strokes, w, h) {
  clearCanvas(ctx, w, h);
  for (const stroke of strokes) drawSegments(ctx, stroke, 0, w, h);
}
