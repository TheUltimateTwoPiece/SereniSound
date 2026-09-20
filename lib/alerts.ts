import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { haversineMeters } from "./geo";
import { getSupabaseServer } from "./supabase-server";
import {
  DEFAULT_ALERT_SETTINGS,
  type AlertEvent,
  type AlertKind,
  type AlertSettings,
  type DeviceStatus,
} from "./types";

export const DEFAULT_ALERT_EMAIL = DEFAULT_ALERT_SETTINGS.alert_email;

/** Real (device-driven) alerts are throttled so one incident cannot flood the inbox. */
export const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

const BREVO_SMTP_HOST = process.env.BREVO_SMTP_HOST || "smtp-relay.brevo.com";
const BREVO_SMTP_PORT = Number(process.env.BREVO_SMTP_PORT || 587);
const ROUND_TRIP_LIMIT = 20;

let cachedTransport: Transporter | null = null;

/* ------------------------------------------------------------------ */
/* Geofence maths                                                      */
/* ------------------------------------------------------------------ */

export { haversineMeters };

export function zoneDistance(status: DeviceStatus, settings: AlertSettings) {
  if (status.latitude === null || status.longitude === null) return null;
  if (settings.zone_latitude === null || settings.zone_longitude === null) return null;
  return haversineMeters(
    { latitude: status.latitude, longitude: status.longitude },
    { latitude: settings.zone_latitude, longitude: settings.zone_longitude },
  );
}

/* ------------------------------------------------------------------ */
/* Detection (pure)                                                    */
/* ------------------------------------------------------------------ */

/**
 * Decides which warnings the current telemetry should raise. Pure function so the
 * dashboard demo panel can run the exact same logic against simulated readings.
 */
export function evaluateTelemetry(status: DeviceStatus, settings: AlertSettings): AlertEvent[] {
  if (!settings.alerts_enabled) return [];

  const events: AlertEvent[] = [];

  if (settings.geofence_enabled) {
    const distance = zoneDistance(status, settings);
    if (distance !== null && distance > settings.zone_radius_m) {
      const overBy = Math.round(distance - settings.zone_radius_m);
      events.push({
        kind: "geofence_exit",
        severity: "warning",
        subject: `Safety zone breach: PWD is ${overBy} m outside ${settings.zone_label}`,
        headline: "Safety zone breach detected",
        message: `The wearable is about ${Math.round(distance)} m from the centre of ${settings.zone_label}, which is ${overBy} m beyond the ${settings.zone_radius_m} m limit.`,
        detail: {
          Zone: settings.zone_label,
          "Zone radius": `${settings.zone_radius_m} m`,
          "Distance from zone": `${Math.round(distance)} m`,
          "Outside by": `${overBy} m`,
          Address: status.address ?? "Unavailable",
          Coordinates: `${status.latitude?.toFixed(6)}, ${status.longitude?.toFixed(6)}`,
          "Location source": status.location_source ?? "NONE",
        },
      });
    }
  }

  if (settings.heart_rate_enabled && status.heart_rate !== null) {
    if (status.heart_rate > settings.max_heart_rate) {
      const overBy = status.heart_rate - settings.max_heart_rate;
      events.push({
        kind: "heart_rate_high",
        severity: "warning",
        subject: `Heart rate warning: ${status.heart_rate} bpm exceeds ${settings.max_heart_rate} bpm`,
        headline: "Heart rate above the caregiver limit",
        message: `The wearable reported ${status.heart_rate} bpm, which is ${overBy} bpm above the configured limit of ${settings.max_heart_rate} bpm.`,
        detail: {
          "Heart rate": `${status.heart_rate} bpm`,
          "Configured limit": `${settings.max_heart_rate} bpm`,
          "Above limit by": `${overBy} bpm`,
          Address: status.address ?? "Unavailable",
          Coordinates:
            status.latitude === null || status.longitude === null
              ? "Unavailable"
              : `${status.latitude.toFixed(6)}, ${status.longitude.toFixed(6)}`,
        },
      });
    }
  }

  return events;
}

