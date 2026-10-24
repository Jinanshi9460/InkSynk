import { useCallback, useEffect, useRef } from 'react';
import { DRAW_LIMITS, EVENTS } from '../events.js';
import { ASPECT, clearCanvas, drawSegments, renderAll } from '../lib/drawingRenderer.js';

const FLUSH_MS = 30; // how often buffered points are sent (about 33 messages/second max)
const MAX_LOCAL_POINTS = DRAW_LIMITS.maxPointsPerStroke - 100; // stay under the server cap
const MIN_STEP = 0.0008; // ignore pointer jitter smaller than ~0.1% of the canvas

const round4 = (n) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;

function newStrokeId() {
  const rand = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 20)
    ?? Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  return `s${rand}`;
}

/**
 * HTML5 canvas that both draws (if `canDraw`) and mirrors strokes from the server.
 *
 * Data model: `strokes` (ordered history, same shape as the server's) is the single source of
 * truth for what is on screen. Every redraw (resize, undo, clear, sync) re-renders from it.
 *
 *  - Drawer: renders its own stroke immediately and streams batched points to the server.
 *    The server does NOT echo draw_data back to the drawer, so nothing is drawn twice.
 *  - Everyone else: applies draw_data / draw_undo / canvas_clear from the server.
 *  - Undo & clear: applied (for the drawer too) when the server broadcasts them.
 *  - Sync: `draw_sync` on mount and whenever `syncTick` changes replaces local history.
 */
