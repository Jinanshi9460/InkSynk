// Tiny sliding-window rate limiter (per socket, in memory). No dependencies.
//
//   const limit = createLimiter({ max: 10, windowMs: 5000 });
//   if (!limit(socket)) return fail(RATE_LIMITED, '...');   // true = allowed
//
// Timestamps are stored on `socket.data` under the limiter's own key, so they disappear with
// the socket and can never leak between connections or outlive a disconnect.

let nextKey = 0;

export function createLimiter({ max, windowMs }) {
  const key = `rl_${nextKey++}`;
  return function allow(socket) {
    const now = Date.now();
    const recent = (socket.data[key] ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      socket.data[key] = recent;
      return false;
    }
    recent.push(now);
    socket.data[key] = recent;
    return true;
  };
}
