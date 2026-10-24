import { useState, useEffect, useRef } from 'react';
import { DEFAULT_SETTINGS, EVENTS, LIMITS, SETTING_FIELDS, USERNAME_MAX_LENGTH, draftToSettings } from '../events.js';
import SettingsForm from '../components/SettingsForm.jsx';
import { sounds } from '../lib/audio.js';

const ROOM_CODE_PATTERN = /^[A-Z0-9]{3,8}$/;
const cleanName = (value) => value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();

const EMOJI_AVATARS = ['🐱', '🦊', '🐼', '🦁', '🚀', '👾', '🎨', '⚡', '🥑', '🦄', '🧙‍♂️', '😎'];

const PRESETS = [
  { name: '⚡ Blitz', rounds: 2, drawTime: 40, wordChoices: 3, hints: 2, maxPlayers: 8, isPublic: false },
  { name: '🎯 Classic', rounds: 3, drawTime: 60, wordChoices: 3, hints: 2, maxPlayers: 8, isPublic: false },
  { name: '🎨 Masterpiece', rounds: 4, drawTime: 90, wordChoices: 4, hints: 3, maxPlayers: 12, isPublic: false },
];

function settingsProblem(draft) {
  for (const { key, label } of SETTING_FIELDS) {
    const value = Number(draft[key]);
    const { min, max } = LIMITS[key];
    if (draft[key] === '' || !Number.isInteger(value) || value < min || value > max) {
      return `${label} must be a whole number from ${min} to ${max}.`;
    }
  }
  return '';
}

