import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_ARTWORK_BYTES = 20 * 1024 * 1024;
export const ARTWORK_TOKEN_TTL_MS = 30 * 60 * 1000;

export const ARTWORK_PLACEMENTS = {
  chest_left: "Left chest",
  chest_right: "Right chest",
  front: "Full front",
  back: "Full back",
};

const EXTENSIONS_BY_MIME = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
};

function signingSecret() {
  const secret = process.env.SHOPIFY_API_SECRET || "";
  if (!secret) throw new Error("SHOPIFY_API_SECRET is not configured.");
  return secret;
}

function normalizeFilename(value) {
  const filename = String(value || "").trim();
  if (!filename || filename.length > 180) throw new Error("Artwork filename is invalid.");
  if (/[\\/\u0000-\u001f]/.test(filename)) throw new Error("Artwork filename is invalid.");
  return filename;
}

export function validateArtworkMetadata(input) {
  const key = String(input?.key || "").trim();
  const label = ARTWORK_PLACEMENTS[key];
  if (!label) throw new Error("Artwork placement is invalid.");

  const filename = normalizeFilename(input?.filename);
  const mimeType = String(input?.mimeType || "").trim().toLowerCase();
  const allowedExtensions = EXTENSIONS_BY_MIME[mimeType];
  if (!allowedExtensions) throw new Error(`${label} artwork must be PNG, JPG/JPEG, or WebP.`);

  const lowerName = filename.toLowerCase();
  if (!allowedExtensions.some((extension) => lowerName.endsWith(extension))) {
    throw new Error(`${label} artwork filename does not match its file type.`);
  }

  const size = Number(input?.size);
  if (!Number.isInteger(size) || size < 1) throw new Error(`${label} artwork file size is invalid.`);
  if (size > MAX_ARTWORK_BYTES) throw new Error(`${label} artwork must be 20 MB or smaller.`);

  return { key, label, filename, mimeType, size };
}

function signatureFor(encodedPayload) {
  return createHmac("sha256", signingSecret()).update(encodedPayload).digest("base64url");
}

export function createArtworkToken(metadata, resourceUrl) {
  const safeMetadata = validateArtworkMetadata(metadata);
  const safeResourceUrl = String(resourceUrl || "").trim();
  if (!safeResourceUrl.startsWith("https://")) throw new Error("Shopify did not return a secure artwork resource URL.");

  const payload = {
    v: 1,
    ...safeMetadata,
    resourceUrl: safeResourceUrl,
    exp: Date.now() + ARTWORK_TOKEN_TTL_MS,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signatureFor(encodedPayload)}`;
}

export function verifyArtworkToken(token, expectedKey = "") {
  const raw = String(token || "");
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Artwork upload receipt is invalid.");

  const [encodedPayload, suppliedSignature] = parts;
  const expectedSignature = signatureFor(encodedPayload);
  const suppliedBuffer = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw new Error("Artwork upload receipt is invalid.");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Artwork upload receipt is invalid.");
  }

  if (payload?.v !== 1 || !Number.isFinite(payload?.exp) || payload.exp < Date.now()) {
    throw new Error("Artwork upload receipt has expired. Please select the artwork again.");
  }

  const metadata = validateArtworkMetadata(payload);
  if (expectedKey && metadata.key !== expectedKey) throw new Error("Artwork upload receipt does not match the selected print location.");

  const resourceUrl = String(payload?.resourceUrl || "").trim();
  if (!resourceUrl.startsWith("https://")) throw new Error("Artwork upload receipt is invalid.");

  return { ...metadata, resourceUrl, exp: payload.exp };
}
