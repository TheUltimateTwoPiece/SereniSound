import { NextResponse } from "next/server";
import { isSameOrigin } from "../../../../lib/api-origin";
import { loadAlertSettings, loadRecentAlerts } from "../../../../lib/alerts";
import { getSupabaseServer } from "../../../../lib/supabase-server";
import type { AlertSettings } from "../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEVICE_ID = "pwd-001";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isCoordinate(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function validate(body: any): { value?: Omit<AlertSettings, "device_id" | "last_geofence_alert_at" | "last_heart_rate_alert_at" | "updated_at">; error?: string } {
  if (!body || typeof body !== "object") return { error: "Invalid settings payload" };

  const alertEmail = typeof body.alert_email === "string" ? body.alert_email.trim() : "";
  if (!EMAIL_PATTERN.test(alertEmail) || alertEmail.length > 200) {
    return { error: "Enter a valid warning email address" };
  }

  const zoneLabel = typeof body.zone_label === "string" ? body.zone_label.trim().slice(0, 60) : "";
  if (zoneLabel.length < 1) return { error: "Give the zone a short name" };

  if (!isIntegerInRange(body.zone_radius_m, 25, 50000)) {
    return { error: "Zone radius must be between 25 m and 50 km" };
  }
  if (!isIntegerInRange(body.max_heart_rate, 40, 250)) {
    return { error: "Heart-rate limit must be between 40 and 250 bpm" };
  }
  if (![body.alerts_enabled, body.geofence_enabled, body.heart_rate_enabled].every(isBoolean)) {
    return { error: "Invalid alert toggles" };
  }

  const hasLatitude = body.zone_latitude !== null && body.zone_latitude !== undefined;
  const hasLongitude = body.zone_longitude !== null && body.zone_longitude !== undefined;
  if (hasLatitude !== hasLongitude) {
    return { error: "A zone needs both a latitude and a longitude" };
  }
  if (hasLatitude && hasLongitude) {
    if (!isCoordinate(body.zone_latitude, 90) || !isCoordinate(body.zone_longitude, 180)) {
      return { error: "Zone coordinates are outside the valid range" };
    }
  }
  if (body.geofence_enabled && !hasLatitude) {
    return { error: "Set the zone centre before switching zone warnings on" };
  }

  return {
    value: {
      alerts_enabled: body.alerts_enabled,
      alert_email: alertEmail,
      geofence_enabled: body.geofence_enabled,
      zone_label: zoneLabel,
      zone_latitude: hasLatitude ? body.zone_latitude : null,
      zone_longitude: hasLongitude ? body.zone_longitude : null,
      zone_radius_m: body.zone_radius_m,
      heart_rate_enabled: body.heart_rate_enabled,
      max_heart_rate: body.max_heart_rate,
    },
  };
}

export async function GET() {
  try {
    const [settings, history] = await Promise.all([
      loadAlertSettings(DEVICE_ID),
      loadRecentAlerts(DEVICE_ID),
    ]);
    return NextResponse.json({ settings, history }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Unable to load alert settings", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load alert settings" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { value, error } = validate(body);
    if (!value) return NextResponse.json({ error }, { status: 400 });

    const supabase = getSupabaseServer();
    const { data, error: saveError } = await supabase
      .from("device_alert_settings")
      .upsert(
        { device_id: DEVICE_ID, ...value, updated_at: new Date().toISOString() },
        { onConflict: "device_id" },
      )
      .select("*")
      .single();

    if (saveError) {
      console.error("Unable to save alert settings", saveError);
      return NextResponse.json({ error: "Unable to save alert settings" }, { status: 500 });
    }

    return NextResponse.json({ success: true, settings: data });
  } catch (error) {
    console.error("Alert settings request failed", error);
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }
}
