export const PRINT_WIDTHS = ["1.5", "2", "3", "3.5", "4", "5", "6", "7", "8", "9", "10", "10.5", "11", "12", "13", "14", "15", "16"];

export const DTF_PRICES = {
  "1.5": [1, .8, .65, .55, .45],
  "2": [1.5, 1.2, .98, .83, .68],
  "2.5": [1.75, 1.4, 1.14, 0.97, 0.79],
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

export const SIZES = ["S", "M", "L", "XL", "2XL", "3XL", "4XL"];

// Width options per placement. Capped at 13" for the A3+ film on the
// modified Epson 8550 DTF setup.
export const FRONT_WIDTHS = PRINT_WIDTHS.filter((w) => Number(w) <= 13);
export const BACK_WIDTHS = PRINT_WIDTHS.filter((w) => Number(w) <= 13);
export const CHEST_WIDTHS = ["2.5", "3", "3.5", "4"];

// Blank-cost baseline for the Gildan 18500 hoodie. Centralized so sourcing
// costs can be changed in one place without touching the UI or checkout code.
const HOODIE_COSTS = {
  S: 10.15,
  M: 10.15,
  L: 10.15,
  XL: 10.15,
  "2XL": 12.73,
  "3XL": 15.21,
  "4XL": 15.21,
};

const TEE_COSTS = {
  S: 3,
  M: 3,
  L: 3,
  XL: 3,
  "2XL": 6,
  "3XL": 6,
  "4XL": 7,
};

const PC450_COSTS = {
  S: 2.89,
  M: 2.89,
  L: 2.89,
  XL: 2.89,
  "2XL": 4.58,
  "3XL": 5.97,
  "4XL": 5.97,
};

export const GARMENTS = {
  PC450: {
    label: "PC450 Core Cotton Tee",
    colors: ["Athletic Heather"],
    costs: { "Athletic Heather": PC450_COSTS },
    variantIds: { "Athletic Heather": "gid://shopify/ProductVariant/57401445056678" },
  },
  G5000: {
    label: "Gildan G5000 100% Cotton Tee",
    colors: ["Black", "White", "Blue", "Red", "Gray", "Tan"],
    costs: {
      Black: TEE_COSTS,
      White: TEE_COSTS,
      Blue: TEE_COSTS,
      Red: TEE_COSTS,
      Gray: TEE_COSTS,
      Tan: TEE_COSTS,
    },
    variantIds: {
      Black: "gid://shopify/ProductVariant/57401455444134",
      White: "gid://shopify/ProductVariant/57401455476902",
      Blue: "gid://shopify/ProductVariant/57401455509670",
      Red: "gid://shopify/ProductVariant/57401455542438",
      Gray: "gid://shopify/ProductVariant/57401455575206",
      Tan: "gid://shopify/ProductVariant/57401455607974",
    },
  },
  G18500: {
    label: "Gildan Heavy Blend Hoodie (18500)",
    colors: ["Black", "White", "Gray", "Red", "Tan"],
    costs: {
      Black: HOODIE_COSTS,
      White: HOODIE_COSTS,
      Gray: HOODIE_COSTS,
      Red: HOODIE_COSTS,
      Tan: HOODIE_COSTS,
    },
    variantIds: {
      "Black:S": "gid://shopify/ProductVariant/57409190887590",
      "Black:M": "gid://shopify/ProductVariant/57409190920358",
      "Black:L": "gid://shopify/ProductVariant/57409190953126",
      "Black:XL": "gid://shopify/ProductVariant/57409190985894",
      "Black:2XL": "gid://shopify/ProductVariant/57409191018662",
      "Black:3XL": "gid://shopify/ProductVariant/57409191051430",
      "Black:4XL": "gid://shopify/ProductVariant/57409191084198",
      "White:S": "gid://shopify/ProductVariant/57409191116966",
      "White:M": "gid://shopify/ProductVariant/57409191149734",
      "White:L": "gid://shopify/ProductVariant/57409191182502",
      "White:XL": "gid://shopify/ProductVariant/57409191215270",
      "White:2XL": "gid://shopify/ProductVariant/57409191248038",
      "White:3XL": "gid://shopify/ProductVariant/57409191280806",
      "White:4XL": "gid://shopify/ProductVariant/57409191313574",
      "Gray:S": "gid://shopify/ProductVariant/57409191346342",
      "Gray:M": "gid://shopify/ProductVariant/57409191379110",
      "Gray:L": "gid://shopify/ProductVariant/57409191411878",
      "Gray:XL": "gid://shopify/ProductVariant/57409191444646",
      "Gray:2XL": "gid://shopify/ProductVariant/57409191477414",
      "Gray:3XL": "gid://shopify/ProductVariant/57409191510182",
      "Gray:4XL": "gid://shopify/ProductVariant/57409191542950",
      "Red:S": "gid://shopify/ProductVariant/57409191575718",
      "Red:M": "gid://shopify/ProductVariant/57409191608486",
      "Red:L": "gid://shopify/ProductVariant/57409191641254",
      "Red:XL": "gid://shopify/ProductVariant/57409191674022",
      "Red:2XL": "gid://shopify/ProductVariant/57409191706790",
      "Red:3XL": "gid://shopify/ProductVariant/57409191739558",
      "Red:4XL": "gid://shopify/ProductVariant/57409191772326",
      "Tan:S": "gid://shopify/ProductVariant/57409191805094",
      "Tan:M": "gid://shopify/ProductVariant/57409191837862",
      "Tan:L": "gid://shopify/ProductVariant/57409191870630",
      "Tan:XL": "gid://shopify/ProductVariant/57409191903398",
      "Tan:2XL": "gid://shopify/ProductVariant/57409191936166",
      "Tan:3XL": "gid://shopify/ProductVariant/57409191968934",
      "Tan:4XL": "gid://shopify/ProductVariant/57409192001702",
    },
  },
};

export function getTier(quantity) {
  if (quantity >= 250) return [4, "250+"];
  if (quantity >= 100) return [3, "100–249"];
  if (quantity >= 50) return [2, "50–99"];
  if (quantity >= 10) return [1, "10–49"];
  return [0, "1–9"];
}

export function getVariantId(garment, color, sizes = {}) {
  const config = GARMENTS[garment];
  if (!config) return null;
  if (garment !== "G18500") return config.variantIds[color] || null;
  const size = SIZES.find((candidate) => Number(sizes[candidate] || 0) > 0) || "S";
  return config.variantIds[`${color}:${size}`] || null;
}

export function calculateOrder({ sizes, prints, printWidth, printLocation = "Front", garment = "PC450", color = "Athletic Heather", markup = 2 }) {
  if (!sizes || typeof sizes !== "object") throw new Error("Sizes are required.");

  const config = GARMENTS[garment];
  const sizeCosts = config?.costs?.[color];
  if (!sizeCosts) throw new Error(`Unsupported garment/color combination: ${garment} / ${color}`);

  let quantity = 0;
  let garments = 0;
  const cleanSizes = {};

  for (const [size, rawQty] of Object.entries(sizes)) {
    if (!(size in sizeCosts)) throw new Error(`Invalid size: ${size}`);
    const qty = Number(rawQty);
    if (!Number.isInteger(qty) || qty < 0) throw new Error(`Invalid quantity for ${size}`);
    if (qty > 0) {
      cleanSizes[size] = qty;
      quantity += qty;
      garments += qty * sizeCosts[size] * markup;
    }
  }

  if (quantity < 1) throw new Error("Order must contain at least one garment.");

  // Normalize prints. New-style callers pass prints: [{ key, label, width }].
  // Old-style callers pass printWidth/printLocation; convert for compatibility.
  let normalized = prints;
  if (!normalized) {
    const width = String(printWidth);
    normalized = printLocation === "Front + Back"
      ? [{ key: "front", label: "Front", width }, { key: "back", label: "Back", width }]
      : [{ key: "single", label: printLocation, width }];
  }
  if (!Array.isArray(normalized) || normalized.length < 1) {
    throw new Error("Select at least one print placement.");
  }

  const [tierIndex, tierName] = getTier(quantity);
  let dtf = 0;
  const printDetails = normalized.map((p) => {
    const width = String(p.width);
    if (!DTF_PRICES[width]) throw new Error(`Invalid print width: ${width}`);
    const rate = DTF_PRICES[width][tierIndex];
    const subtotal = quantity * rate;
    dtf += subtotal;
    return { key: p.key, label: p.label, width, rate, subtotal };
  });

  return {
    quantity,
    sizes: cleanSizes,
    garments,
    dtf,
    total: garments + dtf,
    tier: tierName,
    prints: printDetails,
    // Backwards-compatible fields for single-print callers:
    rate: printDetails[0]?.rate ?? 0,
    printsPerGarment: printDetails.length,
    printLocation: printDetails.map((p) => p.label).join(" + "),
  };
}