/** Builds the informational "everything is safe again" event. */
export function buildRecoveryEvent(status: DeviceStatus, settings: AlertSettings): AlertEvent {
  const distance = zoneDistance(status, settings);
  return {
    kind: "recovery",
    severity: "info",
    subject: "SereniSound: PWD is back inside the safety zone",
    headline: "Back to a safe state",
    message: "The wearable is reporting normal readings again, so the previous warning is cleared.",
    detail: {
      Zone: settings.zone_label,
      "Distance from zone": distance === null ? "Unavailable" : `${Math.round(distance)} m`,
      "Heart rate": status.heart_rate === null ? "Unavailable" : `${status.heart_rate} bpm`,
      "Configured limit": `${settings.max_heart_rate} bpm`,
      Address: status.address ?? "Unavailable",
    },
  };
}

/* ------------------------------------------------------------------ */
/* Email delivery (Brevo SMTP)                                         */
/* ------------------------------------------------------------------ */

export type EmailResult = { status: "sent" | "failed" | "skipped"; error: string | null };

function getTransport(): { transport: Transporter | null; error: string | null } {
  const user = process.env.BREVO_SMTP_USER;
  const pass = process.env.BREVO_SMTP_KEY;
  if (!user || !pass) {
    return { transport: null, error: "Missing BREVO_SMTP_USER or BREVO_SMTP_KEY" };
  }
  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host: BREVO_SMTP_HOST,
      port: BREVO_SMTP_PORT,
      secure: BREVO_SMTP_PORT === 465,
      requireTLS: BREVO_SMTP_PORT === 587,
      auth: { user, pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return { transport: cachedTransport, error: null };
}

function formatSingaporeTime(date: Date) {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

export function renderAlertEmail(event: AlertEvent, options: { deviceId: string; isTest: boolean }) {
  const accent = event.severity === "warning" ? "#c45158" : "#138c86";
  const rows = Object.entries(event.detail)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 14px 6px 0;color:#6b7a86;font-size:13px;">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;color:#1d2935;font-size:13px;font-weight:600;">${escapeHtml(String(value ?? "—"))}</td></tr>`,
    )
    .join("");
  const testBanner = options.isTest
    ? `<p style="margin:0 0 16px;padding:10px 12px;background:#fff1dd;color:#8a5a12;border-radius:6px;font-size:12px;">DEMO / TEST MESSAGE — triggered from the caregiver dashboard testing panel, not by the wearable.</p>`
    : "";
  const html = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;background:#f5f7f8;padding:24px;">
  <div style="max-width:560px;margin:auto;background:#ffffff;border:1px solid #e4e9ed;border-radius:12px;overflow:hidden;">
    <div style="padding:20px 24px;border-bottom:3px solid ${accent};">
      <p style="margin:0 0 6px;font-size:10px;letter-spacing:.14em;color:#83919b;">SERENISOUND CAREGIVER MONITOR</p>
      <h1 style="margin:0;font-size:19px;color:${accent};">${escapeHtml(event.headline)}</h1>
    </div>
    <div style="padding:20px 24px;">
      ${testBanner}
      <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:#1d2935;">${escapeHtml(event.message)}</p>
      <table style="border-collapse:collapse;width:100%;">${rows}
        <tr><td style="padding:6px 14px 6px 0;color:#6b7a86;font-size:13px;">Device</td><td style="padding:6px 0;color:#1d2935;font-size:13px;font-weight:600;">${escapeHtml(options.deviceId)}</td></tr>
        <tr><td style="padding:6px 14px 6px 0;color:#6b7a86;font-size:13px;">Sent at</td><td style="padding:6px 0;color:#1d2935;font-size:13px;font-weight:600;">${escapeHtml(formatSingaporeTime(new Date()))} (SGT)</td></tr>
      </table>
      <p style="margin:20px 0 0;font-size:11px;color:#98a4aa;">Prototype alerting. This message is informational and is not a medical diagnosis.</p>
    </div>
  </div>
</div>`;
  const text = [
    `${event.headline} (${options.isTest ? "demo/test" : "automatic alert"})`,
    "",
    event.message,
    "",
    ...Object.entries(event.detail).map(([label, value]) => `${label}: ${value ?? "—"}`),
    `Device: ${options.deviceId}`,
    `Sent at: ${formatSingaporeTime(new Date())} (SGT)`,
  ].join("\n");
  return { subject: options.isTest ? `[DEMO] ${event.subject}` : event.subject, html, text };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Turns Brevo's terse failures into something a caregiver can act on. */
export function explainEmailError(message: string) {
  const raw = message.slice(0, 200);
  if (/525|unauthori[sz]ed ip/i.test(message)) {
    return `${raw} — the Brevo account only accepts SMTP from authorised IP addresses, which serverless hosts cannot provide. Set BREVO_API_KEY to send over the HTTPS API instead.`;
  }
  if (/535|invalid login|authentication failed/i.test(message)) {
    return `${raw} — Brevo rejected the SMTP login/key pair. The login is not always the sign-in address (Brevo shows it on the SMTP panel), or the account may restrict authorised IPs. Setting BREVO_API_KEY avoids both.`;
  }
  if (/401|key not found|unauthorized/i.test(message)) {
    return `${raw} — Brevo did not recognise this API key. API keys start with xkeysib-; keys from the SMTP tab (xsmtpsib-) are not API keys.`;
  }
  if (/sender|not verified|unrecogni[sz]ed|forbidden/i.test(message)) {
    return `${raw} — ALERT_FROM_EMAIL must be a sender address verified in Brevo.`;
  }
  return raw;
}

function alertHeaders(event: AlertEvent) {
  return {
    "X-SereniSound-Alert": event.kind,
    ...(event.severity === "warning" ? { "X-Priority": "1", Importance: "high" } : {}),
  };
}

/**
 * Preferred delivery path when a Brevo API key is present: one credential, no
 * SMTP handshake, and a readable error body. SMTP remains the fallback.
 */
async function sendViaBrevoApi(options: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}): Promise<EmailResult> {
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": options.apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: options.from, name: "SereniSound Alerts" },
        to: [{ email: options.to }],
        subject: options.subject,
        htmlContent: options.html,
        textContent: options.text,
        headers: options.headers,
      }),
    });
    if (response.ok) return { status: "sent", error: null };
    const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    const detail = body?.message || body?.error || `HTTP ${response.status}`;
    console.error("Brevo API delivery failed", response.status, detail);
    return { status: "failed", error: explainEmailError(`Brevo API ${response.status}: ${detail}`).slice(0, 400) };
  } catch (sendError) {
    const message = sendError instanceof Error ? sendError.message : String(sendError);
    console.error("Brevo API request failed", sendError);
    return { status: "failed", error: message.slice(0, 300) };
  }
}

export async function sendAlertEmail(
  event: AlertEvent,
  options: { to: string; deviceId: string; isTest: boolean },
): Promise<EmailResult> {
  const from = process.env.ALERT_FROM_EMAIL || process.env.BREVO_SMTP_USER || DEFAULT_ALERT_EMAIL;
  const { subject, html, text } = renderAlertEmail(event, {
    deviceId: options.deviceId,
    isTest: options.isTest,
  });
  const headers = alertHeaders(event);

  const apiKey = process.env.BREVO_API_KEY;
  if (apiKey) {
    // The two Brevo key types are easy to mix up and the wrong one only shows up
    // as "Key not found", so catch the obvious mix-up before spending a request.
    if (apiKey.startsWith("xsmtpsib-")) {
      const hint = "BREVO_API_KEY holds an SMTP key (xsmtpsib-). API keys come from Brevo > SMTP & API > API Keys and start with xkeysib-.";
      console.error(`Alert email not sent: ${hint}`);
      return { status: "failed", error: hint };
    }
    return sendViaBrevoApi({ apiKey, from, to: options.to, subject, html, text, headers });
  }

  const { transport, error } = getTransport();
  if (!transport) {
    console.error(`Alert email not sent: ${error}`);
    return { status: "skipped", error };
  }
  try {
    await transport.sendMail({
      from: `SereniSound Alerts <${from}>`,
      to: options.to,
      subject,
      text,
      html,
      headers,
    });
    return { status: "sent", error: null };
  } catch (sendError) {
    const message = sendError instanceof Error ? sendError.message : String(sendError);
    console.error("Alert email delivery failed", sendError);
    return { status: "failed", error: explainEmailError(message).slice(0, 400) };
  }
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

export async function loadAlertSettings(deviceId: string): Promise<AlertSettings> {
  const supabase = getSupabaseServer();
  const { data, error } = await supabase
    .from("device_alert_settings")
    .select("*")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) throw new Error(`Unable to read alert settings: ${error.message}`);
  if (!data) return { device_id: deviceId, ...DEFAULT_ALERT_SETTINGS };
  return data as AlertSettings;
}

export async function loadRecentAlerts(deviceId: string, limit = ROUND_TRIP_LIMIT) {
  const supabase = getSupabaseServer();
  const { data, error } = await supabase
    .from("device_alerts")
    .select("*")
    .eq("device_id", deviceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Unable to read alert history: ${error.message}`);
  return data ?? [];
}

