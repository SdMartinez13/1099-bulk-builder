import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_ENGRAVING_ARTWORK_BYTES = 20 * 1024 * 1024;
export const ENGRAVING_ARTWORK_TOKEN_TTL_MS = 30 * 60 * 1000;

const FILE_TYPES = {
  ".svg": ["image/svg+xml", "text/xml", "application/xml", "application/octet-stream"],
  ".ai": ["application/postscript", "application/pdf", "application/octet-stream"],
  ".eps": ["application/postscript", "application/eps", "application/octet-stream"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".bmp": ["image/bmp", "image/x-ms-bmp", "application/octet-stream"],
  ".png": ["image/png"],
  ".heic": ["image/heic", "image/heif", "application/octet-stream"],
  ".tiff": ["image/tiff", "application/octet-stream"],
  ".tif": ["image/tiff", "application/octet-stream"],
  ".ppt": ["application/vnd.ms-powerpoint", "application/octet-stream"],
  ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/octet-stream"],
  ".doc": ["application/msword", "application/octet-stream"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream"],
  ".pdf": ["application/pdf"],
  ".psd": ["image/vnd.adobe.photoshop", "application/x-photoshop", "application/octet-stream"],
};

const DEFAULT_MIME_BY_EXTENSION = {
  ".svg": "image/svg+xml",
  ".ai": "application/postscript",
  ".eps": "application/postscript",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".bmp": "image/bmp",
  ".png": "image/png",
  ".heic": "image/heic",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
  ".psd": "image/vnd.adobe.photoshop",
};

export const ENGRAVING_ARTWORK_ACCEPT = Object.keys(FILE_TYPES).join(",");

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

function extensionFor(filename) {
  const index = filename.lastIndexOf(".");
  return index >= 0 ? filename.slice(index).toLowerCase() : "";
}

export function validateEngravingArtworkMetadata(input) {
  const filename = normalizeFilename(input?.filename);
  const extension = extensionFor(filename);
  const allowedMimeTypes = FILE_TYPES[extension];
  if (!allowedMimeTypes) {
    throw new Error("Artwork must be SVG, AI, EPS, JPG/JPEG, BMP, PNG, HEIC, TIFF/TIF, PPT/PPTX, DOC/DOCX, PDF, or PSD.");
  }

  const suppliedMimeType = String(input?.mimeType || "").trim().toLowerCase();
  const mimeType = allowedMimeTypes.includes(suppliedMimeType)
    ? suppliedMimeType
    : DEFAULT_MIME_BY_EXTENSION[extension];

  const size = Number(input?.size);
  if (!Number.isInteger(size) || size < 1) throw new Error("Artwork file size is invalid.");
  if (size > MAX_ENGRAVING_ARTWORK_BYTES) throw new Error("Artwork must be 20 MB or smaller.");

  const slot = Number(input?.slot || 1);
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) throw new Error("Artwork slot is invalid.");

  return { filename, extension, mimeType, size, slot };
}

function signatureFor(encodedPayload) {
  return createHmac("sha256", signingSecret()).update(encodedPayload).digest("base64url");
}

export function createEngravingArtworkToken(metadata, resourceUrl) {
  const safeMetadata = validateEngravingArtworkMetadata(metadata);
  const safeResourceUrl = String(resourceUrl || "").trim();
  if (!safeResourceUrl.startsWith("https://")) {
    throw new Error("Shopify did not return a secure artwork resource URL.");
  }

  const payload = {
    v: 1,
    ...safeMetadata,
    resourceUrl: safeResourceUrl,
    exp: Date.now() + ENGRAVING_ARTWORK_TOKEN_TTL_MS,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signatureFor(encodedPayload)}`;
}

export function verifyEngravingArtworkToken(token) {
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

  const metadata = validateEngravingArtworkMetadata(payload);
  const resourceUrl = String(payload?.resourceUrl || "").trim();
  if (!resourceUrl.startsWith("https://")) throw new Error("Artwork upload receipt is invalid.");

  return { ...metadata, resourceUrl, exp: payload.exp };
}
