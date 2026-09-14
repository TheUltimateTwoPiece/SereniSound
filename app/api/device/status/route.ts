import { NextResponse } from "next/server";
import { getSupabaseServer } from "../../../../lib/supabase-server";

export const runtime = "nodejs";

export async function GET() {
  const supabaseServer = getSupabaseServer();
  const { data, error } = await supabaseServer
    .from("device_status")
    .select("*")
    .eq("device_id", "pwd-001")
    .maybeSingle();

  if (error) {
    console.error("Supabase device status read failed", error);
    return NextResponse.json({ error: "Unable to read device state" }, { status: 500 });
  }

  return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
}
