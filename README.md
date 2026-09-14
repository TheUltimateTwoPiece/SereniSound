# SereniSound caregiver monitor

A Next.js App Router dashboard for the ESP32 wearable. It uses a single Supabase `device_status` row and Supabase Realtime for live caregiver updates.

## 1. Supabase

Run [`supabase/schema.sql`](./supabase/schema.sql) in the Supabase SQL editor. The migration safely enables the Realtime publication for `device_status`, so it can be run again even if Supabase has already added the table.

## 2. Environment

Copy `.env.example` to `.env.local` and fill in the values. The service-role key and `DEVICE_UPDATE_TOKEN` are server-only. Use a separate browser-restricted Google Maps key with Maps JavaScript API enabled. The ESP32 key is not reused in the browser. Set the same long random device token in Vercel and the sketch before flashing.

## 3. Run and verify

```bash
npm install
npm run typecheck
npm run build
npm run dev
```

Open `http://localhost:3000/dashboard`.

Simulate an ESP32 update:

```bash
curl -X POST http://localhost:3000/api/device/update \
  -H 'Content-Type: application/json' \
  -H 'X-Device-Token: CREATE_A_LONG_RANDOM_DEVICE_TOKEN' \
  -d '{"device_id":"pwd-001","latitude":1.315742,"longitude":103.766602,"address":"Blk 123 Clementi Ave 3, Singapore 129xxx","location_source":"GPS","location_accuracy":5,"current_track":2,"total_tracks":5,"is_playing":true,"volume":15,"heart_rate":null}'
```

## 4. Vercel

Import the repository into Vercel, set the five environment variables from `.env.example` for Production/Preview as appropriate, then deploy. Do not paste tokens into source control. Rotate any Supabase or Vercel token that has been shared in chat.

## 5. ESP32

The completed sketch is in [`esp32/serenisound_wearable.ino`](./esp32/serenisound_wearable.ino). Set `DEVICE_UPDATE_URL` to the deployed `/api/device/update` URL before flashing. The sketch preserves the supplied GPIO assignments and music/button behavior, uses GPS first and WPS fallback, throttles reverse geocoding, performs device updates every five seconds with transient retries, and polls the secure command endpoint for caregiver music commands. Backend failures remain non-fatal.

The wearable also supports a three-button power-save latch: hold all three buttons for three seconds to stop playback, notify the dashboard that the device is powered off, and switch off Wi-Fi, GPS, and the display. Hold all three buttons for another three seconds to bring everything back; the display and GPS return first and the sketch reconnects Wi-Fi in the background, so buttons and audio stay responsive the whole time. Wi-Fi is only re-enabled after the wake, and the DFPlayer stays initialized instead of being put to sleep, because reviving it over serial after a sleep was unreliable. If the dashboard cannot be reached while powering down, the device still enters power-save after a short grace period.
