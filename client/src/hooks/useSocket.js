import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

// Dev falls back to the local server; production must set VITE_SERVER_URL
// (otherwise we assume the server is served from the same origin).
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  (import.meta.env.DEV ? 'http://localhost:3000' : window.location.origin);

const ACK_TIMEOUT_MS = 8000;

/**
 * Owns the single Socket.IO connection for the app.
 * - `connected`: live connection status
 * - `request(event, payload)`: emit with an ack; always resolves to { ok, ... }
 *   (network failures/timeouts resolve to { ok: false, error } instead of throwing)
 * - `send(event, payload, onAck?)`: fire-and-forget emit (optionally with an ack callback)
 * - `everConnected`: true once the first connection succeeded (to tell "connecting" from "lost")
 * - `connectError`: true while connection attempts are failing (shown as a helpful message in the UI)
 * - `subscribe(event, handler)`: listen for a server event; returns an unsubscribe function
 */
export function useSocket() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  // True while the last connection attempt failed (server asleep, wrong URL, CORS...). Cleared on connect.
  const [connectError, setConnectError] = useState(false);

  useEffect(() => {
    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setEverConnected(true);
      setConnectError(false);
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnectError(true));

    return () => {
      socket.removeAllListeners(); // nothing from this socket may call setState after unmount
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const request = useCallback((event, payload = {}) => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) {
      return Promise.resolve({
        ok: false,
        error: { code: 'NOT_CONNECTED', message: 'Not connected to the server. Please wait and try again.' },
      });
    }
    return socket
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck(event, payload)
      .catch(() => ({
        ok: false,
        error: { code: 'TIMEOUT', message: 'The server took too long to respond.' },
      }));
  }, []);

  // Fire-and-forget emit for high-frequency events (drawing). An ack callback is optional;
  // if given it receives { ok, ... } (or a synthetic failure when offline / timed out).
  const send = useCallback((event, payload, onAck) => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) {
      onAck?.({ ok: false, error: { code: 'NOT_CONNECTED', message: 'Not connected to the server.' } });
      return;
    }
    if (!onAck) {
      socket.emit(event, payload);
      return;
    }
    socket.timeout(ACK_TIMEOUT_MS).emit(event, payload, (err, res) => {
      onAck(err ? { ok: false, error: { code: 'TIMEOUT', message: 'The server took too long to respond.' } } : res);
    });
  }, []);

  const subscribe = useCallback((event, handler) => {
    const socket = socketRef.current;
    if (!socket) return () => {};
    socket.on(event, handler);
    return () => socket.off(event, handler);
  }, []);

  return { connected, everConnected, connectError, request, send, subscribe };
}
