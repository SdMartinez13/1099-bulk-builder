import { authenticate } from "../shopify.server";

const DTF_PRICES = {
  "1.5": [1, .8, .65, .55, .45],
  "2": [1.5, 1.2, .98, .83, .68],
  "3": [2, 1.6, 1.3, 1.1, .9],
  "3.5": [2.25, 1.8, 1.46, 1.24, 1.01],
  "4": [2.5, 2, 1.63, 1.38, 1.13],
  "5": [3, 2.4, 1.95, 1.65, 1.35],
  "6": [3.25, 2.6, 2.11, 1.79, 1.46],
  "7": [3.5, 2.8, 2.28, 1.93, 1.58],
  "8": [3.75, 3, 2.44, 2.06, 1.69],
  "9": [4, 3.2, 2.6, 2.2, 1.8],
  "10": [4.25, 3.4, 2.76, 2.34, 1.91],
  "10.5": [4.5, 3.6, 2.93, 2.48, 2.03],
  "11": [4.5, 3.6, 2.93, 2.48, 2.03],
  "12": [5.5, 4.4, 3.58, 3.03, 2.48],
  "13": [6, 4.8, 3.9, 3.3, 2.7],
  "14": [7, 5.6, 4.55, 3.85, 3.15],
  "15": [8, 6.4, 5.2, 4.4, 3.6],
  "16": [9, 7.2, 5.85, 4.95, 4.05],
};

const GARMENT_COSTS = {
  PC450: {
    "Athletic Heather": {
      S: 2.89,
      M: 2.89,
      L: 2.89,
      XL: 2.89,
      "2XL": 4.58,
      "3XL": 5.97,
      "4XL": 5.97,
    },
  },
  G5000: {
    Black: { S: 3, M: 3, L: 3, XL: 3, "2XL": 6, "3XL": 6, "4XL": 7 },
    White: { S: 3, M: 3, L: 3, XL: 3, "2XL": 6, "3XL": 6, "4XL": 7 },
    Blue:  { S: 3, M: 3, L: 3, XL: 3, "2XL": 6, "3XL": 6, "4XL": 7 },
    Red:   { S: 3, M: 3, L: 3, XL: 3, "2XL": 6, "3XL": 6, "4XL": 7 },
    Gray:  { S: 3, M: 3, L: 3, XL: 3, "2XL": 6, "3XL": 6, "4XL": 7 },
    Tan:   { S: 3, M: 3, L: 3, XL: 3, "2XL": 6, "3XL": 6, "4XL": 7 },
  },
};

function getTier(quantity) {
  if (quantity >= 250) return [4, "250+"];
  if (quantity >= 100) return [3, "100–249"];
  if (quantity >= 50) return [2, "50–99"];
  if (quantity >= 10) return [1, "10–49"];
  return [0, "1–9"];
}

export function calculateOrder({ sizes, printWidth, garment = "PC450", color = "Athletic Heather", markup = 2 }) {
  if (!sizes || typeof sizes !== "object") {
    throw new Error("Sizes are required.");
  }

  if (!DTF_PRICES[String(printWidth)]) {
    throw new Error("Invalid print width.");
  }

  const sizeCosts = GARMENT_COSTS[garment]?.[color];

  if (!sizeCosts) {
    throw new Error(`Unsupported garment/color combination: ${garment} / ${color}`);
  }

  let quantity = 0;
  let garments = 0;
  const cleanSizes = {};

  for (const [size, rawQty] of Object.entries(sizes)) {
    if (!(size in sizeCosts)) throw new Error(`Invalid size: ${size}`);

    const qty = Number(rawQty);

    if (!Number.isInteger(qty) || qty < 0) {
      throw new Error(`Invalid quantity for ${size}`);
    }

    if (qty > 0) {
      cleanSizes[size] = qty;
      quantity += qty;
      garments += qty * sizeCosts[size] * markup;
    }
  }

  if (quantity < 1) throw new Error("Order must contain at least one garment.");

  const [tierIndex, tierName] = getTier(quantity);
  const rate = DTF_PRICES[String(printWidth)][tierIndex];
  const dtf = quantity * rate;
  const total = garments + dtf;

  return {
    quantity,
    sizes: cleanSizes,
    garments,
    dtf,
    total,
    rate,
    tier: tierName,
  };
}

export const action = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();

    const body = {
      garment: formData.get("garment"),
      color: formData.get("color"),
      printLocation: formData.get("printLocation"),
      printWidth: formData.get("printWidth"),
      sizes: JSON.parse(formData.get("sizes") || "{}"),
      artwork: formData.get("artwork"),
    };

    const quote = calculateOrder({
      sizes: body.sizes,
      printWidth: body.printWidth,
      garment: body.garment || "PC450",
      color: body.color || "Athletic Heather",
      markup: 2,
    });

    const sizeText = Object.entries(quote.sizes)
      .map(([size, qty]) => `${size}: ${qty}`)
      .join(", ");

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
                title: "1099 Designs Custom Apparel Order",
                quantity: 1,
                originalUnitPriceWithCurrency: {
                  amount: quote.total.toFixed(2),
                  currencyCode: "USD",
                },
                customAttributes: [
                  { key: "Garment", value: body.garment || "PC450 Core Cotton Tee" },
                  { key: "Color", value: body.color || "Athletic Heather" },
                  { key: "Sizes", value: sizeText },
                  { key: "Print location", value: body.printLocation || "Front" },
                  { key: "Print width", value: `${body.printWidth} in` },
                  { key: "Total garments", value: String(quote.quantity) },
                  { key: "Garments subtotal", value: `$${quote.garments.toFixed(2)}` },
                  { key: "DTF printing", value: `$${quote.dtf.toFixed(2)}` },
                  { key: "DTF tier", value: `${quote.tier} @ $${quote.rate.toFixed(2)}/print` },
                ],
              },
            ],
            note: "1099 Designs bulk apparel order — server-calculated pricing",
          },
        },
      },
    );

    const json = await response.json();

    return Response.json({
      ...json,
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
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to create order." },
      { status: 400 },
    );
  }
};
