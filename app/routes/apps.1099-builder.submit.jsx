import { authenticate } from "../shopify.server";
import {
  calculateOrder,
  GARMENTS,
  FRONT_WIDTHS,
  BACK_WIDTHS,
  CHEST_WIDTHS,
} from "../garment-config";
import { verifyArtworkToken } from "../artwork-upload.server";

const PLACEMENT_RULES = [
  { key: "chest_left", label: "Left chest", widths: CHEST_WIDTHS },
  { key: "chest_right", label: "Right chest", widths: CHEST_WIDTHS },
  { key: "front", label: "Full front", widths: FRONT_WIDTHS },
  { key: "back", label: "Full back", widths: BACK_WIDTHS },
];

const emailLooksValid = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

class SubmissionInputError extends Error {}

function normalizeCustomer(input) {
  const name = String(input?.name || "").trim();
  const email = String(input?.email || "").trim();
  const phone = String(input?.phone || "").trim();
  const company = String(input?.company || "").trim();

  if (!name) throw new SubmissionInputError("Please enter your name.");
  if (name.length > 120) throw new SubmissionInputError("Name is too long.");
  if (!emailLooksValid(email)) throw new SubmissionInputError("Please enter a valid email address.");
  if (email.length > 254) throw new SubmissionInputError("Email address is too long.");
  if (phone.length > 80) throw new SubmissionInputError("Phone number is too long.");
  if (company.length > 160) throw new SubmissionInputError("Company / organization is too long.");

  return { name, email, phone, company };
}

function normalizePrints(submittedPrints) {
  if (!Array.isArray(submittedPrints) || submittedPrints.length < 1) {
    throw new SubmissionInputError("Select at least one print placement.");
  }

  const seen = new Set();
  return submittedPrints.map((print) => {
    const key = String(print?.key || "");
    const rule = PLACEMENT_RULES.find((item) => item.key === key);
    if (!rule) throw new SubmissionInputError("One of the selected print placements is invalid.");
    if (seen.has(key)) throw new SubmissionInputError(`Duplicate print placement: ${rule.label}.`);
    seen.add(key);

    const width = String(print?.width || "");
    if (!rule.widths.includes(width)) throw new SubmissionInputError(`Invalid print size for ${rule.label}.`);

    return { key: rule.key, label: rule.label, width };
  });
}

function normalizeArtworkReceipts(submittedArtwork, prints) {
  if (!Array.isArray(submittedArtwork)) throw new SubmissionInputError("Artwork upload information is missing.");

  const selectedKeys = new Set(prints.map((print) => print.key));
  const receipts = new Map();

  for (const item of submittedArtwork) {
    const key = String(item?.key || "");
    if (!selectedKeys.has(key)) throw new SubmissionInputError("Artwork was supplied for an unselected print location.");
    if (receipts.has(key)) throw new SubmissionInputError("Duplicate artwork upload information was supplied.");

    try {
      receipts.set(key, verifyArtworkToken(item?.token, key));
    } catch (error) {
      throw new SubmissionInputError(
        error instanceof Error ? error.message : "Artwork upload information is invalid.",
      );
    }
  }

  for (const print of prints) {
    if (!receipts.has(print.key)) throw new SubmissionInputError(`Please upload artwork for ${print.label}.`);
  }

  return prints.map((print) => ({ ...print, ...receipts.get(print.key) }));
}

function pricingPayload(quote) {
  return {
    quantity: quote.quantity,
    garments: quote.garments.toFixed(2),
    dtf: quote.dtf.toFixed(2),
    calculatedTotal: quote.calculatedTotal.toFixed(2),
    minimumAdjustment: quote.minimumAdjustment.toFixed(2),
    total: quote.total.toFixed(2),
    tier: quote.tier,
    smallRunMinimumApplies: quote.smallRunMinimumApplies,
    smallRunMinimum: quote.smallRunMinimum.toFixed(2),
    prints: quote.prints.map((print) => ({
      key: print.key,
      label: print.label,
      width: print.width,
      rate: print.rate.toFixed(2),
      subtotal: print.subtotal.toFixed(2),
    })),
  };
}