export default function DrawingCanvas({
  canDraw, connected, tool, color, size, send, request, subscribe,
  syncTick, onStrokeCountChange, onError,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const strokesRef = useRef([]);
  const byIdRef = useRef(new Map());
  const localRef = useRef(null); // the stroke this client is drawing right now, if any
  const latest = useRef({});
  latest.current = { canDraw, connected, tool, color, size, send, onError };

  // ---------- rendering ----------
  const surface = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width) return null;
    return { ctx: canvas.getContext('2d'), w: canvas.width, h: canvas.height };
  }, []);

  const redraw = useCallback(() => {
    const s = surface();
    if (s) renderAll(s.ctx, strokesRef.current, s.w, s.h);
  }, [surface]);

  const drawNew = useCallback((stroke, fromIndex) => {
    const s = surface();
    if (s) drawSegments(s.ctx, stroke, fromIndex, s.w, s.h);
  }, [surface]);

  const reportCount = useCallback(() => {
    onStrokeCountChange?.(strokesRef.current.filter((s) => s.done).length);
  }, [onStrokeCountChange]);

  const removeStroke = useCallback((id) => {
    byIdRef.current.delete(id);
    strokesRef.current = strokesRef.current.filter((s) => s.id !== id);
  }, []);

  // Forget the local in-progress stroke without telling the server.
  const dropLocal = useCallback((markDone) => {
    const loc = localRef.current;
    if (!loc) return;
    window.clearInterval(loc.timer);
    if (markDone) loc.stroke.done = true;
    localRef.current = null;
  }, []);

  // ---------- keep the bitmap matched to the displayed size ----------
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;
    const resize = () => {
      const cssW = wrap.clientWidth;
      if (!cssW) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(cssW * dpr);
      const h = Math.round(cssW * ASPECT * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; // resizing clears the bitmap...
        canvas.height = h;
      }
      redraw(); // ...so repaint from history
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [redraw]);

  // ---------- incoming events from the server ----------
  useEffect(() => {
    const offData = subscribe(EVENTS.DRAW_DATA, (d) => {
      if (d.phase === 'start') {
        if (byIdRef.current.has(d.stroke.id)) return;
        const stroke = { ...d.stroke, points: [...d.stroke.points], done: false };
        strokesRef.current.push(stroke);
        byIdRef.current.set(stroke.id, stroke);
        drawNew(stroke, 0);
      } else if (d.phase === 'move') {
        const stroke = byIdRef.current.get(d.strokeId);
        if (!stroke || stroke === localRef.current?.stroke) return;
        const prev = stroke.points.length;
        stroke.points.push(...d.points);
        drawNew(stroke, prev);
      } else if (d.phase === 'end') {
        const stroke = byIdRef.current.get(d.strokeId);
        if (stroke) {
          stroke.done = true;
          reportCount();
        }
      }
    });
    const offClear = subscribe(EVENTS.CANVAS_CLEAR, () => {
      dropLocal(false);
      strokesRef.current = [];
      byIdRef.current.clear();
      redraw();
      reportCount();
    });
    const offUndo = subscribe(EVENTS.DRAW_UNDO, ({ strokeId }) => {
      if (localRef.current?.stroke.id === strokeId) dropLocal(false);
      removeStroke(strokeId);
      redraw();
      reportCount();
    });
    return () => {
      offData();
      offClear();
      offUndo();
    };
  }, [subscribe, drawNew, redraw, reportCount, dropLocal, removeStroke]);

  // ---------- history sync (mount, manual resync, reconnect UI) ----------
  useEffect(() => {
    let cancelled = false;
    request(EVENTS.DRAW_SYNC).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        latest.current.onError?.(res.error.message);
        return;
      }
      strokesRef.current = res.strokes.map((s) => ({ ...s, points: [...s.points] }));
      byIdRef.current = new Map(strokesRef.current.map((s) => [s.id, s]));
      // Keep an in-progress local stroke alive on top of the synced copy (its unsent points
      // are not on the server yet, so re-add them).
      const loc = localRef.current;
      if (loc) {
        const synced = byIdRef.current.get(loc.stroke.id);
        if (synced) {
          synced.points.push(...loc.pending);
          loc.stroke = synced;
        } else {
          dropLocal(true);
        }
      }
      redraw();
      reportCount();
    });
    return () => {
      cancelled = true;
    };
  }, [syncTick, request, redraw, reportCount, dropLocal]);

  // Lost the pen (or the connection) mid-stroke: stop sending, keep what is drawn.
  useEffect(() => {
    if (!canDraw || !connected) dropLocal(true);
  }, [canDraw, connected, dropLocal]);

  useEffect(() => () => dropLocal(true), [dropLocal]);

  // ---------- local drawing (pointer events: mouse, touch and pen) ----------
  const toPoint = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return [round4((e.clientX - rect.left) / rect.width), round4((e.clientY - rect.top) / rect.height)];
  };

  const flush = (loc) => {
    while (loc.pending.length) {
      const points = loc.pending.splice(0, DRAW_LIMITS.maxPointsPerMessage);
      latest.current.send(EVENTS.DRAW_MOVE, { strokeId: loc.stroke.id, points });
    }
  };

  const finish = (pointerId) => {
    const loc = localRef.current;
    if (!loc || (pointerId !== undefined && pointerId !== loc.pointerId)) return;
    flush(loc);
    latest.current.send(EVENTS.DRAW_END, { strokeId: loc.stroke.id });
    dropLocal(true);
    reportCount();
  };

  const onPointerDown = (e) => {
    const cur = latest.current;
    if (!cur.canDraw || !cur.connected || localRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);

    const point = toPoint(e);
    const isEraser = cur.tool === 'eraser';
    const stroke = {
      id: newStrokeId(),
      color: isEraser ? '#ffffff' : cur.color,
      size: cur.size,
      mode: isEraser ? 'eraser' : 'pen',
      points: [point],
      done: false,
    };
    strokesRef.current.push(stroke);
    byIdRef.current.set(stroke.id, stroke);
    drawNew(stroke, 0); // immediate local feedback; the server never echoes this back to us

    const loc = { stroke, pending: [], pointerId: e.pointerId, timer: 0 };
    loc.timer = window.setInterval(() => flush(loc), FLUSH_MS);
    localRef.current = loc;

    cur.send(
      EVENTS.DRAW_START,
      { strokeId: stroke.id, x: point[0], y: point[1], color: stroke.color, size: stroke.size, mode: stroke.mode },
      (res) => {
        if (res?.ok) return;
        // Rejected (e.g. lost the pen, canvas full): undo our local drawing.
        if (localRef.current === loc) dropLocal(false);
        if (byIdRef.current.has(stroke.id)) {
          removeStroke(stroke.id);
          redraw();
          reportCount();
        }
        latest.current.onError?.(res?.error?.message ?? 'Drawing was rejected.');
      },
    );
  };

  const onPointerMove = (e) => {
    const loc = localRef.current;
    if (!loc || e.pointerId !== loc.pointerId) return;
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length ? samples : [e.nativeEvent]) {
      const point = toPoint(sample);
      const last = loc.stroke.points[loc.stroke.points.length - 1];
      if (Math.abs(point[0] - last[0]) < MIN_STEP && Math.abs(point[1] - last[1]) < MIN_STEP) continue;
      const prev = loc.stroke.points.length;
      loc.stroke.points.push(point);
      loc.pending.push(point);
      drawNew(loc.stroke, prev);
      if (loc.stroke.points.length >= MAX_LOCAL_POINTS) {
        finish(loc.pointerId); // very long stroke: close it; the next move starts nothing until a new press
        return;
      }
    }
  };

  const onPointerUp = (e) => {
    const loc = localRef.current;
    if (!loc || e.pointerId !== loc.pointerId) return;
    // make sure the release position is included
    const point = toPoint(e);
    const last = loc.stroke.points[loc.stroke.points.length - 1];
    if (point[0] !== last[0] || point[1] !== last[1]) {
      const prev = loc.stroke.points.length;
      loc.stroke.points.push(point);
      loc.pending.push(point);
      drawNew(loc.stroke, prev);
    }
    finish(e.pointerId);
  };

  // Paint a blank canvas before the first sync arrives.
  useEffect(() => {
    const s = surface();
    if (s) clearCanvas(s.ctx, s.w, s.h);
  }, [surface]);

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={`draw-canvas ${canDraw && connected ? 'is-drawable' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => finish(e.pointerId)}
        onLostPointerCapture={(e) => finish(e.pointerId)}
        onContextMenu={(e) => e.preventDefault()}
        role="img"
        aria-label={canDraw && connected ? 'Drawing canvas: you are the drawer' : 'Shared drawing canvas (view only)'}
      />
      {!connected && <div className="canvas-overlay">Disconnected – drawing paused</div>}
    </div>
  );
}
