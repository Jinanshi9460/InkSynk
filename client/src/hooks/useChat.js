import { useEffect, useState } from 'react';
import { EVENTS, PHASES } from '../events.js';

const MAX_KEPT = 200;

/**
 * Chat history for the current game. The server is the only source: every line (guesses,
 * "X guessed the word!", system notes, restricted chat) arrives as a chat_message event, already
 * filtered for THIS player, so nothing here decides who may see what.
 *
 * It lives at App level (always mounted) so no message is lost while the page switches from
 * Lobby to Game. History is cleared whenever we are not in a running game.
 * Messages carry a server-assigned `id`, used to drop duplicates and as the React key.
 */
export function useChat({ subscribe, room }) {
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    const off = subscribe(EVENTS.CHAT_MESSAGE, (msg) => {
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg].slice(-MAX_KEPT)));
    });
    return off;
  }, [subscribe]);

  const inGame = Boolean(room) && room.phase !== PHASES.LOBBY;
  useEffect(() => {
    if (!inGame) setMessages([]);
  }, [inGame]);

  return messages;
}
