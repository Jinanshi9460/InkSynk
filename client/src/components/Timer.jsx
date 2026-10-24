import { useEffect, useRef, useState } from 'react';
import { sounds } from '../lib/audio.js';

export default function Timer({ deadline, durationMs, clockOffset = 0, label }) {
  const [now, setNow] = useState(() => Date.now());
  const lastTickedSecond = useRef(-1);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  if (!deadline) return null;

  const remaining = Math.max(0, deadline - (now + clockOffset));
  const seconds = Math.ceil(remaining / 1000);
  const pct = durationMs > 0 ? Math.min(100, (remaining / durationMs) * 100) : 0;
  const urgent = remaining > 0 && remaining <= 10000;
  const critical = remaining > 0 && remaining <= 5000;

  // Sound tick for the final 5 seconds
  if (critical && seconds !== lastTickedSecond.current && seconds > 0) {
    lastTickedSecond.current = seconds;
    sounds.play('tick');
  }

  return (
    <div
      className={`timer-widget ${urgent ? 'timer-urgent' : ''} ${critical ? 'timer-critical' : ''}`}
      role="timer"
      aria-label={label ? `${label}: ${seconds} seconds` : `${seconds} seconds left`}
    >
      <div className="timer-icon-badge">
        <span className="timer-clock-icon">{critical ? '🔥' : '⏱'}</span>
        <span className="timer-value">{seconds}s</span>
      </div>

      <div className="timer-track" aria-hidden="true">
        <div
          className="timer-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
