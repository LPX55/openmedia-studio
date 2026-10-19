import { NextRequest, NextResponse } from "next/server";
// Phase 3 (C7a): thin wrapper over `provider_configs` — the db helpers below
// read/write the unified provider store, never the legacy `settings` rows.
import {
  getKieApiToken,
  setKieApiToken,
  deleteKieApiToken,
} from "@/lib/guest/db";

export async function GET() {
  return NextResponse.json({ hasToken: !!getKieApiToken() });
}

export async function POST(req: NextRequest) {
  const { kieApiToken } = await req.json();
  if (typeof kieApiToken !== "string" || !kieApiToken.trim()) {
    return NextResponse.json({ error: "kieApiToken is required" }, { status: 400 });
  }
  setKieApiToken(kieApiToken.trim());
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  deleteKieApiToken();
  return NextResponse.json({ ok: true });
}