async function createShopifyFiles(admin, artwork) {
  const response = await admin.graphql(`#graphql
    mutation Create1099ArtworkFiles($files: [FileCreateInput!]!) {
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
      files: artwork.map((item) => ({
        filename: item.filename,
        contentType: "FILE",
        duplicateResolutionMode: "APPEND_UUID",
        originalSource: item.resourceUrl,
        alt: `1099 Designs artwork (${item.label}) - ${item.filename}`,
      })),
    },
  });

  const payload = (await response.json())?.data?.fileCreate;
  if (payload?.userErrors?.length) {
    console.error("1099 FILE CREATE USER ERRORS:", JSON.stringify(payload.userErrors));
    throw new SubmissionInputError("One or more artwork uploads could not be finalized. Please reselect the artwork and try again.");
  }

  const files = payload?.files || [];
  if (files.length !== artwork.length || files.some((file) => !file?.id)) {
    throw new Error("Shopify did not return all created artwork files.");
  }

  return artwork.map((item, index) => ({
    ...item,
    id: files[index].id,
    url: files[index].url || null,
    fileStatus: files[index].fileStatus || null,
  }));
}

async function cleanupFiles(admin, fileIds) {
  if (!fileIds.length) return;

  try {
    const response = await admin.graphql(`#graphql
      mutation Cleanup1099Artwork($fileIds: [ID!]!) {
        fileDelete(fileIds: $fileIds) {
          deletedFileIds
          userErrors { field message code }
        }
      }`, { variables: { fileIds } });

    const payload = (await response.json())?.data?.fileDelete;
    if (payload?.userErrors?.length) {
      console.error("1099 ARTWORK CLEANUP USER ERRORS:", JSON.stringify(payload.userErrors));
    }
  } catch (error) {
    console.error("1099 ARTWORK CLEANUP ERROR:", error);
  }
}

export const action = async ({ request }) => {
  let admin = null;
  let createdFileIds = [];

  try {
    const auth = await authenticate.public.appProxy(request);
    admin = auth.admin;
    if (!admin) throw new Error("Unable to access Shopify Admin API.");

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new SubmissionInputError("Order submission must be JSON.");
    }

    const body = await request.json();
    const customer = normalizeCustomer(body?.customer);
    const garment = String(body?.garment || "PC450").trim();
    const color = String(body?.color || "Athletic Heather").trim();
    const sizes = body?.sizes;

    if (!sizes || typeof sizes !== "object" || Array.isArray(sizes)) {
      throw new SubmissionInputError("Sizes are required.");
    }

    const prints = normalizePrints(body?.prints);
    const artwork = normalizeArtworkReceipts(body?.artwork, prints);

    let quote;
    try {
      quote = calculateOrder({ sizes, prints, garment, color, markup: 2 });
    } catch (error) {
      throw new SubmissionInputError(
        error instanceof Error ? error.message : "Invalid order details.",
      );
    }

    const uploadedArtwork = await createShopifyFiles(admin, artwork);
    createdFileIds = uploadedArtwork.map((item) => item.id);

    const sizeText = Object.entries(quote.sizes)
      .map(([size, qty]) => `${size}: ${qty}`)
      .join(", ");

    const printAttributes = quote.prints.flatMap((print) => [
      { key: `${print.label} width`, value: `${print.width} in` },
      { key: `${print.label} print cost`, value: `$${print.subtotal.toFixed(2)} ($${print.rate.toFixed(2)}/print)` },
    ]);

    const artworkAttributes = uploadedArtwork.flatMap((item) => [
      { key: `${item.label} artwork file ID`, value: item.id },
      ...(item.url ? [{ key: `${item.label} artwork URL`, value: item.url }] : []),
      { key: `${item.label} artwork filename`, value: item.filename },
    ]);

    const minimumAttributes = quote.minimumAdjustment > 0
      ? [
          { key: "Calculated subtotal", value: `$${quote.calculatedTotal.toFixed(2)}` },
          { key: "Small-run minimum adjustment", value: `$${quote.minimumAdjustment.toFixed(2)}` },
        ]
      : [];

    const response = await admin.graphql(`#graphql
      mutation Create1099DraftOrder($input: DraftOrderInput!) {
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
            ...(customer.company ? [{ key: "Company / Organization", value: customer.company }] : []),
            { key: "Workflow", value: "Proof required before invoice/payment" },
          ],
          tags: ["1099-builder", "proof-required", "v2-builder"],
          lineItems: [{
            title: "1099 Designs Custom Apparel Order",
            quantity: 1,
            requiresShipping: true,
            taxable: true,
            originalUnitPriceWithCurrency: {
              amount: quote.total.toFixed(2),
              currencyCode: "USD",
            },
            customAttributes: [
              { key: "Garment", value: GARMENTS[garment].label },
              { key: "Color", value: color },
              { key: "Sizes", value: sizeText },
              ...printAttributes,
              { key: "Total garments", value: String(quote.quantity) },
              { key: "Garments subtotal", value: `$${quote.garments.toFixed(2)}` },
              { key: "DTF printing", value: `$${quote.dtf.toFixed(2)}` },
              ...minimumAttributes,
              { key: "Estimated order subtotal", value: `$${quote.total.toFixed(2)}` },
              { key: "DTF tier", value: quote.tier },
              ...artworkAttributes,
            ],
          }],
          note: `Proof required before invoicing. Submitted through the 1099 Designs V2 custom apparel builder by ${customer.name}.`,
          metafields: uploadedArtwork.map((item) => ({
            namespace: "1099_design",
            key: `artwork_${item.key}`,
            type: "file_reference",
            value: item.id,
          })),
        },
      },
    });

    const result = (await response.json())?.data?.draftOrderCreate;
    if (result?.userErrors?.length) {
      console.error("1099 DRAFT ORDER USER ERRORS:", JSON.stringify(result.userErrors));
      await cleanupFiles(admin, createdFileIds);
      createdFileIds = [];
      throw new SubmissionInputError("We couldn’t submit your order. Please review the information and try again.");
    }

    if (!result?.draftOrder) {
      await cleanupFiles(admin, createdFileIds);
      createdFileIds = [];
      throw new Error("Shopify did not create the Draft Order.");
    }

    console.log("1099 V2 PROOF REQUEST CREATED", JSON.stringify({
      name: result.draftOrder.name,
      customerEmail: customer.email,
      total: result.draftOrder.totalPriceSet?.shopMoney?.amount,
    }));

    return Response.json({
      ok: true,
      draftOrder: {
        id: result.draftOrder.id,
        name: result.draftOrder.name,
      },
      pricing: pricingPayload(quote),
      artwork: uploadedArtwork.map((item) => ({
        key: item.key,
        filename: item.filename,
        fileId: item.id,
      })),
    }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (admin && createdFileIds.length) {
      await cleanupFiles(admin, createdFileIds);
    }

    console.error("APP PROXY FINAL SUBMISSION ERROR:", error);
    const message = error instanceof SubmissionInputError
      ? error.message
      : "We couldn’t submit your order. Please try again.";

    return Response.json({ ok: false, error: message }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
};
