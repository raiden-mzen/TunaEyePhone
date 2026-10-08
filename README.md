# TunaEye Kiosk — Expo React Native

Plain-local Expo React Native conversion of the supplied TunaEye HTML kiosk prototype.

## Run

```bash
npm install
npx expo start
```

Use Expo Go or press `w` for Expo Web. The app is client-only and uses demo fixtures for camera, grading model, scale, cloud sync, and printer behavior. Tap **Demo** to exercise alternate states.

## Cloud sync (shared Supabase project)

The app syncs to the **same** Supabase project as TunaEye Kiosk/Admin and follows
`docs/SHARED_SUPABASE_CONTRACT.md` in the kiosk repo (table `grading_records`, private bucket
`grading-images`, `source = 'mobile'`). Raspberry Pi never talks to Supabase; the phone does.

1. `cp .env.example .env` and fill `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` (same values as the kiosk's `VITE_*`). Anon/publishable key only, never `service_role`.
2. Enable **Anonymous sign-ins** in the shared project (same requirement as the kiosk).
3. Apply the kiosk migration `supabase/migrations/202610070001_shared_grading_contract.sql` once (kiosk repo).

Behaviour: results are saved on the device (AsyncStorage + image files) as `pending`, shown normally, and synced when
connectivity returns or on **Sync now**. Each sample is one `grading_records` row with a stable id
(`<record uuid>-core|tail`) and image path `{user_id}/{id}/{sample_type}.jpg`, so retries never duplicate.
No Realtime, no polling. Without the env vars the app still works offline and keeps records `pending`.

```bash
npm run typecheck && npm test && npm run build
```
