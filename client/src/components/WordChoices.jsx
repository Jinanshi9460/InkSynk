import { sounds } from '../lib/audio.js';

export default function WordChoices({ options, onChoose, busy }) {
  function handleSelect(word) {
    sounds.play('pop');
    onChoose(word);
  }

  return (
    <div className="word-choices-card animate-pop">
      <div className="word-choices-header">
        <span className="choice-badge">🎨 YOUR TURN TO DRAW</span>
        <h3 className="word-choices-title">Pick a Secret Word</h3>
      </div>
      <div className="word-choices-list">
        {options.map((word) => (
          <button
            key={word}
            type="button"
            className="btn btn-word-choice"
            disabled={busy}
            onClick={() => handleSelect(word)}
          >
            <span className="word-text">{word}</span>
            <span className="word-draw-icon">✏️</span>
          </button>
        ))}
      </div>
      <p className="muted small auto-pick-note">⏳ Auto-picks in a few seconds if you don't choose!</p>
    </div>
  );
}
