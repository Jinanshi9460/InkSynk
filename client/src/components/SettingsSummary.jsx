// Read-only chips showing the room's current settings (visible to every player).
export default function SettingsSummary({ settings }) {
  const items = [
    ['Visibility', settings.isPublic ? 'Public' : 'Private'],
    ['Max players', settings.maxPlayers],
    ['Rounds', settings.rounds],
    ['Draw time', `${settings.drawTime}s`],
    ['Word choices', settings.wordChoices],
    ['Hints', settings.hints === 0 ? 'Off' : settings.hints],
  ];
  return (
    <ul className="chips" aria-label="Room settings">
      {items.map(([label, value]) => (
        <li key={label} className="chip">
          <span className="muted">{label}</span> <strong>{value}</strong>
        </li>
      ))}
    </ul>
  );
}
