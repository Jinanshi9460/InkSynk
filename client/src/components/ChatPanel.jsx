import { useEffect, useRef, useState } from 'react';
import { EVENTS, PHASES, MAX_MESSAGE_LENGTH } from '../events.js';
import { sounds } from '../lib/audio.js';
import { triggerConfetti } from '../lib/confetti.js';

const QUICK_REACTIONS = ['🔥', '👏', '😂', '💡', '🤯', '❤️'];

export default function ChatPanel({ messages, room, myId, connected, request, onReaction }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  const game = room.game;
  const phase = room.phase;
  const isDrawer = game?.drawerId === myId;
  const hasGuessed = Boolean(game?.guessedIds?.includes(myId));

  let mode = 'chat';
  let placeholder = 'Say something…';
  let hint = '';
  let locked = false;

  if (phase === PHASES.DRAWING) {
    if (isDrawer) {
      placeholder = 'Chat with guessers who got it…';
      hint = '🔒 Secret chat: Only guessers who already scored can see this.';
    } else if (hasGuessed) {
      placeholder = 'Chat with the drawer…';
      hint = '🎉 You guessed it! Chatting is safe with other solvers.';
    } else {
      mode = 'guess';
      placeholder = 'Type your guess here…';
      hint = '⚡ Type fast! Wrong guesses appear in chat.';
    }
  } else if (phase === PHASES.WORD_SELECTION && isDrawer) {
    locked = true;
    placeholder = 'Pick a word to begin drawing…';
  }

  // Scroll to bottom on new messages
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Play chime and trigger confetti when self guesses correctly
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.kind === 'correct') {
      sounds.play('correct');
      if (lastMsg.playerId === myId) {
        triggerConfetti(0.7, 0.4, 50);
      }
    }
  }, [messages, myId]);

  const turnId = game?.turnId;
  useEffect(() => {
    setError('');
  }, [phase, turnId]);

  async function submit(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy || locked || !connected) return;
    setBusy(true);
    setError('');

    const isGuess = mode === 'guess';
    sounds.play('click');
    const res = await request(isGuess ? EVENTS.GUESS : EVENTS.CHAT, { text: value });
    setBusy(false);

    if (res.ok) {
      setText('');
      if (isGuess && res.correct) {
        sounds.play('correct');
        triggerConfetti(0.75, 0.45, 60);
      }
    } else {
      setError(res.error.message);
      sounds.play('wrong');
    }
    inputRef.current?.focus();
  }

  function handleQuickReaction(emoji) {
    sounds.play('pop');
    onReaction?.(emoji);
    // If not guessing or locked, can also send in chat
    if (!locked && connected && mode === 'chat') {
      request(EVENTS.CHAT, { text: emoji }).catch(() => {});
    }
  }

  return (
    <section className="card chat-panel">
      <div className="chat-header-row">
        <h2 className="card-title">
          {mode === 'guess' ? '🎯 Guess & Chat' : '💬 Chat Arena'}
        </h2>
        {mode === 'guess' && <span className="mode-pill mode-pill-guess">GUESS MODE</span>}
        {hasGuessed && <span className="mode-pill mode-pill-solved">SOLVED ✅</span>}
      </div>

      {/* Quick Reaction Bar */}
      <div className="reaction-bar" aria-label="Quick Reactions">
        <span className="reaction-label">Reactions:</span>
        <div className="reaction-buttons">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="reaction-btn"
              onClick={() => handleQuickReaction(emoji)}
              title={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>

      <ul className="chat-list" ref={listRef} role="log" aria-live="polite" aria-label="Chat messages" tabIndex={0}>
        {messages.length === 0 && (
          <li className="chat-empty">
            <span className="empty-chat-icon">💭</span>
            <span>No messages yet. Be the first to guess or say hi!</span>
          </li>
        )}
        {messages.map((m) => (
          <li
            key={m.id}
            className={`chat-msg chat-${m.kind} ${m.playerId === myId ? 'chat-mine' : ''} ${m.scope === 'guessed' ? 'chat-secret' : ''}`}
          >
            {m.kind === 'system' ? (
              <div className="chat-bubble chat-bubble-system">
                <span className="system-icon">ℹ️</span>
                <span>{m.text}</span>
              </div>
            ) : m.kind === 'correct' ? (
              <div className="chat-bubble chat-bubble-correct">
                <span className="correct-icon">🎉</span>
                <span>{m.text}</span>
              </div>
            ) : (
              <div className="chat-bubble">
                <span className="chat-author">{m.playerName ?? 'Someone'}</span>
                {m.kind === 'guess' && <span className="chat-tag-guess">GUESS</span>}
                {m.scope === 'guessed' && <span className="chat-tag-secret" title="Private whisper to solvers">🔒 SOLVERS</span>}
                <span className="chat-text">: {m.text}</span>
              </div>
            )}
          </li>
        ))}
      </ul>

      {hint && <p className="chat-hint">{hint}</p>}

      <form className="chat-form" onSubmit={submit}>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={locked || !connected}
          autoComplete="off"
          aria-label={mode === 'guess' ? 'Your guess' : 'Chat message'}
          className={mode === 'guess' ? 'input-guess-active' : ''}
        />
        <button
          className={`btn ${mode === 'guess' ? 'btn-primary btn-glow' : 'btn-secondary'}`}
          type="submit"
          disabled={busy || locked || !connected || !text.trim()}
        >
          {mode === 'guess' ? '⚡ Guess' : 'Send'}
        </button>
      </form>

      {!connected && <p className="error" role="alert">Disconnected from server.</p>}
      {error && <p className="error chat-error" role="alert">⚠️ {error}</p>}
    </section>
  );
}
