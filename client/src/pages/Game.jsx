import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENTS, PHASES } from '../events.js';
import PlayerList from '../components/PlayerList.jsx';
import ChatPanel from '../components/ChatPanel.jsx';
import Leaderboard from '../components/Leaderboard.jsx';
import DrawingCanvas from '../components/DrawingCanvas.jsx';
import DrawingToolbar from '../components/DrawingToolbar.jsx';
import WordChoices from '../components/WordChoices.jsx';
import WordHint from '../components/WordHint.jsx';
import Timer from '../components/Timer.jsx';
import GameOver from '../components/GameOver.jsx';
import { sounds } from '../lib/audio.js';

const REASONS = {
  time: '⏰ Time is up!',
  drawer_left: '🚪 The drawer left the game.',
  all_guessed: '🎉 Everyone guessed the secret word!',
};

export default function Game({
  room, myId, connected, request, send, subscribe, onLeave, onPlayAgain, notice, session, chatMessages, clockOffset,
}) {
  const [tool, setTool] = useState('pen');
  const [color, setColor] = useState('#000000');
  const [size, setSize] = useState(5);
  const [completed, setCompleted] = useState(0);
  const [manualTick, setManualTick] = useState(0);
  const [error, setError] = useState('');
  const [choosing, setChoosing] = useState(false);

  // Floating emoji reactions state
  const [floatingReactions, setFloatingReactions] = useState([]);
  const reactionIdCounter = useRef(0);

  const game = room.game;
  const phase = room.phase;
  const isDrawer = game?.drawerId === myId;
  const canDraw = isDrawer && phase === PHASES.DRAWING && connected;
  const guessedIds = game?.guessedIds ?? [];
  const iGuessed = guessedIds.includes(myId);

  // Floating Reaction spawner
  const spawnReaction = useCallback((emoji) => {
    const id = ++reactionIdCounter.current;
    const x = Math.random() * 60 + 20; // 20% to 80% horizontal offset
    setFloatingReactions((prev) => [...prev, { id, emoji, x }]);

    setTimeout(() => {
      setFloatingReactions((prev) => prev.filter((r) => r.id !== id));
    }, 2200);
  }, []);

  const actionLock = useRef(false);
  const run = useCallback(async (event, payload) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setError('');
    try {
      const res = await request(event, payload);
      if (!res.ok && res.error.code !== 'NOTHING_TO_UNDO') setError(res.error.message);
    } finally {
      actionLock.current = false;
    }
  }, [request]);

  async function chooseWord(word) {
    if (choosing) return;
    setChoosing(true);
    setError('');
    sounds.play('click');
    const res = await request(EVENTS.WORD_CHOSEN, { word });
    if (!res.ok) {
      setError(res.error.message);
      sounds.play('wrong');
    }
    setChoosing(false);
  }

  // Keyboard shortcuts for drawer
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (canDraw) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (completed > 0) run(EVENTS.DRAW_UNDO);
        } else if (e.key.toLowerCase() === 'b') {
          setTool('pen');
          sounds.play('click');
        } else if (e.key.toLowerCase() === 'e') {
          setTool('eraser');
          sounds.play('click');
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canDraw, completed, run]);

  const turnId = game?.turnId;
  useEffect(() => {
    setError('');
    setCompleted(0);
  }, [turnId]);

  if (phase === PHASES.GAME_OVER) {
    return <GameOver room={room} myId={myId} onLeave={onLeave} onPlayAgain={onPlayAgain} />;
  }
  if (!game) return null;

  const drawerName = game.drawerName ?? 'Someone';
  const last = game.lastRound;

  let statusBadge;
  if (!connected) {
    statusBadge = <span className="status-pill status-bad">Disconnected</span>;
  } else if (phase === PHASES.WORD_SELECTION) {
    statusBadge = isDrawer ? (
      <span className="status-pill status-good status-pulse">✏️ Your turn! Pick a secret word</span>
    ) : (
      <span className="status-pill">🤔 {drawerName} is choosing a word…</span>
    );
  } else if (phase === PHASES.DRAWING) {
    if (isDrawer) {
      statusBadge = <span className="status-pill status-good">🎨 You are drawing! Make it iconic</span>;
    } else if (iGuessed) {
      statusBadge = <span className="status-pill status-good status-glow">🎉 You guessed it! Keep it secret</span>;
    } else {
      statusBadge = <span className="status-pill">👀 {drawerName} is drawing: guess the word!</span>;
    }
  } else {
    statusBadge = <span className="status-pill status-neutral">⏱ Round Reveal</span>;
  }

  return (
    <div className="game-container">
      {/* Floating Reaction Overlay */}
      <div className="floating-reactions-layer" pointer-events="none" aria-hidden="true">
        {floatingReactions.map((r) => (
          <div
            key={r.id}
            className="floating-emoji"
            style={{ left: `${r.x}%` }}
          >
            {r.emoji}
          </div>
        ))}
      </div>

      {/* Main 3-Column Game Stage */}
      <div className="game-layout">
        {/* Left Column: Players Roster */}
        <aside className="game-side game-left">
          <PlayerList
            players={room.players}
            myId={myId}
            maxPlayers={room.settings.maxPlayers}
            drawerId={game.drawerId}
            guessedIds={guessedIds}
          />

          <div className="game-left-controls card">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setManualTick((n) => n + 1);
                sounds.play('pop');
              }}
              title="Force canvas synchronization"
            >
              🔄 Resync Canvas
            </button>
            <button
              type="button"
              className="btn btn-danger-soft btn-sm"
              onClick={onLeave}
            >
              Leave Room
            </button>
          </div>

          {notice && <p className="notice" role="status">{notice}</p>}
        </aside>

        {/* Center Column: The Drawing Board Stage */}
        <section className="card draw-panel">
          {/* Top HUD Bar */}
          <div className="round-hud-bar">
            <div className="round-badge-group">
              <span className="round-main-badge">
                ROUND {game.round} <span className="round-of-text">of {game.totalRounds}</span>
              </span>
              <span className="turn-sub-badge">Turn {game.turn}/{game.turnsInRound}</span>
            </div>

            <div className="round-hud-status">
              {statusBadge}
            </div>

            <Timer
              key={`${game.turnId}-${phase}`}
              deadline={game.deadline}
              durationMs={game.durationMs}
              clockOffset={clockOffset}
              label={phase === PHASES.DRAWING ? 'Drawing time' : phase === PHASES.WORD_SELECTION ? 'Time to choose' : 'Next turn'}
            />
          </div>

          {/* Word Clue Banner / Choices */}
          <div className="word-clue-stage">
            {phase === PHASES.WORD_SELECTION && isDrawer && session.wordOptions && (
              <WordChoices
                options={session.wordOptions}
                onChoose={chooseWord}
                busy={choosing}
              />
            )}
            {phase === PHASES.WORD_SELECTION && isDrawer && !session.wordOptions && (
              <p className="muted stage-loading-text">Loading word choices…</p>
            )}
            {phase === PHASES.WORD_SELECTION && !isDrawer && (
              <div className="waiting-artist-banner">
                <span className="artist-anim">🎨</span>
                <p><strong>{drawerName}</strong> is picking a word. Warm up your typing fingers!</p>
              </div>
            )}

            {phase === PHASES.DRAWING && isDrawer && (
              <div className="drawer-secret-word-card">
                <span className="secret-word-label">YOUR SECRET WORD:</span>
                <strong className="secret-word-text">{session.word ?? '…'}</strong>
              </div>
            )}

            {phase === PHASES.DRAWING && !isDrawer && (
              <div className="guesser-hint-box">
                <WordHint pattern={game.pattern} />
                <div className="guesser-stats-row">
                  {game.hintsTotal > 0 && (
                    <span className="hint-meta-pill">Hints: {game.hintsShown}/{game.hintsTotal}</span>
                  )}
                  <span className="hint-meta-pill solved-meta-pill">
                    Guessed: {guessedIds.length}/{game.guessersTotal}
                  </span>
                </div>
              </div>
            )}

            {phase === PHASES.ROUND_END && last && (
              <div className="reveal-stage animate-pop" role="status">
                <p className="reveal-reason-tag">{REASONS[last.reason] ?? 'Round completed.'}</p>
                {last.word ? (
                  <p className="reveal-word-callout">
                    The secret word was <strong className="highlight-word">{last.word}</strong>
                  </p>
                ) : (
                  <p className="reveal-word-callout muted">No word chosen this round.</p>
                )}
                <div className="turn-deltas-container">
                  <span className="deltas-title">Points Earned:</span>
                  <ul className="turn-scores-list">
                    {[...last.scores]
                      .filter((e) => e.delta > 0)
                      .sort((a, b) => b.delta - a.delta)
                      .map((e) => (
                        <li key={e.id} className="turn-score-item">
                          <span>{e.username}{e.id === last.drawerId ? ' 🎨' : ''}</span>
                          <strong className="delta-pts">+{e.delta}</strong>
                        </li>
                      ))}
                    {last.scores.every((e) => e.delta === 0) && (
                      <li className="muted no-score-item">Nobody scored points this turn.</li>
                    )}
                  </ul>
                </div>
                <p className="muted small next-turn-countdown">Next turn starting shortly…</p>
              </div>
            )}
          </div>

          {/* Canvas Wrapper */}
          <div className="canvas-stage-wrapper">
            <DrawingCanvas
              canDraw={canDraw}
              connected={connected}
              tool={tool}
              color={color}
              size={size}
              send={send}
              request={request}
              subscribe={subscribe}
              syncTick={`${manualTick}-${game.turnId}`}
              onStrokeCountChange={setCompleted}
              onError={setError}
            />
          </div>

          {/* Artist Toolbar */}
          <DrawingToolbar
            tool={tool} setTool={setTool}
            color={color} setColor={setColor}
            size={size} setSize={setSize}
            disabled={!canDraw}
            canUndo={completed > 0}
            onUndo={() => run(EVENTS.DRAW_UNDO)}
            onClear={() => run(EVENTS.CANVAS_CLEAR)}
          />

          {!canDraw && (
            <p className="canvas-locked-hint">
              {isDrawer
                ? 'Drawing unlocks once your secret word is chosen.'
                : `Drawing tools are reserved for ${drawerName}. Type your guesses in the chat!`}
            </p>
          )}

          {error && <p className="error error-box" role="alert">⚠️ {error}</p>}
        </section>

        {/* Right Column: Leaderboard & Chat */}
        <aside className="game-side game-right">
          <Leaderboard
            leaderboard={game.leaderboard ?? []}
            myId={myId}
            drawerId={game.drawerId}
          />
          <ChatPanel
            messages={chatMessages}
            room={room}
            myId={myId}
            connected={connected}
            request={request}
            onReaction={spawnReaction}
          />
        </aside>
      </div>
    </div>
  );
}
