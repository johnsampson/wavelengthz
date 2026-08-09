# Native App + Store Distribution — Roadmap

**Status:** Future work, not scheduled. This is a roadmap, not a task-by-task implementation plan — most of it is external account setup rather than code, so there's nothing here to TDD. Pick up any item independently; only the noted ordering constraint applies.

**Context:** [Plan 1](../specs/2026-08-09-push-notifications-design.md) delivers push notifications via Web Push against the existing PWA, with no store presence needed. This roadmap is the separate, larger step of shipping actual native iOS/Android apps through the App Store and Play Store — worth doing eventually for discoverability and native platform integration, but not required for push notifications to work.

## Items

- [ ] **Apple Developer Program enrollment.** Choose **Individual** account (no DUNS number, $99/yr, just a real name) unless there's a specific reason to publish under a company name. **Organization** accounts are the only path that requires a DUNS number — Dun & Bradstreet issues these, and it can take anywhere from a few days to a few weeks if the business doesn't already have one. Defer the Organization/DUNS question entirely unless it actually becomes necessary.
- [ ] **Google Play Console signup.** $25 one-time fee. No DUNS requirement on any Play Console account tier — this item has no blocking dependency.
- [ ] **Wrap the existing PWA with Capacitor** (or an equivalent native-shell tool) to produce iOS/Android app targets that load the existing web app, with a bridge for native APIs (push chief among them).
- [ ] **Wire native push**: APNs (iOS) + FCM (Android) as a second send path. Reuses the same `notifyMatch`/`notifyMessage` trigger points already built for Plan 1's Web Push — this item mainly adds a device-token storage table and an APNs/FCM-specific send function alongside `src/lib/webPush.ts`, not a new notification architecture.
- [ ] **Store submission prep**: listings, screenshots, updated privacy policy (push permission + any native-specific data use disclosures), and — specific to a dating app — App Store's safety-feature review (Guideline 1.1.4-adjacent expectations around blocking/reporting, which this app already has).

## Ordering

Only real constraint: enrollment (items 1–2) has to happen before store submission (item 5). Everything else can start in any order, independently.
