import { authenticate } from "../shopify.server";
import {
  MAX_ARTWORK_BYTES,
  createArtworkToken,
  validateArtworkMetadata,
} from "../artwork-upload.server";

class ArtworkStageInputError extends Error {}

function asInputError(error) {
  return new ArtworkStageInputError(
    error instanceof Error ? error.message : "Invalid artwork upload request.",
  );
}

export const action = async ({ request }) => {
  try {
    const { admin } = await authenticate.public.appProxy(request);
    if (!admin) throw new Error("Unable to access Shopify Admin API.");

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new ArtworkStageInputError("Artwork upload request must be JSON.");
    }

    const body = await request.json();
    let metadata;
    try {
      metadata = validateArtworkMetadata(body);
    } catch (error) {
      throw asInputError(error);
    }

    const response = await admin.graphql(`#graphql
      mutation Stage1099Artwork($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }`, {
      variables: {
        input: [{
          filename: metadata.filename,
          mimeType: metadata.mimeType,
          fileSize: String(metadata.size),
          httpMethod: "POST",
          resource: "FILE",
        }],
      },
    });

    const payload = (await response.json())?.data?.stagedUploadsCreate;
    if (payload?.userErrors?.length) {
      console.error("1099 ARTWORK STAGE USER ERRORS:", JSON.stringify(payload.userErrors));
      throw new ArtworkStageInputError("We couldn’t prepare that artwork upload. Please reselect the file and try again.");
    }

    const target = payload?.stagedTargets?.[0];
    if (!target?.url || !target?.resourceUrl || !Array.isArray(target.parameters)) {
      throw new Error("Shopify did not return a complete staged upload target.");
    }

    const token = createArtworkToken(metadata, target.resourceUrl);

    return Response.json({
      ok: true,
      maxBytes: MAX_ARTWORK_BYTES,
      artwork: {
        key: metadata.key,
        filename: metadata.filename,
        mimeType: metadata.mimeType,
        size: metadata.size,
        token,
      },
      upload: {
        method: "POST",
        url: target.url,
        parameters: target.parameters,
      },
    }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("APP PROXY ARTWORK STAGE ERROR:", error);
    const message = error instanceof ArtworkStageInputError
      ? error.message
      : "We couldn’t prepare your artwork upload. Please try again.";

    return Response.json({ ok: false, error: message }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
};
