import { useEffect, useRef, useState } from 'react';
import { EVENTS, LIMITS, SETTING_FIELDS, draftToSettings } from '../events.js';
import PlayerList from '../components/PlayerList.jsx';
import SettingsForm from '../components/SettingsForm.jsx';
import SettingsSummary from '../components/SettingsSummary.jsx';
import { triggerConfetti } from '../lib/confetti.js';
import { sounds } from '../lib/audio.js';

export default function Lobby({ room, myId, request, onLeave, notice }) {
  const isHost = room.hostId === myId;
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const copyTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const [draft, setDraft] = useState(room.settings);
  const settingsKey = JSON.stringify(room.settings);
  useEffect(() => setDraft(room.settings), [settingsKey]);

  const inviteLink = `${window.location.origin}${window.location.pathname}?room=${room.code}`;

  async function copy(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      sounds.play('pop');
      triggerConfetti(0.5, 0.3, 30);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(''), 2000);
    } catch {
      setError('Could not copy automatically. Please copy it manually.');
      sounds.play('wrong');
    }
  }

  async function shareRoom() {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join my InkSynk Game!',
          text: `Join my room "${room.code}" in InkSynk! Let's draw and guess together!`,
          url: inviteLink,
        });
        sounds.play('pop');
        return;
      } catch {
        // Fallback to copy link
      }
    }
    copy(inviteLink, 'link');
  }

  async function saveSettings() {
    if (saving) return;
    setError('');
    for (const { key, label } of SETTING_FIELDS) {
      const value = Number(draft[key]);
      const { min, max } = LIMITS[key];
      if (draft[key] === '' || !Number.isInteger(value) || value < min || value > max) {
        setError(`${label} must be a whole number from ${min} to ${max}.`);
        sounds.play('wrong');
        return;
      }
    }
    setSaving(true);
    const res = await request(EVENTS.UPDATE_SETTINGS, { settings: draftToSettings(draft) });
    setSaving(false);
    if (!res.ok) {
      setError(res.error.message);
      setDraft(room.settings);
      sounds.play('wrong');
    } else {
      sounds.play('pop');
    }
  }

  async function startGame() {
    if (starting) return;
    setStarting(true);
    setError('');
    sounds.play('click');
    const res = await request(EVENTS.START_GAME);
    setStarting(false);
    if (!res.ok) {
      setError(res.error.message);
      sounds.play('wrong');
    }
  }

  const dirty =
    Boolean(draft.isPublic) !== room.settings.isPublic ||
    SETTING_FIELDS.some(({ key }) => Number(draft[key]) !== room.settings[key]);
  const canStart = isHost && room.players.length >= 2;

  return (
    <div className="lobby-container">
      {/* Lobby Hero Invite Card */}
      <section className="card lobby-hero-card">
        <div className="lobby-hero-left">
          <div className="lobby-tag">
            <span className="live-indicator-pulse" />
            <span>GAME LOBBY · {room.settings.isPublic ? 'Public' : 'Private'}</span>
          </div>
          <h1 className="lobby-heading">Room Code</h1>
          <div className="room-code-badge" onClick={() => copy(room.code, 'code')} title="Click to copy room code">
            <span className="room-code-text">{room.code}</span>
            <span className="copy-icon-pill">{copied === 'code' ? '✓ COPIED!' : '📋 COPY'}</span>
          </div>
          <p className="muted small">Share this code with friends so they can jump right in!</p>
        </div>

        <div className="lobby-hero-actions">
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            onClick={() => copy(inviteLink, 'link')}
          >
            {copied === 'link' ? '✨ Link Copied!' : '🔗 Copy Invite Link'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            onClick={shareRoom}
          >
            📤 Share Room
          </button>
        </div>
      </section>

      {/* Main Lobby Grid */}
      <div className="lobby-grid">
        {/* Players Showcase */}
        <div className="lobby-players-col">
          <PlayerList
            players={room.players}
            myId={myId}
            maxPlayers={room.settings.maxPlayers}
          />
        </div>

        {/* Game Rules & Host Config */}
        <div className="lobby-settings-col">
          <section className="card settings-card">
            <div className="card-header-row">
              <h2 className="card-title">🎮 Game Rules</h2>
              {isHost && <span className="host-badge">👑 You are the Host</span>}
            </div>

            <SettingsSummary settings={room.settings} />

            {isHost ? (
              <details className="settings-details">
                <summary>✏️ Modify Room Settings</summary>
                <div className="settings-drawer-inner">
                  <SettingsForm draft={draft} setDraft={setDraft} />
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={saveSettings}
                    disabled={!dirty || saving}
                  >
                    {saving ? 'Saving…' : 'Save Settings'}
                  </button>
                </div>
              </details>
            ) : (
              <p className="muted small host-note">💡 Only the host can adjust game rules.</p>
            )}
          </section>

          {/* Start Game Action Panel */}
          <section className="card start-game-card">
            {isHost ? (
              <div className="start-prompt">
                {canStart ? (
                  <p className="ready-text">✨ All set! Ready to kick off the drawing battle.</p>
                ) : (
                  <p className="waiting-text">⏳ Waiting for at least 2 players to join…</p>
                )}
                <button
                  type="button"
                  className="btn btn-primary btn-glow btn-hero-start"
                  onClick={startGame}
                  disabled={!canStart || starting}
                >
                  {starting ? 'Launching Game…' : canStart ? '🚀 Start InkSynk Game' : 'Waiting for Players…'}
                </button>
              </div>
            ) : (
              <div className="waiting-guest-banner">
                <span className="hourglass-anim">⏳</span>
                <p>Waiting for the host to launch the game. Get your stylus ready!</p>
              </div>
            )}

            <button type="button" className="btn btn-danger-soft leave-btn" onClick={onLeave}>
              Leave Room
            </button>
          </section>
        </div>
      </div>

      {error && <p className="error error-box" role="alert">⚠️ {error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
    </div>
  );
}
