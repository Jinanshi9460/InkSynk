function getRankIcon(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

export default function Leaderboard({ leaderboard = [], myId, drawerId }) {
  return (
    <section className="card leaderboard-card">
      <div className="card-header-row">
        <h2 className="card-title">🏆 Leaderboard</h2>
      </div>

      <ol className="leaderboard-list">
        {leaderboard.map((e, index) => {
          const displayRank = index + 1;
          const isTop = displayRank === 1 && e.score > 0;
          const isMe = e.id === myId;
          const isDrawer = e.id === drawerId;
          const isTiedWithPrev = index > 0 && e.score === leaderboard[index - 1].score;

          return (
            <li
              key={e.id}
              className={`leader-row ${isTop ? 'leader-row-first' : ''} ${isMe ? 'leader-row-me' : ''}`}
            >
              <div className="leader-rank-badge">
                {getRankIcon(displayRank)}
              </div>

              <div className="leader-info">
                <div className="leader-name-wrap">
                  <span className="leader-username" title={e.username}>
                    {e.username}
                  </span>
                  {isTiedWithPrev && <span className="tie-badge-sm">TIE</span>}
                </div>
                <div className="leader-meta-tags">
                  {isMe && <span className="you-pill-sm">YOU</span>}
                  {isDrawer && <span className="badge-tag tag-draw">✏️ DRAWING</span>}
                  {e.guessed && <span className="badge-tag tag-done">✅ GUESSED</span>}
                </div>
              </div>

              <div className="leader-score-wrap">
                {e.delta > 0 && (
                  <span className="score-delta-chip" title="Points gained this round">
                    +{e.delta}
                  </span>
                )}
                <span className="leader-total-pts">{e.score}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