export default function Home({ connected, connectError, everConnected, request, onEntered, initialCode, notice }) {
  const [selectedEmoji, setSelectedEmoji] = useState(() => {
    return localStorage.getItem('inksynk_avatar') || EMOJI_AVATARS[Math.floor(Math.random() * EMOJI_AVATARS.length)];
  });

  const [rawName, setRawName] = useState(() => {
    return localStorage.getItem('inksynk_username') || '';
  });

  const [activeTab, setActiveTab] = useState(initialCode ? 'join' : 'create');
  const [code, setCode] = useState(initialCode || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(DEFAULT_SETTINGS);
  const [activePreset, setActivePreset] = useState('🎯 Classic');

  // Interactive Mini Doodle Warm-up Pad
  const miniCanvasRef = useRef(null);
  const [doodleColor, setDoodleColor] = useState('#6366f1');
  const isDoodling = useRef(false);

  useEffect(() => {
    const canvas = miniCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
  }, []);

  function handleDoodleStart(e) {
    const canvas = miniCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX || e.touches?.[0]?.clientX) - rect.left;
    const y = (e.clientY || e.touches?.[0]?.clientY) - rect.top;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.strokeStyle = doodleColor;
    isDoodling.current = true;
    sounds.play('click');
  }

  function handleDoodleMove(e) {
    if (!isDoodling.current) return;
    const canvas = miniCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX || e.touches?.[0]?.clientX) - rect.left;
    const y = (e.clientY || e.touches?.[0]?.clientY) - rect.top;
    const ctx = canvas.getContext('2d');
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function handleDoodleEnd() {
    isDoodling.current = false;
  }

  function clearDoodle() {
    const canvas = miniCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    sounds.play('pop');
  }

  function handleSelectEmoji(emoji) {
    setSelectedEmoji(emoji);
    localStorage.setItem('inksynk_avatar', emoji);
    sounds.play('pop');
  }

  function applyPreset(preset) {
    setActivePreset(preset.name);
    setDraft({
      rounds: preset.rounds,
      drawTime: preset.drawTime,
      wordChoices: preset.wordChoices,
      hints: preset.hints,
      maxPlayers: preset.maxPlayers,
      isPublic: preset.isPublic,
    });
    sounds.play('click');
  }

  function getFullUsername() {
    const name = cleanName(rawName);
    if (!name) return '';
    // If the user didn't already include an emoji, prepend the selected one nicely
    const hasEmoji = /\p{Extended_Pictographic}/u.test(name);
    if (hasEmoji) return name;
    const combined = `${selectedEmoji} ${name}`;
    return combined.length <= USERNAME_MAX_LENGTH ? combined : name;
  }

  async function submit(event, payload) {
    if (busy) return;
    setError('');
    const name = getFullUsername();
    if (!name) {
      setError('Please enter a username to play!');
      sounds.play('wrong');
      return;
    }
    if (name.length > USERNAME_MAX_LENGTH) {
      setError(`Username must be ${USERNAME_MAX_LENGTH} characters or less.`);
      sounds.play('wrong');
      return;
    }

    localStorage.setItem('inksynk_username', cleanName(rawName));
    setBusy(true);
    sounds.play('click');
    const res = await request(event, { ...payload, username: name });
    setBusy(false);

    if (!res.ok) {
      setError(res.error.message);
      sounds.play('wrong');
      return;
    }

    sounds.play('turn_start');
    onEntered(res.playerId, res.room);
  }

  function createRoom() {
    const problem = settingsProblem(draft);
    if (problem) {
      setError(problem);
      sounds.play('wrong');
      return;
    }
    submit(EVENTS.CREATE_ROOM, { settings: draftToSettings(draft) });
  }

  function joinRoom(e) {
    if (e) e.preventDefault();
    const roomCode = code.trim().toUpperCase();
    if (!ROOM_CODE_PATTERN.test(roomCode)) {
      setError('Enter a valid 3-8 character room code.');
      sounds.play('wrong');
      return;
    }
    submit(EVENTS.JOIN_ROOM, { roomCode });
  }

  function onNameKeyDown(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (activeTab === 'join' || initialCode) joinRoom();
    else if (connected) createRoom();
  }

  const connectionNote = !connected
    ? connectError && !everConnected
      ? 'Connecting to InkSynk game servers…'
      : 'Connecting to server…'
    : '';

  return (
    <div className="home-layout">
      {/* Hero Welcome Banner */}
      <section className="hero-banner">
        <div className="hero-badge">⚡ Real-time Multiplayer Guessing Game</div>
        <h1 className="hero-title">
          Draw fast. Guess faster. <br />
          <span className="gradient-text">Stay in Synk.</span>
        </h1>
        <p className="hero-subtitle">
          Jump into high-energy multiplayer drawing rooms with friends. Sketch clues in real-time,
          uncover letter hints, and battle for the #1 podium spot!
        </p>

        {/* Feature Highlights Grid to fill empty space and delight users */}
        <div className="features-grid">
          <div className="feature-card">
            <span className="feature-icon">🎨</span>
            <div>
              <strong>Sub-30ms Synk</strong>
              <p>Ultra smooth live brush strokes streamed instantly across devices.</p>
            </div>
          </div>
          <div className="feature-card">
            <span className="feature-icon">💡</span>
            <div>
              <strong>Adaptive Hints</strong>
              <p>Letters reveal progressively as the countdown timer ticks away.</p>
            </div>
          </div>
          <div className="feature-card">
            <span className="feature-icon">🏆</span>
            <div>
              <strong>Live Leaderboard</strong>
              <p>Earn streak bonuses, speed multipliers, and drawer rewards.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Main Action Hub */}
      <div className="home-hub-container">
        <div className="card home-card" aria-busy={busy}>
          {/* Avatar & Username Picker */}
          <div className="profile-section">
            <label className="field-label" htmlFor="username">
              <span>Choose your Avatar &amp; Name</span>
            </label>

            <div className="avatar-picker-row">
              <div className="avatar-preview-badge">
                <span className="preview-emoji">{selectedEmoji}</span>
              </div>

              <div className="avatar-carousel">
                {EMOJI_AVATARS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className={`avatar-option-btn ${selectedEmoji === emoji ? 'is-selected' : ''}`}
                    onClick={() => handleSelectEmoji(emoji)}
                    aria-label={`Select avatar ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>

            <div className="input-with-icon">
              <span className="input-icon-left">{selectedEmoji}</span>
              <input
                id="username"
                value={rawName}
                onChange={(e) => setRawName(e.target.value)}
                onKeyDown={onNameKeyDown}
                maxLength={USERNAME_MAX_LENGTH - 3}
                placeholder="Enter your artist tag (e.g. Picasso)"
                autoComplete="nickname"
                autoFocus
                disabled={busy}
                className="name-input"
              />
            </div>
          </div>

          {/* Mode Switcher Tabs */}
          {!initialCode && (
            <div className="tab-pill-container" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'create'}
                className={`tab-pill ${activeTab === 'create' ? 'is-active' : ''}`}
                onClick={() => { setActiveTab('create'); sounds.play('click'); }}
              >
                ✨ Create Room
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'join'}
                className={`tab-pill ${activeTab === 'join' ? 'is-active' : ''}`}
                onClick={() => { setActiveTab('join'); sounds.play('click'); }}
              >
                🔑 Join Room
              </button>
            </div>
          )}

          {/* Create Room Mode */}
          {activeTab === 'create' && !initialCode && (
            <div className="tab-content animate-fade">
              <div className="presets-row">
                <span className="presets-label">Quick Presets:</span>
                <div className="preset-chips">
                  {PRESETS.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      className={`preset-chip ${activePreset === p.name ? 'is-active' : ''}`}
                      onClick={() => applyPreset(p)}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              <details className="settings-details">
                <summary>⚙️ Custom Settings ({draft.rounds} rounds, {draft.drawTime}s)</summary>
                <div className="settings-drawer-inner">
                  <SettingsForm draft={draft} setDraft={(newDraft) => {
                    setActivePreset('Custom');
                    setDraft(newDraft);
                  }} disabled={busy} />
                </div>
              </details>

              <button
                type="button"
                className="btn btn-primary btn-glow btn-large"
                onClick={createRoom}
                disabled={!connected || busy}
              >
                {busy ? 'Creating Room…' : '🚀 Launch Room'}
              </button>
            </div>
          )}

          {/* Join Room Mode */}
          {(activeTab === 'join' || initialCode) && (
            <div className="tab-content animate-fade">
              {initialCode && (
                <div className="invite-alert">
                  <span>📨 You received an invite to join room <strong>{initialCode}</strong>!</span>
                </div>
              )}

              <form className="join-form" onSubmit={joinRoom}>
                <label className="field-label" htmlFor="roomCode">Room Code</label>
                <div className="join-row">
                  <input
                    id="roomCode"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    maxLength={8}
                    placeholder="ENTER CODE"
                    aria-label="Room code"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    className="code-input"
                    disabled={busy}
                  />
                  <button
                    className="btn btn-primary btn-large"
                    type="submit"
                    disabled={!connected || busy || !code.trim()}
                  >
                    {busy ? 'Joining…' : 'Enter'}
                  </button>
                </div>
              </form>

              {initialCode && (
                <button
                  type="button"
                  className="btn btn-link create-instead-btn"
                  onClick={() => {
                    window.history.replaceState({}, '', window.location.pathname);
                    window.location.reload();
                  }}
                >
                  Create my own room instead
                </button>
              )}
            </div>
          )}

          {error && <p id="home-error" className="error error-box" role="alert">⚠️ {error}</p>}
          {busy && <p className="muted small" role="status">Connecting to InkSynk…</p>}
          {connectionNote && <p className="connection-note small" role="status">⏳ {connectionNote}</p>}
          {notice && <p className="notice" role="status">{notice}</p>}
        </div>

        {/* Interactive Warm-up Doodle Pad */}
        <div className="card warmup-card">
          <div className="warmup-header">
            <div>
              <h2 className="card-title">🎨 Warm-Up Pad</h2>
              <p className="muted small">Test your brush while waiting to play!</p>
            </div>
            <button type="button" className="btn btn-sm" onClick={clearDoodle} title="Clear canvas">
              🧹 Clear
            </button>
          </div>

          <div className="warmup-canvas-wrapper">
            <canvas
              ref={miniCanvasRef}
              width={340}
              height={180}
              className="warmup-canvas"
              onMouseDown={handleDoodleStart}
              onMouseMove={handleDoodleMove}
              onMouseUp={handleDoodleEnd}
              onMouseLeave={handleDoodleEnd}
              onTouchStart={handleDoodleStart}
              onTouchMove={handleDoodleMove}
              onTouchEnd={handleDoodleEnd}
            />
          </div>

          <div className="warmup-swatches">
            {['#6366f1', '#ec4899', '#06b6d4', '#10b981', '#f59e0b', '#1f2937'].map((c) => (
              <button
                key={c}
                type="button"
                className={`warmup-swatch ${doodleColor === c ? 'is-active' : ''}`}
                style={{ backgroundColor: c }}
                onClick={() => { setDoodleColor(c); sounds.play('click'); }}
                aria-label={`Warmup color ${c}`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
