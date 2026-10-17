import { useFetcher, useLoaderData } from "react-router";
import { AppProxyProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { validateEngravingArtworkMetadata } from "../engraving-upload.server";

const ENGRAVING_ARTWORK_ACCEPT = ".svg,.ai,.eps,.jpg,.jpeg,.bmp,.png,.heic,.tiff,.tif,.ppt,.pptx,.doc,.docx,.pdf,.psd";
const MAX_ENGRAVING_ARTWORK_BYTES = 20 * 1024 * 1024;

const emailLooksValid = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

class EngravingInputError extends Error {}

function normalizeVariantId(value) {
  const raw = String(value || "").trim();
  if (/^\d+$/.test(raw)) return `gid://shopify/ProductVariant/${raw}`;
  if (/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(raw)) return raw;
  throw new EngravingInputError("The selected product option is invalid. Please return to the product and try again.");
}

function normalizeQuantity(value) {
  const quantity = Number.parseInt(String(value ?? "1"), 10);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new EngravingInputError("Please enter a valid quantity.");
  }
  return quantity;
}

async function getEngravingVariant(admin, variantId) {
  const response = await admin.graphql(`#graphql
    query Get1099EngravingProxyVariant($id: ID!) {
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
    console.error("1099 ENGRAVING PROXY VARIANT QUERY ERRORS:", JSON.stringify(json.errors));
    throw new Error("Shopify could not verify the selected engraving product.");
  }

  const variant = json?.data?.node;
  if (!variant?.id || !variant?.product?.id) {
    throw new EngravingInputError("The selected engraving product could not be found.");
  }
  if (!Array.isArray(variant.product.tags) || !variant.product.tags.includes("Custom Engraving")) {
    throw new EngravingInputError("This proof form is only available for custom engraving products.");
  }
  if (!variant.availableForSale) {
    throw new EngravingInputError("That product option is currently unavailable.");
  }

  return variant;
}

async function uploadEngravingArtwork(admin, file, slot) {
  let metadata;
  try {
    metadata = validateEngravingArtworkMetadata({
      filename: file.name,
      mimeType: file.type,
      size: file.size,
      slot,
    });
  } catch (error) {
    throw new EngravingInputError(error instanceof Error ? error.message : "Artwork file is invalid.");
  }

  const stagedResponse = await admin.graphql(`#graphql
    mutation Stage1099EngravingProxyArtwork($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`, {
    variables: {
      input: [{
        filename: metadata.filename,
        mimeType: metadata.mimeType,
        httpMethod: "POST",
        resource: "FILE",
      }],
    },
  });

  const staged = (await stagedResponse.json())?.data?.stagedUploadsCreate;
  if (staged?.userErrors?.length) {
    throw new Error(staged.userErrors.map((item) => item.message).filter(Boolean).join("; "));
  }

  const target = staged?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) {
    throw new Error("Shopify did not return an artwork upload target.");
  }

  const uploadBody = new FormData();
  for (const parameter of target.parameters || []) {
    uploadBody.append(parameter.name, parameter.value);
  }
  uploadBody.append("file", file, metadata.filename);

  const directUpload = await fetch(target.url, { method: "POST", body: uploadBody });
  if (!directUpload.ok) {
    throw new Error(`Shopify artwork upload failed (${directUpload.status}).`);
  }

  const fileResponse = await admin.graphql(`#graphql
    mutation Create1099EngravingProxyArtwork($files: [FileCreateInput!]!) {
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
        filename: metadata.filename,
        contentType: "FILE",
        duplicateResolutionMode: "APPEND_UUID",
        originalSource: target.resourceUrl,
        alt: `1099 Designs engraving artwork ${slot} - ${metadata.filename}`,
      }],
    },
  });

  const filePayload = (await fileResponse.json())?.data?.fileCreate;
  if (filePayload?.userErrors?.length) {
    throw new Error(filePayload.userErrors.map((item) => item.message).filter(Boolean).join("; "));
  }

  const created = filePayload?.files?.[0];
  if (!created?.id) throw new Error("Shopify did not return the created artwork file.");

  return {
    id: created.id,
    url: created.url || null,
    filename: metadata.filename,
    slot,
  };
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);
  if (!admin) throw new Response("Unable to access Shopify Admin API.", { status: 500 });

  const url = new URL(request.url);
  const variantId = normalizeVariantId(url.searchParams.get("variant"));
  const variant = await getEngravingVariant(admin, variantId);

  return {
    appUrl: process.env.SHOPIFY_APP_URL || "",
    variant: {
      id: variant.id,
      title: variant.title,
      productTitle: variant.product.title,
      productHandle: variant.product.handle,
    },
  };
};

