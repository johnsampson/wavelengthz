async function request(path, options = {}) {
  const res = await fetch(path, { credentials: 'include', ...options });
  if (!res.ok) throw new Error(`Request to ${path} failed: ${res.status}`);
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
};
