import { DRAW_LIMITS } from '../events.js';
import { sounds } from '../lib/audio.js';

const COLORS = [
  '#000000', '#4b5563', '#9ca3af', '#ffffff',
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#10b981', '#06b6d4', '#3b82f6', '#6366f1',
  '#8b5cf6', '#ec4899', '#92400e', '#f5d0a9',
];

const SIZES = [2, 5, 10, 20, 32];

export default function DrawingToolbar({
  tool, setTool, color, setColor, size, setSize, disabled, canUndo, onUndo, onClear,
}) {
  const clampedSizes = SIZES.filter((s) => s >= DRAW_LIMITS.size.min && s <= DRAW_LIMITS.size.max);

  function handleTool(nextTool) {
    sounds.play('click');
    setTool(nextTool);
  }

  function handleColor(c) {
    sounds.play('pop');
    setColor(c);
    setTool('pen');
  }

  function handleSize(s) {
    sounds.play('click');
    setSize(s);
  }

  function handleUndo() {
    sounds.play('click');
    onUndo();
  }

  function handleClear() {
    sounds.play('wrong');
    onClear();
  }

  return (
    <div
      className={`drawing-toolbar ${disabled ? 'toolbar-disabled' : ''}`}
      role="toolbar"
      aria-label="Drawing tools"
      aria-disabled={disabled}
    >
      {/* Tool Selector */}
      <div className="toolbar-section tool-toggle-group" role="group" aria-label="Tool selection">
        <button
          type="button"
          className={`btn toolbar-tool-btn ${tool === 'pen' ? 'is-active' : ''}`}
          aria-pressed={tool === 'pen'}
          disabled={disabled}
          onClick={() => handleTool('pen')}
          title="Pen Tool (B)"
        >
          ✏️ <span className="tool-btn-text">Pen</span>
        </button>
        <button
          type="button"
          className={`btn toolbar-tool-btn ${tool === 'eraser' ? 'is-active' : ''}`}
          aria-pressed={tool === 'eraser'}
          disabled={disabled}
          onClick={() => handleTool('eraser')}
          title="Eraser Tool (E)"
        >
          🧽 <span className="tool-btn-text">Eraser</span>
        </button>
      </div>

      {/* Color Palette Swatches */}
      <div className="toolbar-section swatches-grid" role="group" aria-label="Color Palette">
        {COLORS.map((c) => {
          const isActive = tool === 'pen' && color === c;
          return (
            <button
              key={c}
              type="button"
              className={`color-swatch-btn ${isActive ? 'is-active' : ''}`}
              style={{ backgroundColor: c, border: c === '#ffffff' ? '2px solid #d1d5db' : undefined }}
              aria-label={`Color ${c}`}
              aria-pressed={isActive}
              disabled={disabled}
              onClick={() => handleColor(c)}
            />
          );
        })}
      </div>

      {/* Brush Thickness Sizes */}
      <div className="toolbar-section brush-sizes-group" role="group" aria-label="Brush width">
        {clampedSizes.map((s) => {
          const isActive = size === s;
          return (
            <button
              key={s}
              type="button"
              className={`btn size-picker-btn ${isActive ? 'is-active' : ''}`}
              aria-label={`Brush size ${s}`}
              aria-pressed={isActive}
              disabled={disabled}
              onClick={() => handleSize(s)}
              title={`Size ${s}px`}
            >
              <span
                className="size-dot-preview"
                style={{
                  width: Math.max(4, Math.min(22, s * 0.7 + 3)),
                  height: Math.max(4, Math.min(22, s * 0.7 + 3)),
                  backgroundColor: tool === 'eraser' ? '#9ca3af' : color,
                }}
              />
            </button>
          );
        })}
      </div>

      {/* Actions (Undo & Clear) */}
      <div className="toolbar-section toolbar-actions-group">
        <button
          type="button"
          className="btn btn-action-btn"
          disabled={disabled || !canUndo}
          onClick={handleUndo}
          title="Undo last stroke (Ctrl+Z)"
        >
          ↩ <span className="action-label">Undo</span>
        </button>
        <button
          type="button"
          className="btn btn-danger-soft btn-action-btn"
          disabled={disabled}
          onClick={handleClear}
          title="Clear entire canvas"
        >
          🗑 <span className="action-label">Clear</span>
        </button>
      </div>
    </div>
  );
}
