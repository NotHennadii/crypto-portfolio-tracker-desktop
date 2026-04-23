import crypto from "node:crypto";
import { getSupabaseServerClient } from "./supabase-server";

export type PersistentApiCredentials = {
  bingxApiKey?: string;
  bingxApiSecret?: string;
  bitgetApiKey?: string;
  bitgetApiSecret?: string;
  bitgetPassphrase?: string;
  binanceApiKey?: string;
  binanceApiSecret?: string;
  bybitApiKey?: string;
  bybitApiSecret?: string;
  mexcApiKey?: string;
  mexcApiSecret?: string;
  gateApiKey?: string;
  gateApiSecret?: string;
};

type CredentialsRow = {
  user_id: string;
  encrypted_payload: string;
  updated_at: string;
};

const TABLE_NAME = "user_api_credentials";

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function getEncryptionKey(): Buffer {
  const source = process.env.BINGX_SESSION_SECRET ?? process.env.BINGX_API_SECRET;
  if (!source) {
    throw new Error("Missing encryption secret. Set BINGX_SESSION_SECRET.");
  }
  return crypto.createHash("sha256").update(source).digest();
}

function encryptPayload(payload: PersistentApiCredentials): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${toBase64Url(iv)}.${toBase64Url(tag)}.${toBase64Url(encrypted)}`;
}

function decryptPayload(value: string): PersistentApiCredentials | null {
  const [ivRaw, tagRaw, dataRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !dataRaw) return null;
  try {
    const iv = fromBase64Url(ivRaw);
    const tag = fromBase64Url(tagRaw);
    const encrypted = fromBase64Url(dataRaw);
    const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return JSON.parse(decrypted) as PersistentApiCredentials;
  } catch {
    return null;
  }
}

export async function readPersistentCredentials(userId: string): Promise<PersistentApiCredentials | null> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select("encrypted_payload")
    .eq("user_id", userId)
    .maybeSingle<{ encrypted_payload: string }>();
  if (error || !data?.encrypted_payload) {
    return null;
  }
  return decryptPayload(data.encrypted_payload);
}

export async function savePersistentCredentials(userId: string, credentials: PersistentApiCredentials): Promise<void> {
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.from(TABLE_NAME).upsert({
    user_id: userId,
    encrypted_payload: encryptPayload(credentials),
    updated_at: new Date().toISOString(),
  } satisfies CredentialsRow);
  if (error) {
    throw new Error(`Failed to persist API credentials: ${error.message}`);
  }
}

export async function clearPersistentCredentials(userId: string): Promise<void> {
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.from(TABLE_NAME).delete().eq("user_id", userId);
  if (error) {
    throw new Error(`Failed to clear API credentials: ${error.message}`);
  }
}

