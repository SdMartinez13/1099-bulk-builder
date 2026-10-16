import { authenticate } from "../shopify.server";
import {
  MAX_ENGRAVING_ARTWORK_BYTES,
  createEngravingArtworkToken,
  validateEngravingArtworkMetadata,
} from "../engraving-upload.server";

class EngravingStageInputError extends Error {}

function asInputError(error) {
  return new EngravingStageInputError(
    error instanceof Error ? error.message : "Invalid engraving artwork upload request.",
  );
}

export const action = async ({ request }) => {
  try {
    const { admin } = await authenticate.public.appProxy(request);
    if (!admin) throw new Error("Unable to access Shopify Admin API.");

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new EngravingStageInputError("Artwork upload request must be JSON.");
    }

    const body = await request.json();
    let metadata;
    try {
      metadata = validateEngravingArtworkMetadata(body);
    } catch (error) {
      throw asInputError(error);
    }

    const response = await admin.graphql(`#graphql
      mutation Stage1099EngravingArtwork($input: [StagedUploadInput!]!) {
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
      console.error("1099 ENGRAVING ARTWORK STAGE USER ERRORS:", JSON.stringify(payload.userErrors));
      throw new EngravingStageInputError("We couldn’t prepare that artwork upload. Please reselect the file and try again.");
    }

    const target = payload?.stagedTargets?.[0];
    if (!target?.url || !target?.resourceUrl || !Array.isArray(target.parameters)) {
      throw new Error("Shopify did not return a complete staged upload target.");
    }

    const token = createEngravingArtworkToken(metadata, target.resourceUrl);

    return Response.json({
      ok: true,
      maxBytes: MAX_ENGRAVING_ARTWORK_BYTES,
      artwork: {
        filename: metadata.filename,
        mimeType: metadata.mimeType,
        size: metadata.size,
        slot: metadata.slot,
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
    console.error("APP PROXY ENGRAVING ARTWORK STAGE ERROR:", error);
    const message = error instanceof EngravingStageInputError
      ? error.message
      : "We couldn’t prepare your artwork upload. Please try again.";

    return Response.json({ ok: false, error: message }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
};
