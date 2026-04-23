import { getSupabaseServerClient } from "./supabase-server";
import { hasSupabaseEnv } from "./supabase-env";

const TABLE_NAME = "user_dashboard_settings";
const fallbackBaseEquity = new Map<string, number | null>();

type SettingsRow = {
  user_id: string;
  base_equity_usd: number | null;
  updated_at: string;
};

export type SaveBaseEquityResult = {
  persisted: boolean;
  warning?: string;
};

export async function readBaseEquityUsd(userId: string): Promise<number | null> {
  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("base_equity_usd")
      .eq("user_id", userId)
      .maybeSingle<{ base_equity_usd: number | null }>();
    if (error) {
      return fallbackBaseEquity.get(userId) ?? null;
    }
    const value = data?.base_equity_usd ?? null;
    fallbackBaseEquity.set(userId, value);
    return value;
  } catch {
    return fallbackBaseEquity.get(userId) ?? null;
  }
}

export async function saveBaseEquityUsd(userId: string, value: number | null): Promise<SaveBaseEquityResult> {
  fallbackBaseEquity.set(userId, value);
  if (!hasSupabaseEnv()) {
    return {
      persisted: false,
      warning: "Supabase is not configured; setting is stored only in runtime memory for this server process.",
    };
  }

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.from(TABLE_NAME).upsert({
    user_id: userId,
    base_equity_usd: value,
    updated_at: new Date().toISOString(),
  } satisfies SettingsRow);
  if (error) {
    throw new Error(`Failed to save dashboard settings: ${error.message}`);
  }
  return { persisted: true };
}

