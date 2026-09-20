# SereniSound caregiver monitor

A Next.js App Router dashboard for the ESP32 wearable. It uses a single Supabase `device_status` row and Supabase Realtime for live caregiver updates.

## 1. Supabase

Run [`supabase/schema.sql`](./supabase/schema.sql) in the Supabase SQL editor. The migration safely enables the Realtime publication for `device_status`, so it can be run again even if Supabase has already added the table.

## 2. Environment

Copy `.env.example` to `.env.local` and fill in the values. The service-role key and `DEVICE_UPDATE_TOKEN` are server-only. Use a separate browser-restricted Google Maps key with Maps JavaScript API enabled. The ESP32 key is not reused in the browser. Set the same long random device token in Vercel and the sketch before flashing.

Warning emails are sent through Brevo SMTP, so three more server-only values are needed:

| Variable | Meaning |
| --- | --- |
| `BREVO_SMTP_USER` | The login email of the Brevo account that owns the SMTP key. |
| `BREVO_SMTP_KEY` | The SMTP key from Brevo → SMTP & API → SMTP. |
| `ALERT_FROM_EMAIL` | A sender address verified in Brevo. Falls back to `BREVO_SMTP_USER`. |

`BREVO_SMTP_HOST` and `BREVO_SMTP_PORT` are optional and default to `smtp-relay.brevo.com:587`. Without any Brevo credential the dashboard still records every warning but reports that the email was skipped, so a configuration problem is visible instead of silent.

There is also a one-credential option: set `BREVO_API_KEY` (Brevo → SMTP & API → API Keys) and every warning is sent through Brevo's HTTPS API instead. That path skips SMTP authentication entirely, so `BREVO_SMTP_USER` and `BREVO_SMTP_KEY` become unnecessary. If both are present, the API key wins. This is the same mechanism the sibling `homework-board` project uses, and it is the less fragile of the two: no SMTP handshake, no login string, no authorized-IP list.

Brevo issues two different kinds of key and they are not interchangeable:

| Key | Looks like | Used for |
| --- | --- | --- |
| API key | `xkeysib-…` | `BREVO_API_KEY`, sent as the `api-key` header. |
| SMTP key | `xsmtpsib-…` | `BREVO_SMTP_KEY`, the password of the SMTP login. |

Putting an SMTP key in `BREVO_API_KEY` returns `401 Key not found`, and using a login that is not the exact string Brevo shows on the SMTP panel returns `535 Authentication failed`. Both are surfaced in the warning history, and the code now rejects an `xsmtpsib-` value in `BREVO_API_KEY` immediately with an explanation instead of spending a request on it.

Two SMTP traps are worth knowing about, because Brevo's error messages hide both:

1. The SMTP relay login is **not** always the address you sign in with. Brevo exposes the real one as `relay.data.userName` from `GET https://api.brevo.com/v3/account` (for example `b2b8ed001@smtp-brevo.com`).
2. If the account restricts sending to authorised IP addresses, SMTP also fails, and typically reports it as a generic `535 Authentication failed`. With the correct login it becomes the explicit `525 5.7.1 Unauthorized IP address`. Vercel cannot be allow-listed because its addresses change, so on a restricted account the API key is the only usable path — which is the configuration this project ships with.

Brevo reports every rejected send with the exact reason (for example `535 5.7.8 Authentication failed` for a login/key mismatch, or the sender-verification error when `ALERT_FROM_EMAIL` is not a verified sender). Those messages appear verbatim in the dashboard's warning history.

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

Import the repository into Vercel, set every environment variable from `.env.example` (including the Brevo ones) for Production/Preview as appropriate, then deploy. Do not paste tokens into source control. Rotate any Supabase or Vercel token that has been shared in chat.

## 5. Caregiver warnings (safety zone and heart rate)

The dashboard has a **Safety zone & warnings** card where the caregiver sets:

- the warning email address,
- a zone name, centre (latitude/longitude) and radius in metres, with a one-click *use the wearable's current position* button,
- a maximum heart rate in bpm,
- and master switches for each check.

The zone is drawn on the map as a circle that turns red when the wearable is outside it. Distance, the current reading and the resulting state are shown live.

Checks run on the server for every wearable upload (roughly every five seconds), so the ESP32 needs no changes and no zone download. Warnings are throttled to one email per check per five minutes so a single incident cannot flood the inbox; the dashboard log still records every evaluation. Delivery results (`sent`, `failed`, `skipped`) are stored with each warning and shown in the history list.

### Demo testing panel

A **Feature demo panel** runs the same detection and email code as live traffic, but against invented readings, so all of it can be demonstrated without moving the wearable:

| Button | What it proves |
| --- | --- |
| Zone breach warning | Builds a simulated position outside the zone and emails the caregiver. |
| Heart-rate warning | Builds a simulated reading above the limit and emails the caregiver. |
| Send test email | Confirms Brevo delivery on its own. |
| Mark safe again | Records a recovery notice and clears the warning cooldowns. |
| Clear history | Deletes the demo log so the next demo starts clean. |

Demo emails are marked `[DEMO]` in the subject and ignore the cooldown. If no zone is configured yet, the zone demo temporarily centres one on the wearable's last known position.

### Live heart rate

The firmware already uploads `heart_rate` (and sends `null` when no sensor is attached), and `setHeartRate(bpm)` is the intended entry point for a sensor reading. No pulse sensor is read yet, so real heart-rate warnings begin once that call is wired to a sensor.

## 6. ESP32

The completed sketch is `esp32/serenisound_wearable.ino`. It is deliberately **not** in version control: it hardcodes the Wi-Fi credentials, the Google geolocation key and the device token, so `esp32/` is gitignored and the file exists only on the machine that flashes the board. Set `DEVICE_UPDATE_URL` to the deployed `/api/device/update` URL before flashing. The sketch preserves the supplied GPIO assignments and music/button behavior, uses GPS first and WPS fallback, throttles reverse geocoding, performs device updates every five seconds with transient retries, and polls the secure command endpoint for caregiver music commands. Backend failures remain non-fatal.

The wearable also supports a three-button power-save latch: hold all three buttons for three seconds to stop playback, notify the dashboard that the device is powered off, and switch off Wi-Fi, GPS, and the display. Hold all three buttons for another three seconds to bring everything back; the display and GPS return first and the sketch reconnects Wi-Fi in the background, so buttons and audio stay responsive the whole time. Wi-Fi is only re-enabled after the wake, and the DFPlayer stays initialized instead of being put to sleep, because reviving it over serial after a sleep was unreliable. If the dashboard cannot be reached while powering down, the device still enters power-save after a short grace period.
