export interface TestUserOverrides {
  id?: string;
  spotifyId?: string;
  email?: string | null;
  displayName?: string | null;
  bio?: string | null;
  lat?: number | null;
  lng?: number | null;
  maxDistanceKm?: number;
  ageMin?: number;
  ageMax?: number;
  gender?: string | null;
  seeking?: string | null;
  dateOfBirth?: string | null;
  ageVerifiedAt?: number | null;
  onboardedAt?: number | null;
  deletedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  avatarUrl?: string | null;
  productTier?: string | null;
  skipSpotify?: boolean;
}

export async function insertTestUser(db: D1Database, overrides: TestUserOverrides = {}): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  const spotifyId = overrides.spotifyId ?? `spotify-${id}`;
  const now = overrides.createdAt ?? Date.now();
  const updatedAt = overrides.updatedAt ?? now;
  const tokenExpiresAt = overrides.tokenExpiresAt ?? now + 3600 * 1000;

  await db
    .prepare(
      `INSERT INTO users (
         id, spotify_id, display_name, bio, date_of_birth, age_verified_at, location_label, lat, lng,
         location_updated_at, max_distance_km, age_min, age_max, gender, seeking, intent, email,
         onboarded_at, deleted_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      spotifyId,
      overrides.displayName ?? null,
      overrides.bio ?? null,
      overrides.dateOfBirth ?? null,
      overrides.ageVerifiedAt ?? null,
      overrides.lat ?? null,
      overrides.lng ?? null,
      overrides.maxDistanceKm ?? 80,
      overrides.ageMin ?? 18,
      overrides.ageMax ?? 100,
      overrides.gender ?? null,
      overrides.seeking ?? null,
      overrides.email ?? null,
      overrides.onboardedAt ?? null,
      overrides.deletedAt ?? null,
      now,
      updatedAt
    )
    .run();

  if (overrides.skipSpotify) return id;

  await db
    .prepare(
      `INSERT INTO auth_identities (id, user_id, provider, provider_id, email, created_at, updated_at)
       VALUES (?, ?, 'spotify', ?, ?, ?, ?)`
    )
    .bind(crypto.randomUUID(), id, spotifyId, overrides.email ?? null, now, updatedAt)
    .run();

  await db
    .prepare(
      `INSERT INTO music_source_tokens (id, user_id, provider, provider_user_id, access_token, refresh_token, token_expires_at, avatar_url, product_tier, created_at, updated_at)
       VALUES (?, ?, 'spotify', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      id,
      spotifyId,
      overrides.accessToken ?? 'test-access-token',
      overrides.refreshToken ?? 'test-refresh-token',
      tokenExpiresAt,
      overrides.avatarUrl ?? null,
      overrides.productTier ?? null,
      now,
      updatedAt
    )
    .run();

  return id;
}
