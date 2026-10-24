import { LIMITS, SETTING_FIELDS } from '../events.js';

// Controlled settings editor shared by Home (create room) and Lobby (host edits).
// `draft` holds raw input values; convert with draftToSettings() before sending.
export default function SettingsForm({ draft, setDraft, disabled = false }) {
  return (
    <div className="settings-grid">
      {SETTING_FIELDS.map(({ key, label }) => (
        <label className="field" key={key}>
          <span>{label}</span>
          <input
            type="number"
            inputMode="numeric"
            min={LIMITS[key].min}
            max={LIMITS[key].max}
            value={draft[key]}
            disabled={disabled}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          />
          <small className="muted">{LIMITS[key].min}–{LIMITS[key].max}</small>
        </label>
      ))}
      <label className="field">
        <span>Visibility</span>
        <select
          value={draft.isPublic ? 'public' : 'private'}
          disabled={disabled}
          onChange={(e) => setDraft({ ...draft, isPublic: e.target.value === 'public' })}
        >
          <option value="private">Private (invite only)</option>
          <option value="public">Public</option>
        </select>
        <small className="muted">Public rooms are only labelled for now.</small>
      </label>
    </div>
  );
}
