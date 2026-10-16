import { authenticate } from "../shopify.server";
import { verifyEngravingArtworkToken } from "../engraving-upload.server";

const FILE_READY_ATTEMPTS = 16;
const FILE_READY_DELAY_MS = 500;

class EngravingFinalizeInputError extends Error {}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cleanupFile(admin, fileId) {
  if (!fileId) return;
  try {
    await admin.graphql(`#graphql
      mutation Cleanup1099EngravingArtwork($fileIds: [ID!]!) {
        fileDelete(fileIds: $fileIds) {
          deletedFileIds
          userErrors { field message code }
        }
      }`, { variables: { fileIds: [fileId] } });
  } catch (error) {
    console.error("1099 ENGRAVING ARTWORK CLEANUP ERROR:", error);
  }
}

async function waitForFile(admin, file) {
  let current = file;

  for (let attempt = 0; attempt < FILE_READY_ATTEMPTS; attempt += 1) {
    if (current?.url) return current;
    if (current?.fileStatus === "FAILED") {
      throw new EngravingFinalizeInputError("Shopify could not process that artwork file. Please reselect it and try again.");
    }

    if (attempt > 0) await sleep(FILE_READY_DELAY_MS);

    const response = await admin.graphql(`#graphql
      query Get1099EngravingArtwork($id: ID!) {
        node(id: $id) {
          ... on GenericFile {
            id
            fileStatus
            url
          }
        }
      }`, { variables: { id: current.id } });

    const json = await response.json();
    if (json?.errors?.length) {
      console.error("1099 ENGRAVING FILE READY QUERY ERRORS:", JSON.stringify(json.errors));
      throw new Error("Shopify artwork status could not be checked.");
    }

    const refreshed = json?.data?.node;
    if (refreshed?.id) current = refreshed;
  }

  throw new EngravingFinalizeInputError("Shopify is still processing that artwork. Please reselect it and try again.");
}

export const action = async ({ request }) => {
  let admin = null;
  let createdFileId = null;

  try {
    const auth = await authenticate.public.appProxy(request);
    admin = auth.admin;
    if (!admin) throw new Error("Unable to access Shopify Admin API.");

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new EngravingFinalizeInputError("Artwork finalization request must be JSON.");
    }

    const body = await request.json();
    let receipt;
    try {
      receipt = verifyEngravingArtworkToken(body?.token);
    } catch (error) {
      throw new EngravingFinalizeInputError(
        error instanceof Error ? error.message : "Artwork upload information is invalid.",
      );
    }

    const response = await admin.graphql(`#graphql
      mutation Create1099EngravingArtworkFile($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            fileStatus
            ... on GenericFile { url }
          }
          userErrors { field message }
        }
      }`, {
      variables: {
        files: [{
          filename: receipt.filename,
          contentType: "FILE",
          duplicateResolutionMode: "APPEND_UUID",
          originalSource: receipt.resourceUrl,
          alt: `1099 Designs engraving artwork - ${receipt.filename}`,
        }],
      },
    });

    const payload = (await response.json())?.data?.fileCreate;
    if (payload?.userErrors?.length) {
      console.error("1099 ENGRAVING FILE CREATE USER ERRORS:", JSON.stringify(payload.userErrors));
      throw new EngravingFinalizeInputError("That artwork upload could not be finalized. Please reselect the file and try again.");
    }

    const file = payload?.files?.[0];
    if (!file?.id) throw new Error("Shopify did not return the created artwork file.");
    createdFileId = file.id;

    const readyFile = await waitForFile(admin, file);

    return Response.json({
      ok: true,
      artwork: {
        id: readyFile.id,
        url: readyFile.url,
        filename: receipt.filename,
        mimeType: receipt.mimeType,
        size: receipt.size,
        slot: receipt.slot,
      },
    }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("APP PROXY ENGRAVING ARTWORK FINALIZE ERROR:", error);
    if (admin && createdFileId) await cleanupFile(admin, createdFileId);

    const message = error instanceof EngravingFinalizeInputError
      ? error.message
      : "We couldn’t finalize your artwork upload. Please try again.";

    return Response.json({ ok: false, error: message }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
};
