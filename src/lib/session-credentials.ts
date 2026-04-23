import crypto from "node:crypto";

const COOKIE_NAME = "bingx_session";
// Local dashboard convenience: keep encrypted API credentials for 30 days.
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

type SessionCredentials = {
  userId?: string;
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
  iat: number;
};

type CookieReader = {
  get(name: string): { value: string } | undefined;
};

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function getEncryptionKey(): Buffer {
  const source = process.env.BINGX_SESSION_SECRET ?? process.env.BINGX_API_SECRET;
  if (!source) {
    throw new Error("Missing session encryption secret. Set BINGX_SESSION_SECRET.");
  }
  return crypto.createHash("sha256").update(source).digest();
}

export function getCredentialCookieName(): string {
  return COOKIE_NAME;
}

export function getCredentialCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export function encodeCredentialCookie(credentials: {
  userId?: string;
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
}): string {
  const payload: SessionCredentials = {
    userId: credentials.userId?.trim(),
    bingxApiKey: credentials.bingxApiKey?.trim(),
    bingxApiSecret: credentials.bingxApiSecret?.trim(),
    bitgetApiKey: credentials.bitgetApiKey?.trim(),
    bitgetApiSecret: credentials.bitgetApiSecret?.trim(),
    bitgetPassphrase: credentials.bitgetPassphrase?.trim(),
    binanceApiKey: credentials.binanceApiKey?.trim(),
    binanceApiSecret: credentials.binanceApiSecret?.trim(),
    bybitApiKey: credentials.bybitApiKey?.trim(),
    bybitApiSecret: credentials.bybitApiSecret?.trim(),
    mexcApiKey: credentials.mexcApiKey?.trim(),
    mexcApiSecret: credentials.mexcApiSecret?.trim(),
    gateApiKey: credentials.gateApiKey?.trim(),
    gateApiSecret: credentials.gateApiSecret?.trim(),
    iat: Date.now(),
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${toBase64Url(iv)}.${toBase64Url(tag)}.${toBase64Url(encrypted)}`;
}

export function readCredentialCookie(cookieStore: CookieReader): {
  userId?: string;
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
} | null {
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  const [ivRaw, tagRaw, dataRaw] = raw.split(".");
  if (!ivRaw || !tagRaw || !dataRaw) return null;
  try {
    const iv = fromBase64Url(ivRaw);
    const tag = fromBase64Url(tagRaw);
    const encrypted = fromBase64Url(dataRaw);
    const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(decrypted) as SessionCredentials;
    if (
      !parsed.bingxApiKey &&
      !parsed.bingxApiSecret &&
      !parsed.bitgetApiKey &&
      !parsed.bitgetApiSecret &&
      !parsed.bitgetPassphrase &&
      !parsed.binanceApiKey &&
      !parsed.binanceApiSecret &&
      !parsed.bybitApiKey &&
      !parsed.bybitApiSecret &&
      !parsed.mexcApiKey &&
      !parsed.mexcApiSecret &&
      !parsed.gateApiKey &&
      !parsed.gateApiSecret
    ) {
      return null;
    }
    return {
      userId: parsed.userId,
      bingxApiKey: parsed.bingxApiKey,
      bingxApiSecret: parsed.bingxApiSecret,
      bitgetApiKey: parsed.bitgetApiKey,
      bitgetApiSecret: parsed.bitgetApiSecret,
      bitgetPassphrase: parsed.bitgetPassphrase,
      binanceApiKey: parsed.binanceApiKey,
      binanceApiSecret: parsed.binanceApiSecret,
      bybitApiKey: parsed.bybitApiKey,
      bybitApiSecret: parsed.bybitApiSecret,
      mexcApiKey: parsed.mexcApiKey,
      mexcApiSecret: parsed.mexcApiSecret,
      gateApiKey: parsed.gateApiKey,
      gateApiSecret: parsed.gateApiSecret,
    };
  } catch {
    return null;
  }
}
