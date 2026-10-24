import { useEffect, useState } from 'react';
import { sounds } from '../lib/audio.js';
import { triggerConfetti } from '../lib/confetti.js';

export default function GameOver({ room, myId, onLeave, onPlayAgain }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isHost = room.hostId === myId;
  const results = room.game?.results;
  const leaderboard = results?.leaderboard ?? [];
  const winners = results?.winners ?? [];
  const iWon = winners.some((w) => w.id === myId);

  useEffect(() => {
    sounds.play('win');
    triggerConfetti(0.5, 0.4, 120);
    const timer = setTimeout(() => {
      triggerConfetti(0.3, 0.5, 60);
      triggerConfetti(0.7, 0.5, 60);
    }, 700);
    return () => clearTimeout(timer);
  }, []);

  // Pick top players strictly by ordered standing so the podium is never blank!
  const firstPlace = leaderboard[0];
  const secondPlace = leaderboard[1];
  const thirdPlace = leaderboard[2];

  const isTie = leaderboard.length >= 2 && leaderboard[0]?.score === leaderboard[1]?.score;

  return (
    <section className="card game-over-card animate-pop">
      <div className="game-over-header">
        <span className="celebration-pill">🎉 MATCH COMPLETED</span>
        <h1 className="game-over-title">Game Over!</h1>
        {results?.winner ? (
          <p className="winner-banner">
            🏆 <strong className="winner-name">{results.winner.username}</strong> takes 1st place with {results.winner.score} pts!
            {iWon && <span className="you-won-tag"> You are the Champion!</span>}
          </p>
        ) : (
          <p className="winner-banner">
            🤝 Incredible tie between <strong>{winners.map((w) => w.username).join(' and ')}</strong> with {winners[0]?.score ?? 0} pts!
          </p>
        )}
      </div>

      {/* 3D Visual Podium for Top Players */}
      <div className={`podium-container ${leaderboard.length === 2 ? 'podium-two' : ''}`}>
        {/* 2nd Place (Left) */}
        {secondPlace && (
          <div className={`podium-slot podium-second ${secondPlace.id === myId ? 'is-me' : ''}`}>
            <div className="podium-avatar">{isTie ? '🥇' : '🥈'}</div>
            <span className="podium-name">{secondPlace.username}</span>
            <span className="podium-score">
              {secondPlace.score} pts
              {isTie && <span className="podium-tie-pill">TIE</span>}
            </span>
            <div className={`podium-step step-2 ${isTie ? 'step-tie' : ''}`}>
              <span>{isTie ? '1' : '2'}</span>
            </div>
          </div>
        )}

        {/* 1st Place (Center) */}
        {firstPlace && (
          <div className={`podium-slot podium-first ${firstPlace.id === myId ? 'is-me' : ''}`}>
            <div className="podium-crown">👑</div>
            <div className="podium-avatar avatar-winner">🥇</div>
            <span className="podium-name font-bold">{firstPlace.username}</span>
            <span className="podium-score winner-score">{firstPlace.score} pts</span>
            <div className="podium-step step-1">
              <span>1</span>
            </div>
          </div>
        )}

        {/* 3rd Place (Right - shown if at least 3 players) */}
        {thirdPlace && (
          <div className={`podium-slot podium-third ${thirdPlace.id === myId ? 'is-me' : ''}`}>
            <div className="podium-avatar">🥉</div>
            <span className="podium-name">{thirdPlace.username}</span>
            <span className="podium-score">{thirdPlace.score} pts</span>
            <div className="podium-step step-3">
              <span>3</span>
            </div>
          </div>
        )}
      </div>

      {/* Full Final Roster */}
      <div className="final-leaderboard-box">
        <h3 className="final-scores-title">Full Match Standings</h3>
        <ol className="final-scores-list">
          {leaderboard.map((e, index) => {
            const displayRank = index + 1;
            const isTiedWithPrev = index > 0 && e.score === leaderboard[index - 1].score;
            return (
              <li key={e.id} className={`final-score-row ${e.id === myId ? 'is-me' : ''}`}>
                <span className="final-rank">#{displayRank}</span>
                <span className="final-name">
                  {e.username}
                  {e.id === myId && <span className="you-pill-sm">YOU</span>}
                  {isTiedWithPrev && <span className="tie-badge">🤝 TIE</span>}
                </span>
                <span className="final-pts">{e.score} pts</span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="game-over-actions">
        {isHost ? (
          <button
            type="button"
            className="btn btn-primary btn-glow btn-hero-start"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              sounds.play('click');
              const res = await onPlayAgain();
              setBusy(false);
              if (!res.ok) {
                setError(res.error.message);
                sounds.play('wrong');
              }
            }}
          >
            {busy ? 'Returning to Lobby…' : '🔄 Play Again'}
          </button>
        ) : (
          <p className="waiting-host-note">Waiting for the host to launch another game…</p>
        )}
        <button type="button" className="btn btn-danger-soft" onClick={onLeave}>
          Leave Room
        </button>
      </div>

      {error && <p className="error error-box" role="alert">⚠️ {error}</p>}
    </section>
  );
}
