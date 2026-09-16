import { authenticate } from "../shopify.server";
import { calculateOrder } from "./api.create-draft-order";

export const action = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.public.appProxy(request);
    console.log("[1099 DEBUG] PROXY HIT");
    console.log("[1099 ART] 1 AUTH OK");

    if (!admin) {
      throw new Error("Unable to access Shopify Admin API.");
    }

    console.log("[1099 ART] 2 READING FORMDATA");
    console.log("[1099 DEBUG] BEFORE FORMDATA");
    const form = await request.formData();
    console.log("[1099 DEBUG] AFTER FORMDATA");
    console.log("[1099 ART] 3 FORMDATA OK");

    const body = {
      garment: form.get("garment") || "",
      color: form.get("color") || "",
      printLocation: form.get("printLocation") || "Front",
      printWidth: form.get("printWidth") || "",
      sizes: JSON.parse(String(form.get("sizes") || "{}")),
    };

    const garmentVariants = {
      PC450: {
        "Athletic Heather": "gid://shopify/ProductVariant/57401445056678",
      },
      G5000: {
        Black: "gid://shopify/ProductVariant/57401455444134",
        White: "gid://shopify/ProductVariant/57401455476902",
        Blue: "gid://shopify/ProductVariant/57401455509670",
        Red: "gid://shopify/ProductVariant/57401455542438",
        Gray: "gid://shopify/ProductVariant/57401455575206",
        Tan: "gid://shopify/ProductVariant/57401455607974",
      },
    };

    const garmentKey = String(body.garment || "PC450").trim();
    const colorKey = String(body.color || "Athletic Heather").trim();

    const selectedVariantId =
      garmentVariants[garmentKey]?.[colorKey];

    if (!selectedVariantId) {
      throw new Error(
        `Unsupported garment/color combination: ${garmentKey} / ${colorKey}`
      );
    }

    const artwork = form.get("artwork");

    const quote = calculateOrder({
      sizes: body.sizes,
      printWidth: body.printWidth,
      garment: garmentKey,
      color: colorKey,
      markup: 2,
    });

    const sizeText = Object.entries(quote.sizes)
      .map(([size, qty]) => `${size}: ${qty}`)
      .join(", ");

    let artworkFileId = null;
    let artworkFileUrl = null;

    if (artwork && typeof artwork !== "string" && artwork.size > 0) {
      console.log("[1099 ART] 4 STAGING FILE:", artwork.name, artwork.size, artwork.type);
      const stagedResponse = await admin.graphql(
        `#graphql
          mutation Stage1099Artwork($input: [StagedUploadInput!]!) {
            stagedUploadsCreate(input: $input) {
              stagedTargets {
                url
                resourceUrl
                parameters {
                  name
                  value
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            input: [
              {
                filename: artwork.name,
                mimeType: artwork.type || "application/octet-stream",
                httpMethod: "POST",
                resource: "FILE",
              },
            ],
          },
        },
      );

      console.log("[1099 ART] 5 STAGED RESPONSE RECEIVED");
      const stagedJson = await stagedResponse.json();
      const stagedPayload = stagedJson?.data?.stagedUploadsCreate;

      if (stagedPayload?.userErrors?.length) {
        throw new Error(
          stagedPayload.userErrors.map((e) => e.message).join("; "),
        );
      }

      const target = stagedPayload?.stagedTargets?.[0];

      if (!target?.url || !target?.resourceUrl) {
        throw new Error("Shopify did not return an artwork upload target.");
      }

      const uploadForm = new FormData();

      for (const parameter of target.parameters || []) {
        uploadForm.append(parameter.name, parameter.value);
      }

      uploadForm.append("file", artwork, artwork.name);

      console.log("[1099 ART] 6 UPLOADING TO STAGED TARGET");
      const uploadResponse = await fetch(target.url, {
        method: "POST",
        body: uploadForm,
      });

      console.log("[1099 ART] 7 STAGED UPLOAD RESPONSE:", uploadResponse.status);
      if (!uploadResponse.ok) {
        throw new Error(
          `Shopify artwork upload failed (${uploadResponse.status}).`,
        );
      }

      console.log("[1099 ART] 8 CREATING SHOPIFY FILE");
      const fileResponse = await admin.graphql(
        `#graphql
          mutation Create1099Artwork($files: [FileCreateInput!]!) {
            fileCreate(files: $files) {
              files {
                id
                fileStatus
                ... on GenericFile {
                  url
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            files: [
              {
                filename: artwork.name,
                contentType: "FILE",
                duplicateResolutionMode: "APPEND_UUID",
                originalSource: target.resourceUrl,
                alt: `1099 Designs artwork - ${artwork.name}`,
              },
            ],
          },
        },
      );

      console.log("[1099 ART] 9 FILE RESPONSE RECEIVED");
      const fileJson = await fileResponse.json();
      const filePayload = fileJson?.data?.fileCreate;

      if (filePayload?.userErrors?.length) {
        throw new Error(
          filePayload.userErrors.map((e) => e.message).join("; "),
        );
      }

      const createdFile = filePayload?.files?.[0];

      if (!createdFile?.id) {
        throw new Error("Shopify did not return the created artwork file.");
      }

      artworkFileId = createdFile.id;
      artworkFileUrl = createdFile.url || null;
    }

    console.log("[1099 ART] FINAL FILE STATE:", {
      received: !!artwork,
      artworkName: artwork?.name || null,
      artworkSize: artwork?.size || 0,
      artworkFileId,
      artworkFileUrl,
    });

    if (artwork && typeof artwork !== "string" && artwork.size > 0 && !artworkFileId) {
      throw new Error("Artwork was uploaded but Shopify did not return a file ID.");
    }

    console.log("[1099 ART] 10 CREATING DRAFT ORDER");
    const response = await admin.graphql(
      `#graphql
        mutation Create1099DraftOrder($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder {
              id
              name
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              invoiceUrl
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        variables: {
          input: {
            lineItems: [
              {
                variantId: selectedVariantId,
                quantity: 1,
                priceOverride: {
                  amount: quote.total.toFixed(2),
                  currencyCode: "USD",
                },
                customAttributes: [
                  {
                    key: "Garment",
                    value: body.garment || "PC450 Core Cotton Tee",
                  },
                  {
                    key: "Color",
                    value: body.color || "Athletic Heather",
                  },
                  {
                    key: "Sizes",
                    value: sizeText,
                  },
                  {
                    key: "Print location",
                    value: body.printLocation || "Front",
                  },
                  {
                    key: "Print width",
                    value: `${body.printWidth} in`,
                  },
                  {
                    key: "Total garments",
                    value: String(quote.quantity),
                  },
                  {
                    key: "Garments subtotal",
                    value: `$${quote.garments.toFixed(2)}`,
                  },
                  {
                    key: "DTF printing",
                    value: `$${quote.dtf.toFixed(2)}`,
                  },
                  {
                    key: "DTF tier",
                    value: `${quote.tier} @ $${quote.rate.toFixed(2)}/print`,
                  },
                  ...(artworkFileId
                    ? [{
                        key: "Artwork file ID",
                        value: artworkFileId,
                      }]
                    : []),
                  ...(artworkFileUrl
                    ? [{
                        key: "Artwork URL",
                        value: artworkFileUrl,
                      }]
                    : []),
                  ...(artworkFileId
                    ? [{
                        key: "Artwork filename",
                        value: artwork.name,
                      }]
                    : []),
                ],
              },
            ],
            note: "1099 Designs bulk apparel order — server-calculated pricing",
            ...(artworkFileId
              ? {
                  metafields: [
                    {
                      namespace: "1099_design",
                      key: "artwork",
                      type: "file_reference",
                      value: artworkFileId,
                    },
                  ],
                }
              : {}),
          },
        },
      },
    );

    const json = await response.json();
    const result = json.data?.draftOrderCreate;

    if (result?.userErrors?.length) {
      return Response.json(
        {
          ok: false,
          errors: result.userErrors,
        },
        { status: 400 },
      );
    }

    if (!result?.draftOrder) {
      throw new Error("Shopify did not create the Draft Order.");
    }

    return Response.json({
      ok: true,
      shop: session?.shop || null,
      draftOrder: result.draftOrder,
      artwork: {
        received: !!artwork,
        name: artwork?.name || null,
        size: artwork?.size || 0,
        id: artworkFileId,
        url: artworkFileUrl,
      },
      pricing: {
        quantity: quote.quantity,
        garments: quote.garments.toFixed(2),
        dtf: quote.dtf.toFixed(2),
        total: quote.total.toFixed(2),
        rate: quote.rate.toFixed(2),
        tier: quote.tier,
      },
    });
  } catch (error) {
    console.error("APP PROXY DRAFT ORDER ERROR:", error);
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to create order.",
      },
      { status: 400 },
    );
  }
};
