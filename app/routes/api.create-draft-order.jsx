import { authenticate } from "../shopify.server";
import { calculateOrder } from "../garment-config";

export { calculateOrder } from "../garment-config";

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