/**
 * Records the alert and emails the caregiver. Automatic alerts respect the
 * per-kind cooldown; demo alerts from the testing panel always send.
 */
export async function dispatchAlert(options: {
  deviceId: string;
  settings: AlertSettings;
  event: AlertEvent;
  isTest: boolean;
}): Promise<{ record: unknown; email: EmailResult; throttled: boolean }> {
  const { deviceId, settings, event, isTest } = options;
  const supabase = getSupabaseServer();

  // Recovery notices are logged for the dashboard timeline but never emailed.
  const shouldEmail = settings.alerts_enabled && event.kind !== "recovery" &&
    (options.isTest || !isWithinCooldown(settings, event.kind));

  const email: EmailResult = shouldEmail
    ? await sendAlertEmail(event, { to: settings.alert_email, deviceId, isTest })
    : {
        status: "skipped",
        error: event.kind === "recovery"
          ? "Recovery notice is dashboard-only"
          : "Suppressed: alerts disabled or cooldown active",
      };

  const { data, error } = await supabase
    .from("device_alerts")
    .insert({
      device_id: deviceId,
      kind: event.kind,
      message: event.message,
      detail: event.detail,
      email_to: settings.alert_email,
      email_status: email.status,
      email_error: email.error,
      is_test: isTest,
    })
    .select("*")
    .single();
  if (error) console.error("Unable to record alert", error);

  if (shouldEmail) {
    const column = event.kind === "geofence_exit"
      ? "last_geofence_alert_at"
      : event.kind === "heart_rate_high"
        ? "last_heart_rate_alert_at"
        : null;
    if (column) {
      const { error: stampError } = await supabase
        .from("device_alert_settings")
        .update({ [column]: new Date().toISOString() })
        .eq("device_id", deviceId);
      if (stampError) console.error("Unable to stamp alert cooldown", stampError);
    }
  }

  return { record: data ?? null, email, throttled: !shouldEmail && isWithinCooldown(settings, event.kind) };
}

