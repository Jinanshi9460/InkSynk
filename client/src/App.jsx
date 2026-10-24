import { useCallback, useEffect, useRef, useState } from 'react';
import { useSocket } from './hooks/useSocket.js';
import { EVENTS, PHASES } from './events.js';
import { useGameSession } from './hooks/useGameSession.js';
import { useChat } from './hooks/useChat.js';
import Header from './components/Header.jsx';
import Home from './pages/Home.jsx';
import Lobby from './pages/Lobby.jsx';
import Game from './pages/Game.jsx';

// Room code from an invite link like https://site/?room=ABCDE
function getInviteCode() {
  const code = new URLSearchParams(window.location.search).get('room');
  return code ? code.trim().toUpperCase().slice(0, 8) : '';
}

export default function App() {
  const { connected, everConnected, connectError, request, send, subscribe } = useSocket();
  // `room` is the latest public snapshot from the server; null means "not in a room".
  const [room, setRoom] = useState(null);
  const [myId, setMyId] = useState(null);
  const [notice, setNotice] = useState('');
  const wasInRoom = useRef(false);
  const prevPhase = useRef(null);
  // serverNow - clientNow at the last snapshot: lets the countdown follow the SERVER's deadline.
  const [clockOffset, setClockOffset] = useState(0);

  // One timer for the toast; cleared on every new notice and on unmount (no setState after unmount).
  const noticeTimer = useRef(0);
  const showNotice = useCallback((message) => {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 4000);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  // Server pushes: full snapshots plus small join/leave notifications.
  useEffect(() => {
    const offState = subscribe(EVENTS.GAME_STATE, (state) => {
      if (state.game?.serverNow) setClockOffset(state.game.serverNow - Date.now());
      setRoom(state);
    });
    const offJoin = subscribe(EVENTS.PLAYER_JOINED, ({ player }) => showNotice(`${player.username} joined`));
    const offLeft = subscribe(EVENTS.PLAYER_LEFT, ({ username }) => showNotice(`${username} left`));
    return () => {
      offState();
      offJoin();
      offLeft();
    };
  }, [subscribe, showNotice]);

  // Dynamic document title
  useEffect(() => {
    if (!room) {
      document.title = 'InkSynk — Multiplayer Draw & Guess';
    } else if (room.phase === PHASES.LOBBY) {
      document.title = `InkSynk · Lobby [${room.code}]`;
    } else if (room.game) {
      document.title = `InkSynk · Round ${room.game.round}/${room.game.totalRounds} [${room.code}]`;
    } else {
      document.title = `InkSynk · Room [${room.code}]`;
    }
  }, [room]);

  // If the connection drops while in a room, the server has already removed us.
  useEffect(() => {
    wasInRoom.current = Boolean(room);
  }, [room]);
  useEffect(() => {
    if (!connected && wasInRoom.current) {
      setRoom(null);
      setMyId(null);
      showNotice('Connection lost. You were removed from the room.');
    }
  }, [connected, showNotice]);

  // The server returns the room to the lobby when too many players leave mid-game.
  useEffect(() => {
    const phase = room?.phase ?? null;
    // GAME_OVER -> LOBBY is the host's "Play again", not an aborted game.
    if (phase === PHASES.LOBBY && prevPhase.current && prevPhase.current !== PHASES.LOBBY && prevPhase.current !== PHASES.GAME_OVER) {
      showNotice('The game was stopped because too few players are left.');
    }
    prevPhase.current = phase;
  }, [room?.phase, showNotice]);

  // Private per-player game data (the drawer's word options / secret word).
  const session = useGameSession({ subscribe, request, room, connected });
  // Chat history (guesses, notifications, chat) - kept here so no message is lost between pages.
  const chatMessages = useChat({ subscribe, room });

  const enterRoom = useCallback((playerId, roomState) => {
    setMyId(playerId);
    setRoom(roomState);
    // Drop ?room=CODE from the address bar once we're in.
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const leaveRoom = useCallback(async () => {
    await request(EVENTS.LEAVE_ROOM);
    setRoom(null);
    setMyId(null);
  }, [request]);

  // Host only (the server enforces it): after the final leaderboard, go back to the lobby together.
  const playAgain = useCallback(() => request(EVENTS.PLAY_AGAIN), [request]);

  let page;
  if (!room) {
    page = <Home connected={connected} connectError={connectError} everConnected={everConnected} request={request} onEntered={enterRoom} initialCode={getInviteCode()} notice={notice} />;
  } else if (room.phase === 'lobby') {
    page = <Lobby room={room} myId={myId} request={request} onLeave={leaveRoom} notice={notice} />;
  } else {
    page = (
      <Game
        room={room}
        myId={myId}
        connected={connected}
        request={request}
        send={send}
        subscribe={subscribe}
        onLeave={leaveRoom}
        onPlayAgain={playAgain}
        notice={notice}
        session={session}
        chatMessages={chatMessages}
        clockOffset={clockOffset}
      />
    );
  }

  return (
    <div className="app">
      <Header connected={connected} everConnected={everConnected} connectError={connectError} roomCode={room?.code} />
      <main className="main">{page}</main>
    </div>
  );
}
