// @cloudflare/workers-types doesn't ship ambient types for the nodejs_compat
// module surface (wrangler.toml's compatibility_flags = ["nodejs_compat"]
// makes `node:crypto` available at runtime, but not at the type level) --
// this is the narrow slice actually used, in src/lib/crypto.ts.
declare module 'node:crypto' {
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
