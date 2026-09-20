import { NextResponse } from "next/server";
import { isSameOrigin } from "../../../../lib/api-origin";
import { getSupabaseServer } from "../../../../lib/supabase-server";

export const runtime = "nodejs";

const DEVICE_ID = "pwd-001";
const COMMANDS = ["play_pause", "next_track", "previous_track", "play_track"] as const;
type CommandType = (typeof COMMANDS)[number];

function isCommand(value: unknown): value is CommandType {
  return typeof value === "string" && COMMANDS.includes(value as CommandType);
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  try {
    const body = await request.json() as { device_id?: unknown; command?: unknown; track?: unknown };
    if (body.device_id !== DEVICE_ID || !isCommand(body.command)) {
      return NextResponse.json({ error: "Invalid command" }, { status: 400 });
    }

    const track = body.track === undefined ? null : body.track;
    if (track !== null && (typeof track !== "number" || !Number.isInteger(track) || track < 1 || track > 10000)) {
      return NextResponse.json({ error: "Invalid track" }, { status: 400 });
    }
    if (body.command === "play_track" && track === null) {
      return NextResponse.json({ error: "A track is required" }, { status: 400 });
    }

    const supabase = getSupabaseServer();
    const { data, error } = await supabase
      .from("device_commands")
      .insert({ device_id: DEVICE_ID, command: body.command, track })
      .select("id")
      .single();

    if (error) {
      console.error("Supabase command insert failed", error);
      return NextResponse.json({ error: "Unable to queue command" }, { status: 500 });
    }

    return NextResponse.json({ success: true, command_id: data.id });
  } catch (error) {
    console.error("Command request failed", error);
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }
}

export async function GET(request: Request) {
  const expectedToken = process.env.DEVICE_UPDATE_TOKEN;
  const providedToken = request.headers.get("x-device-token");
  if (!expectedToken || !providedToken || providedToken !== expectedToken) {
    return NextResponse.json({ error: "Unauthorized device" }, { status: 401 });
  }

  const supabase = getSupabaseServer();
  const { data: command, error: readError } = await supabase
    .from("device_commands")
    .select("id, command, track")
    .eq("device_id", DEVICE_ID)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (readError) {
    console.error("Supabase command read failed", readError);
    return NextResponse.json({ error: "Unable to read commands" }, { status: 500 });
  }
  if (!command) return NextResponse.json({ command: null }, { headers: { "Cache-Control": "no-store" } });

  const { error: claimError } = await supabase
    .from("device_commands")
    .update({ status: "delivered", delivered_at: new Date().toISOString() })
    .eq("id", command.id)
    .eq("status", "pending");

  if (claimError) {
    console.error("Supabase command claim failed", claimError);
    return NextResponse.json({ error: "Unable to claim command" }, { status: 500 });
  }

  return NextResponse.json({ command }, { headers: { "Cache-Control": "no-store" } });
}
