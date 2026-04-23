const missingEnvMessage =
  "Supabase env is missing. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.";

export function hasSupabaseEnv(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

function parseOptionalBoolean(value: string | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

export function isGuestModeEnabled(): boolean {
  if (hasSupabaseEnv()) return false;
  const explicit =
    parseOptionalBoolean(process.env.ALLOW_GUEST_MODE) ??
    parseOptionalBoolean(process.env.NEXT_PUBLIC_ALLOW_GUEST_MODE);
  if (explicit != null) {
    return explicit;
  }
  return process.env.NODE_ENV !== "production";
}

export function getSupabaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!value) {
    throw new Error(missingEnvMessage);
  }
  return value;
}

export function getSupabaseAnonKey(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!value) {
    throw new Error(missingEnvMessage);
  }
  return value;
}
