import { NextResponse } from "next/server";
import { isSameOrigin } from "../../../../lib/api-origin";
import {
  buildRecoveryEvent,
  clearAlertCooldowns,
  dispatchAlert,
  evaluateTelemetry,
  loadAlertSettings,
  loadRecentAlerts,
} from "../../../../lib/alerts";
import { getSupabaseServer } from "../../../../lib/supabase-server";
import type { AlertEvent, AlertSettings, DeviceStatus } from "../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEVICE_ID = "pwd-001";
const FALLBACK_CENTRE = { latitude: 1.3521, longitude: 103.8198 };

const SCENARIOS = ["zone_exit", "heart_rate", "safe_return", "test_email", "clear_history"] as const;
type Scenario = (typeof SCENARIOS)[number];

function isScenario(value: unknown): value is Scenario {
  return typeof value === "string" && SCENARIOS.includes(value as Scenario);
}

async function loadStatus(): Promise<DeviceStatus> {
  const supabase = getSupabaseServer();
  const { data, error } = await supabase
    .from("device_status")
    .select("*")
    .eq("device_id", DEVICE_ID)
    .maybeSingle();
  if (error) throw new Error(`Unable to read device state: ${error.message}`);
  return (data ?? {
    device_id: DEVICE_ID,
    latitude: null,
    longitude: null,
    address: null,
    location_source: "NONE",
    location_accuracy: null,
    current_track: 0,
    total_tracks: 0,
    is_playing: false,
    volume: 0,
    heart_rate: null,
    device_powered_on: true,
    updated_at: new Date().toISOString(),
  }) as DeviceStatus;
}

function offsetPoint(centre: { latitude: number; longitude: number }, meters: number) {
  const latitude = centre.latitude + meters / 111320;
  const longitude = centre.longitude + (meters * 0.45) / (111320 * Math.cos((centre.latitude * Math.PI) / 180));
  return { latitude, longitude };
}

/**
 * The demo panel runs the very same detection code the wearable traffic does,
 * but against invented readings so a caregiver can see the full flow on demand.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  try {
    const body = await request.json() as { scenario?: unknown };
    if (!isScenario(body.scenario)) {
      return NextResponse.json({ error: "Unknown demo scenario" }, { status: 400 });
    }
    const scenario = body.scenario;

    const settings = await loadAlertSettings(DEVICE_ID);
    const status = await loadStatus();

    if (scenario === "test_email") {
      const event: AlertEvent = {
        kind: "test",
        severity: "info",
        subject: "SereniSound warning email test",
        headline: "Email delivery is working",
        message:
          "This is a delivery test for the caregiver warning email. If you can read this, urgent zone and heart-rate warnings will reach this inbox.",
        detail: {
          "Warning email": settings.alert_email,
          "Zone warnings": settings.geofence_enabled
            ? `On · ${settings.zone_label} · ${settings.zone_radius_m} m`
            : "Off",
          "Heart-rate warnings": settings.heart_rate_enabled
            ? `On · above ${settings.max_heart_rate} bpm`
            : "Off",
        },
      };
      const result = await dispatchAlert({ deviceId: DEVICE_ID, settings, event, isTest: true });
      return NextResponse.json({
        scenario,
        message: `Test email dispatched to ${settings.alert_email}.`,
        email: result.email,
        history: await loadRecentAlerts(DEVICE_ID),
      });
    }

    if (scenario === "clear_history") {
      const supabase = getSupabaseServer();
      const { error } = await supabase.from("device_alerts").delete().eq("device_id", DEVICE_ID);
      if (error) {
        return NextResponse.json({ error: "Unable to clear alert history" }, { status: 500 });
      }
      await clearAlertCooldowns(DEVICE_ID);
      return NextResponse.json({
        scenario,
        message: "Alert history and warning cooldowns cleared.",
        email: { status: "skipped", error: null },
        history: await loadRecentAlerts(DEVICE_ID),
      });
    }

    if (scenario === "safe_return") {
      const recovery = buildRecoveryEvent(status, settings);
      await clearAlertCooldowns(DEVICE_ID);
      const result = await dispatchAlert({ deviceId: DEVICE_ID, settings, event: recovery, isTest: false });
      return NextResponse.json({
        scenario,
        message: "Safe state restored: warning cooldowns cleared (recovery notices are dashboard-only).",
        email: result.email,
        history: await loadRecentAlerts(DEVICE_ID),
      });
    }

    // Zone and heart-rate demos force their warnings on so the flow can be shown
    // even before the caregiver has switched that check on for real.
    const demoSettings: AlertSettings = { ...settings, alerts_enabled: true };
    let event: AlertEvent | undefined;
    let note = "";

    if (scenario === "zone_exit") {
      const centre = settings.zone_latitude !== null && settings.zone_longitude !== null
        ? { latitude: settings.zone_latitude, longitude: settings.zone_longitude }
        : status.latitude !== null && status.longitude !== null
          ? { latitude: status.latitude, longitude: status.longitude }
          : FALLBACK_CENTRE;
      const radius = settings.zone_radius_m || 200;
      const centreIsLive = !(settings.zone_latitude === null || settings.zone_longitude === null);
      const position = offsetPoint(centre, radius * 1.8);
      demoSettings.geofence_enabled = true;
      const [detected] = evaluateTelemetry(
        {
          ...status,
          latitude: position.latitude,
          longitude: position.longitude,
          location_source: "GPS",
          address: "Simulated demo position",
        },
        demoSettings,
      );
      event = detected;
      note = centreIsLive
        ? `Simulated a position about ${Math.round(radius * 1.8)} m from the centre of ${settings.zone_label}.`
        : "No zone was configured, so the demo centred a temporary zone on the wearable's last known position.";
    }

    if (scenario === "heart_rate") {
      const simulatedRate = Math.min(230, settings.max_heart_rate + 25);
      demoSettings.heart_rate_enabled = true;
      const [detected] = evaluateTelemetry(
        { ...status, heart_rate: simulatedRate, address: status.address ?? "Simulated demo reading" },
        demoSettings,
      );
      event = detected;
      note = `Simulated a heart rate of ${simulatedRate} bpm against the ${settings.max_heart_rate} bpm limit.`;
    }

    if (!event) {
      return NextResponse.json({ error: "The demo scenario did not produce a warning" }, { status: 400 });
    }

    const result = await dispatchAlert({
      deviceId: DEVICE_ID,
      settings: demoSettings,
      event,
      isTest: true,
    });

    return NextResponse.json({
      scenario,
      message: note,
      email: result.email,
      history: await loadRecentAlerts(DEVICE_ID),
    });
  } catch (error) {
    console.error("Alert demo request failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to run the demo" },
      { status: 500 },
    );
  }
}
