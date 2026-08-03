async function request(path, options = {}) {
  const res = await fetch(path, { credentials: 'include', ...options });
  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      // Response body wasn't JSON (or was empty) -- leave body null so
      // callers can still inspect `status` without crashing on parse.
    }
    const err = new Error(`Request to ${path} failed: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  me: () => request('/api/me'),
  candidates: (mode, limit = 10) => request(`/api/candidates/${mode}?limit=${limit}`),
  swipe: (mode, body) =>
    request(`/api/swipe/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  matches: () => request('/api/matches'),
  messages: (matchId) => request(`/api/matches/${matchId}/messages`),
  sendMessage: (matchId, body) =>
    request(`/api/matches/${matchId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }),
  onboard: (payload) =>
    request('/api/onboarding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  block: (userId) =>
    request('/api/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId }) }),
  report: (userId, reason, details) =>
    request('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, reason, details }),
    }),
  unmatch: (matchId) => request(`/api/matches/${matchId}/unmatch`, { method: 'POST' }),
  deleteAccount: () => request('/api/account', { method: 'DELETE' }),
  photoUploadUrl: (payload) =>
    request('/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  deletePhoto: (photoId) => request(`/api/photos/${photoId}`, { method: 'DELETE' }),
  swipeHistory: (mode, limit = 20, offset = 0) => request(`/api/swipes/${mode}?limit=${limit}&offset=${offset}`),
  updateSwipe: (mode, id, direction) =>
    request(`/api/swipes/${mode}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }) }),
};
