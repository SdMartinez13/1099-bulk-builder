import { authenticate } from "../shopify.server";

const emailLooksValid = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

class EngravingSubmissionInputError extends Error {}

function normalizeReturnPath(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.length > 2000) return "/";
  return raw;
}

function withResult(returnPath, params) {
  const url = new URL(returnPath, "https://storefront.invalid");
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonForInlineScript(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function returnToStorefront(location, result) {
  const safeLocationHtml = escapeHtml(location);
  const safeLocationJs = jsonForInlineScript(location);
  const safeResultJs = jsonForInlineScript(JSON.stringify(result));

  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Returning to your engraving request</title></head><body><p>Returning to your engraving request…</p><script>try{sessionStorage.setItem("1099-engraving-proof-result",${safeResultJs});}catch(e){}window.location.replace(${safeLocationJs});</script><noscript><meta http-equiv="refresh" content="0;url=${safeLocationHtml}"><p><a href="${safeLocationHtml}">Continue</a></p></noscript></body></html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

function wantsJson(request) {
  return String(request.headers.get("accept") || "").toLowerCase().includes("application/json");
}

function normalizeVariantId(value) {
  const raw = String(value || "").trim();
  if (/^\d+$/.test(raw)) return `gid://shopify/ProductVariant/${raw}`;
  if (/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(raw)) return raw;
  throw new EngravingSubmissionInputError("The selected product option is invalid. Please refresh and try again.");
}

function normalizeQuantity(value) {
  const quantity = Number.parseInt(String(value ?? "1"), 10);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new EngravingSubmissionInputError("Please enter a valid quantity.");
  }
  return quantity;
}

function normalizeArtwork(value) {
  let input = [];
  try {
    input = JSON.parse(String(value || "[]"));
  } catch {
    throw new EngravingSubmissionInputError("Artwork information is invalid. Please reselect your artwork and try again.");
  }

  if (!Array.isArray(input)) return [];
  if (input.length > 4) throw new EngravingSubmissionInputError("Too many artwork files were supplied.");

  const seenIds = new Set();
  return input.map((item, index) => {
    const id = String(item?.id || "").trim();
    const url = String(item?.url || "").trim();
    const filename = String(item?.filename || "").trim();
    const slot = Number.parseInt(String(item?.slot ?? index + 1), 10);

    if (!/^gid:\/\/shopify\/GenericFile\/\d+$/.test(id) || !/^https:\/\//i.test(url) || !filename || filename.length > 255) {
      throw new EngravingSubmissionInputError("Artwork upload information is invalid. Please reselect your artwork and try again.");
    }
    if (seenIds.has(id)) throw new EngravingSubmissionInputError("Duplicate artwork was supplied.");
    seenIds.add(id);

    return { id, url, filename, slot: Number.isInteger(slot) && slot > 0 ? slot : index + 1 };
  });
}

async function getEngravingVariant(admin, variantId) {
  const response = await admin.graphql(`#graphql
    query Get1099EngravingVariant($id: ID!) {
      node(id: $id) {
        ... on ProductVariant {
          id
          title
          availableForSale
          product { id title handle tags }
        }
      }
    }`, { variables: { id: variantId } });

  const json = await response.json();
  if (json?.errors?.length) {
    console.error("1099 ENGRAVING VARIANT QUERY ERRORS:", JSON.stringify(json.errors));
    throw new Error("Shopify could not verify the selected engraving product.");
  }

  const variant = json?.data?.node;
  if (!variant?.id || !variant?.product?.id) {
    throw new EngravingSubmissionInputError("The selected engraving product could not be found. Please refresh and try again.");
  }
  if (!Array.isArray(variant.product.tags) || !variant.product.tags.includes("Custom Engraving")) {
    throw new EngravingSubmissionInputError("This proof request is only available for custom engraving products.");
  }
  if (!variant.availableForSale) {
    throw new EngravingSubmissionInputError("That product option is currently unavailable. Please select another option.");
  }

  return variant;
}

export const action = async ({ request }) => {
  let returnPath = "/";

  try {
    const { admin } = await authenticate.public.appProxy(request);
    if (!admin) throw new Error("Unable to access Shopify Admin API.");

    const form = await request.formData();
    returnPath = normalizeReturnPath(form.get("return_path"));

    const customerName = String(form.get("customer_name") || "").trim();
    const customerEmail = String(form.get("customer_email") || "").trim();
    const customerPhone = String(form.get("customer_phone") || "").trim();
    const engravingText = String(form.get("engraving_text") || "").trim();
    const engravingNotes = String(form.get("engraving_notes") || "").trim();
    const variantId = normalizeVariantId(form.get("variant_id"));
    const quantity = normalizeQuantity(form.get("quantity"));
    const artwork = normalizeArtwork(form.get("artworks"));

    if (!customerName) throw new EngravingSubmissionInputError("Please enter your name.");
    if (customerName.length > 120) throw new EngravingSubmissionInputError("Name is too long.");
    if (!emailLooksValid(customerEmail)) throw new EngravingSubmissionInputError("Please enter a valid email address.");
    if (customerEmail.length > 254) throw new EngravingSubmissionInputError("Email address is too long.");
    if (customerPhone.length > 80) throw new EngravingSubmissionInputError("Phone number is too long.");
    if (engravingText.length > 120) throw new EngravingSubmissionInputError("Engraving text is too long.");
    if (engravingNotes.length > 500) throw new EngravingSubmissionInputError("Special instructions are too long.");
    if (!engravingText && artwork.length < 1) {
      throw new EngravingSubmissionInputError("Please enter engraving text or upload artwork before submitting for proof.");
    }

    const variant = await getEngravingVariant(admin, variantId);
    const artworkAttributes = artwork.flatMap((item, index) => {
      const label = artwork.length > 1 ? `Artwork ${index + 1}` : "Artwork";
      return [
        { key: `${label} filename`, value: item.filename },
        { key: `${label} URL`, value: item.url },
        { key: `${label} file ID`, value: item.id },
      ];
    });

    const response = await admin.graphql(`#graphql
      mutation Create1099EngravingDraftOrder($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            totalPriceSet { shopMoney { amount currencyCode } }
          }
          userErrors { field message }
        }
      }`, {
      variables: {
        input: {
          email: customerEmail,
          customAttributes: [
            { key: "Customer name", value: customerName },
            ...(customerPhone ? [{ key: "Phone", value: customerPhone }] : []),
            { key: "Workflow", value: "Proof required before invoice/payment" },
            { key: "Request type", value: "Custom engraving" },
          ],
          tags: ["1099-builder", "proof-required", "engraving-proof"],
          lineItems: [{
            variantId: variant.id,
            quantity,
            customAttributes: [
              ...(engravingText ? [{ key: "Engraving Text", value: engravingText }] : []),
              ...(engravingNotes ? [{ key: "Engraving Notes", value: engravingNotes }] : []),
              { key: "Proof", value: "Digital proof required before production" },
              ...artworkAttributes,
            ],
          }],
          note: `Proof required before invoicing. Custom engraving request submitted by ${customerName} for ${variant.product.title}.`,
        },
      },
    });

    const json = await response.json();
    if (json?.errors?.length) {
      console.error("1099 ENGRAVING DRAFT ORDER GRAPHQL ERRORS:", JSON.stringify(json.errors));
      throw new Error("Shopify could not create the engraving proof request.");
    }

    const result = json?.data?.draftOrderCreate;
    if (result?.userErrors?.length) {
      console.error("1099 ENGRAVING DRAFT ORDER USER ERRORS:", JSON.stringify(result.userErrors));
      throw new EngravingSubmissionInputError(
        result.userErrors.map((item) => item.message).filter(Boolean).join(" ") ||
          "The engraving proof request could not be created. Please review your information and try again.",
      );
    }
    if (!result?.draftOrder?.id) throw new Error("Shopify did not return the created engraving draft order.");

    console.log("1099 ENGRAVING PROOF REQUEST CREATED", JSON.stringify({
      name: result.draftOrder.name,
      customerEmail,
      total: result.draftOrder.totalPriceSet?.shopMoney?.amount,
    }));

    if (wantsJson(request)) {
      return Response.json({
        ok: true,
        state: "submitted",
        proofRef: result.draftOrder.name,
        email: customerEmail,
      }, {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const successLocation = withResult(returnPath, {
      engraving_proof: "submitted",
      proof_ref: result.draftOrder.name,
    });

    return returnToStorefront(successLocation, {
      state: "submitted",
      proofRef: result.draftOrder.name,
      email: customerEmail,
    });
  } catch (error) {
    console.error("APP PROXY ENGRAVING PROOF SUBMIT ERROR:", error);
    const message = error instanceof EngravingSubmissionInputError
      ? error.message
      : "We couldn’t submit your engraving proof request. Please try again.";

    if (wantsJson(request)) {
      return Response.json({ ok: false, state: "error", error: message }, {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const errorLocation = withResult(returnPath, {
      engraving_proof: "error",
      proof_error: message,
    });

    return returnToStorefront(errorLocation, {
      state: "error",
      message,
    });
  }
};
