export default function WordHint({ pattern }) {
  if (!pattern) return null;
  const letters = pattern.filter((c) => c !== ' ' && c !== '-').length;

  return (
    <div
      className="word-hint-container"
      aria-label={`Word with ${letters} letters: ${pattern.join(' ').replace(/_/g, 'blank')}`}
    >
      <div className="word-hint-tiles">
        {pattern.map((ch, i) => {
          if (ch === ' ') {
            return <span key={i} className="hint-tile-space" aria-hidden="true" />;
          }
          if (ch === '-') {
            return <span key={i} className="hint-tile-dash" aria-hidden="true">-</span>;
          }
          const isRevealed = ch !== '_';
          return (
            <div
              key={i}
              className={`hint-tile ${isRevealed ? 'hint-tile-revealed' : 'hint-tile-blank'}`}
              aria-hidden="true"
            >
              <span className="hint-char">{isRevealed ? ch : ''}</span>
            </div>
          );
        })}
      </div>
      <span className="hint-length-badge">{letters} letters</span>
    </div>
  );
}
