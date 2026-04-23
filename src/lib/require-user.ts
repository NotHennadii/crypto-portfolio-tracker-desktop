import { NextResponse } from "next/server";
import { getAuthenticatedUserId } from "./supabase-server";
import { hasSupabaseEnv, isGuestModeEnabled } from "./supabase-env";

const GUEST_USER_ID = "guest-local-user";

export async function requireUserId():
  Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse<{ ok: false; error: string }> }> {
  if (!hasSupabaseEnv() && isGuestModeEnabled()) {
    return { ok: true, userId: GUEST_USER_ID };
  }
  if (!hasSupabaseEnv()) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Authentication is not configured. Set Supabase env or enable guest mode." },
        { status: 503 }
      ),
    };
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return { ok: false, response: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }) };
  }
  return { ok: true, userId };
}
