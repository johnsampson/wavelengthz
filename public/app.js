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

// Shared with onboarding.html and settings.html so the option list can't drift
// between the two places it's picked. 'making_friends' retired -- superseded
// by the real seeking:'friends' filter (src/routes/onboarding.ts's
// SEEKING_OPTIONS), which actually changes who you match with rather than
// just being a label. 'dating_around' retired too -- it and 'something_casual'
// read as the same option to anyone picking one, so this collapses them
// rather than asking users to guess the distinction. Kept in sync with
// onboarding.ts's INTENT_OPTIONS set.
export const INTENT_OPTIONS = [
  { value: 'long_term_relationship', label: 'Long-term relationship' },
  { value: 'something_casual', label: 'Something casual' },
  { value: 'not_sure_yet', label: 'Not sure yet' },
];

export const api = {
  me: () => request('/api/me'),
  // Backs public/wavelengthzPlayer.js. `available: false` (Free tier, or not
  // yet re-authorized for the `streaming` scope) is the normal, common-case
  // response -- never thrown as an error.
  playerToken: () => request('/api/me/player-token'),
  candidates: (mode, limit = 10) => request(`/api/candidates/${mode}?limit=${limit}`),
  swipe: (mode, body) =>
    request(`/api/swipe/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  matches: () => request('/api/matches'),
  matchDetail: (matchId) => request(`/api/matches/${matchId}`),
  /** @param {number} [limit] - omit for the server default; artist.html's "Load more" passes a higher value */
  artistProfile: (artistId, limit) => request(`/api/artists/${artistId}${limit ? `?limit=${limit}` : ''}`),
  personProfile: (userId) => request(`/api/people/${userId}/profile`),
  artistSearch: (q) => request(`/api/artists/search?q=${encodeURIComponent(q)}`),
  // Persists a live (not-yet-cataloged) Spotify search result into the
  // artists table -- see GET /api/artists/search's `inCatalog: false` shape.
  createArtist: (spotifyArtistId) =>
    request('/api/artists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spotifyArtistId }) }),
  messages: (matchId) => request(`/api/matches/${matchId}/messages`),
  sendMessage: (matchId, body) =>
    request(`/api/matches/${matchId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }),
  recallMessage: (matchId, messageId) => request(`/api/matches/${matchId}/messages/${messageId}/recall`, { method: 'POST' }),
  onboard: (payload) =>
    request('/api/onboarding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  /** @param {string|null} trackId - one of the caller's own top tracks, or null to clear */
  setAnthem: (trackId) =>
    request('/api/me/anthem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackId }) }),
  setEmailNotificationsEnabled: (enabled) =>
    request('/api/me/email-notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  messagingStatus: () => request('/api/me/messaging-status'),
  /** @param {string} phoneNumber - E.164, e.g. "+15551234567" */
  startPhoneVerification: (phoneNumber) =>
    request('/api/phone/verify/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phoneNumber }) }),
  checkPhoneVerification: (phoneNumber, code) =>
    request('/api/phone/verify/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber, code }),
    }),
  block: (userId) =>
    request('/api/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId }) }),
  blocks: () => request('/api/blocks'),
  unblock: (userId) => request(`/api/blocks/${userId}/unblock`, { method: 'POST' }),
  blockedGenres: () => request('/api/genres/blocked'),
  blockGenre: (genre) => request(`/api/genres/${encodeURIComponent(genre)}/block`, { method: 'POST' }),
  unblockGenre: (genre) => request(`/api/genres/${encodeURIComponent(genre)}/unblock`, { method: 'POST' }),
  report: (userId, reason, details) =>
    request('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, reason, details }),
    }),
  unmatch: (matchId) => request(`/api/matches/${matchId}/unmatch`, { method: 'POST' }),
  deleteAccount: () => request('/api/account', { method: 'DELETE' }),
  myPhotos: () => request('/api/photos'),
  deletePhoto: (photoId) => request(`/api/photos/${photoId}`, { method: 'DELETE' }),
  /**
   * @param {'people'|'artist'|'track'} mode - 'artist'/'track' both hit the
   *   same GET /api/swipes/music, distinguished by an item_type param --
   *   there's no separate /api/swipes/artist or /api/swipes/track route.
   * @param {'left'|'right'|null} [direction]
   */
  swipeHistory: (mode, limit = 20, offset = 0, direction = null) => {
    const isMusic = mode === 'artist' || mode === 'track';
    const params = `limit=${limit}&offset=${offset}${direction ? `&direction=${direction}` : ''}${isMusic ? `&item_type=${mode}` : ''}`;
    return request(`/api/swipes/${isMusic ? 'music' : mode}?${params}`);
  },
  updateSwipe: (mode, id, direction) => {
    const endpoint = mode === 'artist' || mode === 'track' ? 'music' : mode;
    return request(`/api/swipes/${endpoint}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }) });
  },
  notifications: () => request('/api/notifications'),
  markNotificationRead: (id) => request(`/api/notifications/${id}/read`, { method: 'POST' }),
  groups: () => request('/api/groups'),
  groupDetail: (groupId) => request(`/api/groups/${groupId}`),
  createGroup: (name, topic) =>
    request('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, topic }) }),
  joinGroup: (groupId) => request(`/api/groups/${groupId}/join`, { method: 'POST' }),
  leaveGroup: (groupId) => request(`/api/groups/${groupId}/leave`, { method: 'POST' }),
  groupMessages: (groupId) => request(`/api/groups/${groupId}/messages`),
  sendGroupMessage: (groupId, body) =>
    request(`/api/groups/${groupId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }),
  recallGroupMessage: (groupId, messageId) => request(`/api/groups/${groupId}/messages/${messageId}/recall`, { method: 'POST' }),
  pushVapidPublicKey: () => request('/api/push/vapid-public-key'),
  pushSubscribe: (subscription) =>
    request('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subscription) }),
  pushUnsubscribe: (endpoint) =>
    request('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }) }),
};
