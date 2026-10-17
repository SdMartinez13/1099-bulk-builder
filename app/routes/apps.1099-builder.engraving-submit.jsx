import { authenticate } from "../shopify.server";

const emailLooksValid = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

class EngravingSubmissionInputError extends Error {}

function normalizeCustomer(input) {
  const name = String(input?.name || "").trim();
  const email = String(input?.email || "").trim();
  const phone = String(input?.phone || "").trim();

  if (!name) throw new EngravingSubmissionInputError("Please enter your name.");
  if (name.length > 120) throw new EngravingSubmissionInputError("Name is too long.");
  if (!emailLooksValid(email)) throw new EngravingSubmissionInputError("Please enter a valid email address.");
  if (email.length > 254) throw new EngravingSubmissionInputError("Email address is too long.");
  if (phone.length > 80) throw new EngravingSubmissionInputError("Phone number is too long.");

  return { name, email, phone };
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

function normalizeText(value, maxLength, errorMessage) {
  const text = String(value || "").trim();
  if (text.length > maxLength) throw new EngravingSubmissionInputError(errorMessage);
  return text;
}

function normalizeArtwork(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > 4) throw new EngravingSubmissionInputError("Too many artwork files were supplied.");

  const seenIds = new Set();
  return input.map((item, index) => {
    const id = String(item?.id || "").trim();
    const url = String(item?.url || "").trim();
    const filename = String(item?.filename || "").trim();
    const slot = Number.parseInt(String(item?.slot ?? index + 1), 10);

    if (!/^gid:\/\/shopify\/GenericFile\/\d+$/.test(id)) {
      throw new EngravingSubmissionInputError("Artwork upload information is invalid. Please reselect the artwork and try again.");
    }
    if (!/^https:\/\//i.test(url)) {
      throw new EngravingSubmissionInputError("Artwork upload information is incomplete. Please reselect the artwork and try again.");
    }
    if (!filename || filename.length > 255) {
      throw new EngravingSubmissionInputError("Artwork filename is invalid. Please reselect the artwork and try again.");
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
          product {
            id
            title
            handle
            tags
          }
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
  try {
    const auth = await authenticate.public.appProxy(request);
    const admin = auth.admin;
    if (!admin) throw new Error("Unable to access Shopify Admin API.");

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new EngravingSubmissionInputError("Proof request must be JSON.");
    }

    const body = await request.json();
    const customer = normalizeCustomer(body?.customer);
    const variantId = normalizeVariantId(body?.variantId);
    const quantity = normalizeQuantity(body?.quantity);
    const engravingText = normalizeText(body?.engravingText, 500, "Engraving text is too long.");
    const engravingNotes = normalizeText(body?.engravingNotes, 1500, "Engraving notes are too long.");
    const artwork = normalizeArtwork(body?.artworks);

    if (!engravingText && artwork.length < 1) {
      throw new EngravingSubmissionInputError("Please enter engraving text or upload artwork before submitting for proof.");
    }

    const variant = await getEngravingVariant(admin, variantId);

    const artworkAttributes = artwork.flatMap((item, index) => {
      const label = `Artwork ${index + 1}`;
      return [
        { key: `${label} filename`, value: item.filename },
        { key: `${label} URL`, value: item.url },
        { key: `${label} file ID`, value: item.id },
      ];
    });

    const lineAttributes = [
      ...(engravingText ? [{ key: "Engraving Text", value: engravingText }] : []),
      ...(engravingNotes ? [{ key: "Engraving Notes", value: engravingNotes }] : []),
      { key: "Proof", value: "Digital proof required before production" },
      ...artworkAttributes,
    ];

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
          email: customer.email,
          customAttributes: [
            { key: "Customer name", value: customer.name },
            ...(customer.phone ? [{ key: "Phone", value: customer.phone }] : []),
            { key: "Workflow", value: "Proof required before invoice/payment" },
            { key: "Request type", value: "Custom engraving" },
          ],
          tags: ["1099-builder", "proof-required", "engraving-proof"],
          lineItems: [{
            variantId: variant.id,
            quantity,
            customAttributes: lineAttributes,
          }],
          note: `Proof required before invoicing. Custom engraving request submitted by ${customer.name} for ${variant.product.title}.`,
          visibleToCustomer: false,
        },
      },
    });

    const json = await response.json();
    if (json?.errors?.length) {
      console.error("1099 ENGRAVING DRAFT ORDER GRAPHQL ERRORS:", JSON.stringify(json.errors));
      throw new Error("Shopify could not create the engraving proof request.");
    }

    const payload = json?.data?.draftOrderCreate;
    if (payload?.userErrors?.length) {
      console.error("1099 ENGRAVING DRAFT ORDER USER ERRORS:", JSON.stringify(payload.userErrors));
      throw new EngravingSubmissionInputError(
        payload.userErrors.map((item) => item.message).filter(Boolean).join(" ") ||
          "The engraving proof request could not be created. Please review your information and try again.",
      );
    }

    if (!payload?.draftOrder?.id) throw new Error("Shopify did not return the created engraving draft order.");

    return Response.json({
      ok: true,
      draftOrder: {
        id: payload.draftOrder.id,
        name: payload.draftOrder.name,
        total: payload.draftOrder.totalPriceSet?.shopMoney || null,
      },
    }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("APP PROXY ENGRAVING PROOF SUBMIT ERROR:", error);

    const isInputError = error instanceof EngravingSubmissionInputError;
    const message = isInputError
      ? error.message
      : "We couldn’t submit your engraving proof request. Please try again.";

    return Response.json({ ok: false, error: message }, {
      status: isInputError ? 400 : 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
};