function isWithinCooldown(settings: AlertSettings, kind: AlertKind) {
  const stamp = kind === "geofence_exit"
    ? settings.last_geofence_alert_at
    : kind === "heart_rate_high"
      ? settings.last_heart_rate_alert_at
      : null;
  if (!stamp) return false;
  return Date.now() - new Date(stamp).getTime() < ALERT_COOLDOWN_MS;
}

export async function clearAlertCooldowns(deviceId: string) {
  const supabase = getSupabaseServer();
  const { error } = await supabase
    .from("device_alert_settings")
    .update({ last_geofence_alert_at: null, last_heart_rate_alert_at: null })
    .eq("device_id", deviceId);
  if (error) console.error("Unable to clear alert cooldowns", error);
}

/**
 * Runs on every wearable upload. Never throws: a mail or database problem must
 * not stop the ESP32 from recording its state.
 */
export async function runAutomaticAlertChecks(
  status: DeviceStatus,
): Promise<{ sent: number; events: AlertEvent[]; error: string | null }> {
  try {
    const settings = await loadAlertSettings(status.device_id);
    if (!settings.alerts_enabled || !status.device_powered_on) {
      return { sent: 0, events: [], error: null };
    }
    const events = evaluateTelemetry(status, settings);
    let sent = 0;
    for (const event of events) {
      const result = await dispatchAlert({ deviceId: status.device_id, settings, event, isTest: false });
      if (result.email.status === "sent") sent += 1;
    }
    return { sent, events, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Automatic alert checks failed", error);
    return { sent: 0, events: [], error: message };
  }
}