export const action = async ({ request }) => {
  try {
    const { admin } = await authenticate.public.appProxy(request);
    if (!admin) throw new Error("Unable to access Shopify Admin API.");

    const form = await request.formData();
    const customerName = String(form.get("customer_name") || "").trim();
    const customerEmail = String(form.get("customer_email") || "").trim();
    const customerPhone = String(form.get("customer_phone") || "").trim();
    const engravingText = String(form.get("engraving_text") || "").trim();
    const engravingNotes = String(form.get("engraving_notes") || "").trim();
    const variantId = normalizeVariantId(form.get("variant_id"));
    const quantity = normalizeQuantity(form.get("quantity"));

    if (!customerName) throw new EngravingInputError("Please enter your name.");
    if (customerName.length > 120) throw new EngravingInputError("Name is too long.");
    if (!emailLooksValid(customerEmail)) throw new EngravingInputError("Please enter a valid email address.");
    if (customerEmail.length > 254) throw new EngravingInputError("Email address is too long.");
    if (customerPhone.length > 80) throw new EngravingInputError("Phone number is too long.");
    if (engravingText.length > 500) throw new EngravingInputError("Engraving text is too long.");
    if (engravingNotes.length > 1500) throw new EngravingInputError("Engraving notes are too long.");

    const variant = await getEngravingVariant(admin, variantId);
    const allowsFourArtworkFiles = /up to 4 different designs/i.test(variant.title);
    const maxArtworkSlots = allowsFourArtworkFiles ? 4 : 1;
    const artworkFiles = [];

    for (let slot = 1; slot <= 4; slot += 1) {
      const file = form.get(`artwork_${slot}`);
      if (file && typeof file !== "string" && file.size > 0) {
        if (slot > maxArtworkSlots) {
          throw new EngravingInputError("This product option allows one artwork file.");
        }
        artworkFiles.push({ file, slot });
      }
    }

    if (!engravingText && artworkFiles.length < 1) {
      throw new EngravingInputError("Please enter engraving text, upload artwork, or use both.");
    }

    const uploadedArtwork = [];
    for (const item of artworkFiles) {
      uploadedArtwork.push(await uploadEngravingArtwork(admin, item.file, item.slot));
    }

    const artworkAttributes = uploadedArtwork.flatMap((item) => [
      { key: `Artwork ${item.slot} filename`, value: item.filename },
      { key: `Artwork ${item.slot} file ID`, value: item.id },
      ...(item.url ? [{ key: `Artwork ${item.slot} URL`, value: item.url }] : []),
    ]);

    const lineAttributes = [
      ...(engravingText ? [{ key: "Engraving Text", value: engravingText }] : []),
      ...(engravingNotes ? [{ key: "Engraving Notes", value: engravingNotes }] : []),
      { key: "Proof", value: "Digital proof required before production" },
      ...artworkAttributes,
    ];

    const response = await admin.graphql(`#graphql
      mutation Create1099EngravingProxyDraftOrder($input: DraftOrderInput!) {
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
            customAttributes: lineAttributes,
          }],
          note: `Proof required before invoicing. Custom engraving request submitted by ${customerName} for ${variant.product.title}.`,
          visibleToCustomer: false,
          ...(uploadedArtwork.length
            ? {
                metafields: uploadedArtwork.map((item) => ({
                  namespace: "1099_design",
                  key: `engraving_artwork_${item.slot}`,
                  type: "file_reference",
                  value: item.id,
                })),
              }
            : {}),
        },
      },
    });

    const json = await response.json();
    if (json?.errors?.length) {
      console.error("1099 ENGRAVING PROXY DRAFT ORDER GRAPHQL ERRORS:", JSON.stringify(json.errors));
      throw new Error("Shopify could not create the engraving proof request.");
    }

    const result = json?.data?.draftOrderCreate;
    if (result?.userErrors?.length) {
      console.error("1099 ENGRAVING PROXY DRAFT ORDER USER ERRORS:", JSON.stringify(result.userErrors));
      throw new EngravingInputError(
        result.userErrors.map((item) => item.message).filter(Boolean).join(" ") ||
          "The engraving proof request could not be created.",
      );
    }
    if (!result?.draftOrder?.id) throw new Error("Shopify did not return the created engraving draft order.");

    console.log("1099 ENGRAVING PROXY REQUEST CREATED", JSON.stringify({
      name: result.draftOrder.name,
      customerEmail,
      variantId: variant.id,
      quantity,
      total: result.draftOrder.totalPriceSet?.shopMoney?.amount,
    }));

    return new Response(JSON.stringify({
      ok: true,
      draftOrder: result.draftOrder,
      customerEmail,
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("1099 ENGRAVING PROXY ACTION ERROR:", error);
    const message = error instanceof EngravingInputError
      ? error.message
      : "We couldn’t submit your engraving proof request. Please try again.";

    return Response.json({ ok: false, error: message }, {
      status: error instanceof EngravingInputError ? 400 : 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
};

const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: 12,
  marginTop: 6,
  border: "1px solid #444",
  borderRadius: 8,
  background: "#191919",
  color: "#fff",
};

const labelStyle = {
  display: "block",
  marginTop: 14,
  color: "#d4d4d4",
  fontSize: 14,
  fontWeight: 700,
};

export default function EngravingProofForm() {
  const fetcher = useFetcher();
  const { appUrl, variant } = useLoaderData();
  const isSubmitting = fetcher.state !== "idle";
  const allowsFourArtworkFiles = /up to 4 different designs/i.test(variant.title);
  const artworkSlots = allowsFourArtworkFiles ? [1, 2, 3, 4] : [1];

  const submit = (event) => {
    event.preventDefault();
    if (fetcher.state !== "idle") return;

    const formData = new FormData(event.currentTarget);
    const action = `${window.location.origin}${window.location.pathname}${window.location.search}`;
    fetcher.submit(formData, {
      method: "post",
      action,
      encType: "multipart/form-data",
    });
  };

  return (
    <AppProxyProvider appUrl={appUrl}>
      <main style={{ minHeight: "100vh", background: "#0a0a0a", color: "#f5f5f5", fontFamily: "Inter, system-ui, sans-serif", padding: "32px 18px 50px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          {fetcher.data?.ok ? (
            <section style={{ padding: 26, border: "1px solid #22c55e", borderRadius: 14, background: "#0d1b12" }}>
              <div style={{ color: "#4ade80", fontSize: 12, letterSpacing: 2, fontWeight: 900 }}>PROOF REQUEST RECEIVED</div>
              <h1 style={{ margin: "8px 0 10px", fontSize: 30 }}>Proof Request Received ✓</h1>
              <p style={{ color: "#d4d4d4", lineHeight: 1.6 }}>
                We’ll review your personalization and send a digital proof to {fetcher.data.customerEmail} before invoicing or production.
              </p>
              <p style={{ marginBottom: 0, color: "#a3a3a3" }}>
                Reference: <strong style={{ color: "#fff" }}>{fetcher.data.draftOrder?.name}</strong>
              </p>
            </section>
          ) : (
            <>
              <header style={{ marginBottom: 24 }}>
                <div style={{ color: "#ef233c", fontSize: 12, letterSpacing: 2, fontWeight: 900 }}>1099 DESIGNS / CUSTOM ENGRAVING</div>
                <h1 style={{ margin: "8px 0 6px", fontSize: 32 }}>Submit for Proof</h1>
                <p style={{ margin: 0, color: "#a3a3a3" }}>{variant.productTitle} — {variant.title}</p>
              </header>

              <form onSubmit={submit} encType="multipart/form-data" style={{ padding: 22, border: "1px solid #292929", borderRadius: 14, background: "#111" }}>
                <input type="hidden" name="variant_id" value={variant.id} />

                <label style={labelStyle}>Name
                  <input name="customer_name" autoComplete="name" required style={inputStyle} />
                </label>

                <label style={labelStyle}>Email
                  <input name="customer_email" type="email" autoComplete="email" required style={inputStyle} />
                </label>

                <label style={labelStyle}>Phone <span style={{ color: "#737373", fontWeight: 500 }}>(optional)</span>
                  <input name="customer_phone" type="tel" autoComplete="tel" style={inputStyle} />
                </label>

                <label style={labelStyle}>Quantity
                  <input name="quantity" type="number" min="1" max="99" defaultValue="1" required style={inputStyle} />
                </label>

                <label style={labelStyle}>Engraving text <span style={{ color: "#737373", fontWeight: 500 }}>(optional if uploading artwork)</span>
                  <input name="engraving_text" maxLength="500" placeholder="Name, initials, short message, etc." style={inputStyle} />
                </label>

                {artworkSlots.map((slot) => (
                  <label key={slot} style={labelStyle}>Artwork{allowsFourArtworkFiles ? ` ${slot}` : ""} <span style={{ color: "#737373", fontWeight: 500 }}>(optional if entering text)</span>
                    <input name={`artwork_${slot}`} type="file" accept={ENGRAVING_ARTWORK_ACCEPT} style={{ ...inputStyle, padding: 10 }} />
                  </label>
                ))}

                <p style={{ color: "#737373", fontSize: 12, margin: "8px 0 0" }}>
                  Accepted engraving artwork formats · {Math.round(MAX_ENGRAVING_ARTWORK_BYTES / 1024 / 1024)} MB max per file
                </p>

                <label style={labelStyle}>Notes for our artist <span style={{ color: "#737373", fontWeight: 500 }}>(optional)</span>
                  <textarea name="engraving_notes" rows="3" maxLength="1500" style={inputStyle} />
                </label>

                {fetcher.data?.error ? (
                  <p role="alert" style={{ color: "#fca5a5", margin: "16px 0 0" }}>{fetcher.data.error}</p>
                ) : null}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{ width: "100%", marginTop: 20, padding: 14, border: 0, borderRadius: 8, fontWeight: 900, fontSize: 16, cursor: isSubmitting ? "wait" : "pointer" }}
                >
                  {isSubmitting ? "Submitting for Proof…" : "Submit for Proof"}
                </button>
              </form>
            </>
          )}
        </div>
      </main>
    </AppProxyProvider>
  );
}