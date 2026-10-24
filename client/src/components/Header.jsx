import { useState, useEffect } from 'react';
import { sounds } from '../lib/audio.js';

export default function Header({ connected, everConnected, connectError = false, roomCode }) {
  const [muted, setMuted] = useState(() => sounds.isMuted());

  function handleSoundToggle() {
    const next = sounds.toggleMute();
    setMuted(next);
    if (!next) sounds.play('pop');
  }

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="brand-icon">
            <path d="M12 19l7-7 3 3-7 7-3-3z" />
            <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
            <path d="M2 2l7.586 7.586" />
            <circle cx="11" cy="11" r="2" />
          </svg>
        </span>
        <div className="brand-text">
          <span className="brand-name">Ink<span className="brand-accent">Synk</span></span>
          <span className="brand-tagline">Draw • Guess • Sync</span>
        </div>
      </div>

      <div className="header-right">
        {roomCode && (
          <div className="pill room-pill" title="Current Room">
            <span className="pill-dot" />
            <span>ROOM <strong>{roomCode}</strong></span>
          </div>
        )}

        <button
          type="button"
          className={`sound-toggle-btn ${muted ? 'is-muted' : ''}`}
          onClick={handleSoundToggle}
          title={muted ? 'Unmute game audio' : 'Mute game audio'}
          aria-label={muted ? 'Unmute game audio' : 'Mute game audio'}
        >
          {muted ? '🔇' : '🔊'}
        </button>

        <span className={`status ${connected ? 'status-on' : 'status-off'}`} role="status">
          <span className="status-dot" aria-hidden="true" />
          <span className="status-label">
            {connected
              ? 'Online'
              : everConnected
                ? 'Reconnecting…'
                : connectError ? 'Connecting…' : 'Connecting…'}
          </span>
        </span>
      </div>
    </header>
  );
}
