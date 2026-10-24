function getAvatarStyle(name = '') {
  const gradients = [
    'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
    'linear-gradient(135deg, #ec4899 0%, #f43f5e 100%)',
    'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
    'linear-gradient(135deg, #10b981 0%, #14b8a6 100%)',
    'linear-gradient(135deg, #f59e0b 0%, #ea580c 100%)',
    'linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return gradients[Math.abs(hash) % gradients.length];
}

function parseAvatar(name = '') {
  // Extract leading emoji if present
  const match = name.match(/^\p{Extended_Pictographic}/u);
  if (match) {
    return {
      symbol: match[0],
      cleanName: name.replace(/^\p{Extended_Pictographic}\s*/u, ''),
      isEmoji: true,
    };
  }
  return {
    symbol: name.charAt(0).toUpperCase() || '?',
    cleanName: name,
    isEmoji: false,
  };
}

export default function PlayerList({ players = [], myId, maxPlayers, drawerId, guessedIds = [] }) {
  // Calculate empty slots to show encouraging placeholders in the lobby/game
  const totalSlots = maxPlayers ? Math.min(maxPlayers, 8) : 8;
  const emptySlotsCount = Math.max(0, Math.min(4, totalSlots - players.length));

  return (
    <section className="card player-list-card">
      <div className="card-header-row">
        <h2 className="card-title">
          👥 Players <span className="player-count-badge">{players.length}{maxPlayers ? `/${maxPlayers}` : ''}</span>
        </h2>
      </div>

      <ul className="player-list">
        {players.map((p, index) => {
          const isDrawer = p.id === drawerId;
          const isGuessed = guessedIds.includes(p.id);
          const isMe = p.id === myId;
          const { symbol, cleanName, isEmoji } = parseAvatar(p.username);

          return (
            <li
              key={p.id}
              className={`player-item ${isDrawer ? 'player-drawer-active' : ''} ${isMe ? 'player-is-me' : ''} ${isGuessed ? 'player-has-guessed' : ''}`}
            >
              <div
                className="player-avatar"
                style={{ background: getAvatarStyle(p.username) }}
                aria-hidden="true"
              >
                <span className={isEmoji ? 'avatar-emoji' : 'avatar-letter'}>{symbol}</span>
                {p.isHost && <span className="host-crown-badge" title="Room Host">👑</span>}
              </div>

              <div className="player-info">
                <div className="player-name-row">
                  <span className="player-name" title={p.username}>
                    {cleanName || p.username}
                  </span>
                  {isMe && <span className="you-pill">YOU</span>}
                </div>

                <div className="player-status-row">
                  {isDrawer && (
                    <span className="status-badge status-drawing">
                      ✏️ Drawing
                    </span>
                  )}
                  {isGuessed && (
                    <span className="status-badge status-guessed">
                      ✅ Guessed
                    </span>
                  )}
                  {!isDrawer && !isGuessed && drawerId && (
                    <span className="status-badge status-thinking">
                      🤔 Thinking…
                    </span>
                  )}
                  {!drawerId && p.isHost && (
                    <span className="status-badge status-host">
                      Host
                    </span>
                  )}
                </div>
              </div>

              <div className="player-score-box">
                <span className="score-number">{p.score}</span>
                <span className="score-pts">PTS</span>
              </div>
            </li>
          );
        })}

        {/* Empty slots to fill void space and guide user */}
        {emptySlotsCount > 0 &&
          Array.from({ length: emptySlotsCount }).map((_, idx) => (
            <li key={`empty-${idx}`} className="player-item player-item-empty">
              <div className="player-avatar avatar-empty">
                <span>+</span>
              </div>
              <div className="player-info">
                <span className="empty-slot-text">Open Player Slot</span>
                <span className="empty-slot-sub">Invite a friend with code</span>
              </div>
            </li>
          ))}
      </ul>
    </section>
  );
}
