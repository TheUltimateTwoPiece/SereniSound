import { NextResponse, after } from "next/server";
import { runAutomaticAlertChecks } from "../../../../lib/alerts";
import { getSupabaseServer } from "../../../../lib/supabase-server";
import type { DeviceStatus } from "../../../../lib/types";

export const runtime = "nodejs";

const DEVICE_ID = "pwd-001";

type DevicePayload = {
  device_id: string;
  latitude: number | null;
  longitude: number | null;
  address?: string | null;
  location_source?: "GPS" | "WPS" | "NONE" | null;
  location_accuracy?: number | null;
  current_track: number;
  total_tracks: number;
  is_playing: boolean;
  volume: number;
  heart_rate: number | null;
  device_powered_on?: boolean;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validNullableNumber(value: unknown): value is number | null | undefined {
  return value === null || value === undefined || isFiniteNumber(value);
}

export async function POST(request: Request) {
  try {
    const expectedToken = process.env.DEVICE_UPDATE_TOKEN;
    const providedToken = request.headers.get("x-device-token");
    if (!expectedToken || !providedToken || providedToken !== expectedToken) {
      return NextResponse.json({ error: "Unauthorized device" }, { status: 401 });
    }

    const body = (await request.json()) as Partial<DevicePayload>;

    if (body.device_id !== DEVICE_ID) {
      return NextResponse.json({ error: "Unknown device_id" }, { status: 400 });
    }

    const hasCoordinates = body.latitude === null && body.longitude === null;
    const validCoordinates = hasCoordinates || (isFiniteNumber(body.latitude) && isFiniteNumber(body.longitude)
      && body.latitude >= -90 && body.latitude <= 90
      && body.longitude >= -180 && body.longitude <= 180);

    const currentTrack = body.current_track;
    const totalTracks = body.total_tracks;
    const deviceVolume = body.volume;
    if (!validCoordinates || !validNullableNumber(body.location_accuracy)
      || !validNullableNumber(body.heart_rate)
      || typeof currentTrack !== "number" || !Number.isInteger(currentTrack) || currentTrack < 0
      || typeof totalTracks !== "number" || !Number.isInteger(totalTracks) || totalTracks < 0
      || typeof deviceVolume !== "number" || !Number.isInteger(deviceVolume) || deviceVolume < 0 || deviceVolume > 30
      || typeof body.is_playing !== "boolean"
      || (body.device_powered_on !== undefined && typeof body.device_powered_on !== "boolean")) {
      return NextResponse.json({ error: "Invalid device payload" }, { status: 400 });
    }

    if (body.heart_rate !== null && body.heart_rate !== undefined && body.heart_rate < 0) {
      return NextResponse.json({ error: "Invalid heart_rate" }, { status: 400 });
    }

    const supabaseServer = getSupabaseServer();
    const { error } = await supabaseServer.from("device_status").upsert({
      device_id: DEVICE_ID,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      address: typeof body.address === "string" ? body.address.slice(0, 500) : null,
      location_source: body.location_source === "GPS" || body.location_source === "WPS" ? body.location_source : "NONE",
      location_accuracy: body.location_accuracy ?? null,
      current_track: currentTrack,
      total_tracks: totalTracks,
      is_playing: body.is_playing,
      volume: deviceVolume,
      heart_rate: body.heart_rate ?? null,
      device_powered_on: body.device_powered_on ?? true,
      updated_at: new Date().toISOString(),
    }, { onConflict: "device_id" });

    if (error) {
      console.error("Supabase device update failed", error);
      return NextResponse.json({ error: "Unable to save device state" }, { status: 500 });
    }

    // Safety-zone and heart-rate checks reply to the wearable first, then run, so
    // a slow mail server can never delay the device's five-second update loop.
    const savedStatus: DeviceStatus = {
      device_id: DEVICE_ID,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      address: typeof body.address === "string" ? body.address.slice(0, 500) : null,
      location_source: body.location_source === "GPS" || body.location_source === "WPS" ? body.location_source : "NONE",
      location_accuracy: body.location_accuracy ?? null,
      current_track: currentTrack,
      total_tracks: totalTracks,
      is_playing: body.is_playing,
      volume: deviceVolume,
      heart_rate: body.heart_rate ?? null,
      device_powered_on: body.device_powered_on ?? true,
      updated_at: new Date().toISOString(),
    };
    after(async () => {
      await runAutomaticAlertChecks(savedStatus);
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Device update request failed", error);
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }
}
