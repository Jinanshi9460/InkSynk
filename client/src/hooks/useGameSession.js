import { useEffect, useRef, useState } from 'react';
import { EVENTS, PHASES } from '../events.js';

/**
 * Keeps the PRIVATE, per-player part of the game: the drawer's word options (during word
 * selection) and the secret word (while drawing). Only the drawer's socket ever receives these,
 * so for guessers both stay null.
 *
 * It lives at App level (always mounted) so a round_start / word_chosen that arrives while the
 * page switches from Lobby to Game is not lost. Every phase/turn change also asks the server
 * for a recovery snapshot (sync_game), so the data is restored even if an event was missed.
 *
 * Data is tagged with the turnId it belongs to, so stale values from a previous turn are
 * never shown.
 */
export function useGameSession({ subscribe, request, room, connected }) {
  const [priv, setPriv] = useState({ turnId: null, wordOptions: null, word: null });
  const turnIdRef = useRef(null);
  turnIdRef.current = room?.game?.turnId ?? null;

  useEffect(() => {
    const offStart = subscribe(EVENTS.ROUND_START, (d) =>
      setPriv({ turnId: d.turnId, wordOptions: d.wordOptions ?? null, word: null }));
    const offWord = subscribe(EVENTS.WORD_CHOSEN, (d) =>
      setPriv({ turnId: d.turnId, wordOptions: null, word: d.word }));
    return () => {
      offStart();
      offWord();
    };
  }, [subscribe]);

  const phase = room?.phase;
  const turnId = room?.game?.turnId ?? null;
  useEffect(() => {
    if (!connected || !phase || phase === PHASES.LOBBY || phase === PHASES.GAME_OVER) {
      if (phase === PHASES.LOBBY) setPriv({ turnId: null, wordOptions: null, word: null });
      return undefined;
    }
    let cancelled = false;
    request(EVENTS.SYNC_GAME).then((res) => {
      if (cancelled || !res.ok || res.you.turnId !== turnIdRef.current) return;
      setPriv((prev) => {
        // Keep what events already delivered for this turn; only fill gaps from the snapshot.
        if (prev.turnId === res.you.turnId && (prev.word || prev.wordOptions)) return prev;
        return { turnId: res.you.turnId, wordOptions: res.you.wordOptions ?? null, word: res.you.word ?? null };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [connected, phase, turnId, request]);

  const current = priv.turnId !== null && priv.turnId === turnId;
  return {
    wordOptions: current ? priv.wordOptions : null,
    word: current ? priv.word : null,
  };
}
