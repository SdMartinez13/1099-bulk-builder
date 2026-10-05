import { authenticate } from "../shopify.server";
import {
  calculateOrder,
  FRONT_WIDTHS,
  BACK_WIDTHS,
  CHEST_WIDTHS,
} from "../garment-config";

const PLACEMENT_RULES = [
  { key: "chest_left", label: "Left chest", widths: CHEST_WIDTHS },
  { key: "chest_right", label: "Right chest", widths: CHEST_WIDTHS },
  { key: "front", label: "Full front", widths: FRONT_WIDTHS },
  { key: "back", label: "Full back", widths: BACK_WIDTHS },
];

class QuoteInputError extends Error {}

function parseStructured(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    throw new QuoteInputError("Invalid pricing request.");
  }
}

function normalizePrints(submittedPrints) {
  if (!Array.isArray(submittedPrints) || submittedPrints.length < 1) {
    throw new QuoteInputError("Select at least one print placement.");
  }

  const seenPrints = new Set();
  return submittedPrints.map((print) => {
    const key = String(print?.key || "");
    const rule = PLACEMENT_RULES.find((item) => item.key === key);

    if (!rule) throw new QuoteInputError("One of the selected print placements is invalid.");
    if (seenPrints.has(key)) throw new QuoteInputError(`Duplicate print placement: ${rule.label}.`);
    seenPrints.add(key);

    const width = String(print?.width || "");
    if (!rule.widths.includes(width)) {
      throw new QuoteInputError(`Invalid print size for ${rule.label}.`);
    }

    return { key: rule.key, label: rule.label, width };
  });
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

export const action = async ({ request }) => {
  try {
    await authenticate.public.appProxy(request);

    const contentType = request.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await request.json() : await request.formData();
    const get = (key) => (isJson ? payload?.[key] : payload.get(key));

    const garment = String(get("garment") || "PC450").trim();
    const color = String(get("color") || "Athletic Heather").trim();
    const sizes = parseStructured(get("sizes"), {});
    const submittedPrints = parseStructured(get("prints"), []);

    if (!sizes || typeof sizes !== "object" || Array.isArray(sizes)) {
      throw new QuoteInputError("Sizes are required.");
    }

    const prints = normalizePrints(submittedPrints);

    let quote;
    try {
      quote = calculateOrder({ sizes, prints, garment, color, markup: 2 });
    } catch (error) {
      throw new QuoteInputError(
        error instanceof Error ? error.message : "Invalid pricing request.",
      );
    }

    return Response.json(
      { ok: true, pricing: pricingPayload(quote) },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    console.error("APP PROXY QUOTE ERROR:", error);
    const message = error instanceof QuoteInputError
      ? error.message
      : "We couldn’t calculate your estimate. Please try again.";

    return Response.json(
      { ok: false, error: message },
      {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
};
