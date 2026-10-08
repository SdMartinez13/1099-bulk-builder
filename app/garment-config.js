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
export const SMALL_RUN_MAX_QUANTITY = 11;
export const SMALL_RUN_MINIMUM = 75;

// Width options per placement. Capped at 13" for the A3+ film on the
// modified Epson 8550 DTF setup.
export const FRONT_WIDTHS = PRINT_WIDTHS.filter((w) => Number(w) <= 13);
export const BACK_WIDTHS = PRINT_WIDTHS.filter((w) => Number(w) <= 13);
export const CHEST_WIDTHS = ["2.5", "3", "3.5", "4"];

// Hobby Lobby after-tax internal costs include the current shelf price plus
// the 10.4% local sales-tax assumption used for 1099 Designs sourcing.
const TEE_COSTS = {
  S: 3.78,
  M: 3.78,
  L: 3.78,
  XL: 3.78,
  "2XL": 5.73,
  "3XL": 5.73,
  "4XL": 6.17,
};

const HOODIE_COSTS = {
  S: 15.89,
  M: 15.89,
  L: 15.89,
  XL: 15.89,
  "2XL": 17.65,
  "3XL": 23.84,
};

const CREWNECK_COSTS = {
  S: 14.12,
  M: 14.12,
  L: 14.12,
  XL: 14.12,
  "2XL": 15.89,
  "3XL": 17.65,
};

// BulkApparel PC450 baseline checked 2026-10-08. These are after-tax
// internal costs using the same 10.4% local sales-tax assumption.
// White is publicly priced through 4XL. BulkApparel publicly exposes the
// color price only for S-XL, so colored 2XL-4XL are intentionally omitted
// until those exact prices are verified rather than guessed.
const PC450_WHITE_COSTS = {
  S: 5.50,
  M: 5.50,
  L: 5.50,
  XL: 5.50,
  "2XL": 8.17,
  "3XL": 10.07,
  "4XL": 10.07,
};

const PC450_COLOR_COSTS = {
  S: 6.01,
  M: 6.01,
  L: 6.01,
  XL: 6.01,
};

const PC450_COLORS = [
  "Light Blue",
  "True Royal",
  "Athletic Heather",
  "White",
  "Yellow",
  "Orange",
  "Bright Red",
  "Pro Kelly Green",
  "Team Purple",
  "Jet Black",
  "Deep Navy",
  "Candy Pink",
  "Forest Green",
];

const SWEATSHIRT_SIZES = ["S", "M", "L", "XL", "2XL", "3XL"];

export const GARMENTS = {
  PC450: {
    label: "Port & Company Fan Favorite Tee (PC450)",
    sizes: SIZES,
    colors: PC450_COLORS,
    costs: Object.fromEntries(
      PC450_COLORS.map((color) => [
        color,
        color === "White" ? PC450_WHITE_COSTS : PC450_COLOR_COSTS,
      ]),
    ),
  },
  G5000: {
    label: "Gildan Heavy Cotton T-Shirt (G5000)",
    sizes: SIZES,
    colors: [
      "Sky",
      "Royal",
      "Sport Gray",
      "White",
      "Daisy",
      "Orange",
      "Heliconia",
      "Red",
      "Irish Green",
      "Purple",
      "Black",
      "Navy",
      "Sand",
      "Light Pink",
      "Sage",
      "Violet",
      "Forest Green",
    ],
    costs: {
      Sky: TEE_COSTS,
      Royal: TEE_COSTS,
      "Sport Gray": TEE_COSTS,
      White: TEE_COSTS,
      Daisy: TEE_COSTS,
      Orange: TEE_COSTS,
      Heliconia: TEE_COSTS,
      Red: TEE_COSTS,
      "Irish Green": TEE_COSTS,
      Purple: TEE_COSTS,
      Black: TEE_COSTS,
      Navy: TEE_COSTS,
      Sand: TEE_COSTS,
      "Light Pink": TEE_COSTS,
      Sage: TEE_COSTS,
      Violet: TEE_COSTS,
      "Forest Green": TEE_COSTS,
    },
  },
  G18500: {
    label: "Gildan Heavy Blend Hoodie (18500)",
    sizes: SWEATSHIRT_SIZES,
    colors: ["White", "Black", "Sport Gray", "Red", "Light Pink", "Sand"],
    costs: {
      White: HOODIE_COSTS,
      Black: HOODIE_COSTS,
      "Sport Gray": HOODIE_COSTS,
      Red: HOODIE_COSTS,
      "Light Pink": HOODIE_COSTS,
      Sand: HOODIE_COSTS,
    },
  },
  G18000: {
    label: "Gildan Heavy Blend Crewneck Sweatshirt (18000)",
    sizes: SWEATSHIRT_SIZES,
    colors: ["White", "Black", "Sport Gray", "Red", "Light Pink", "Sand"],
    costs: {
      White: CREWNECK_COSTS,
      Black: CREWNECK_COSTS,
      "Sport Gray": CREWNECK_COSTS,
      Red: CREWNECK_COSTS,
      "Light Pink": CREWNECK_COSTS,
      Sand: CREWNECK_COSTS,
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

export function calculateOrder({ sizes, prints, printWidth, printLocation = "Front", garment = "PC450", color = "Athletic Heather", markup = 2 }) {
  if (!sizes || typeof sizes !== "object") throw new Error("Sizes are required.");

  const config = GARMENTS[garment];
  const sizeCosts = config?.costs?.[color];
  if (!sizeCosts) throw new Error(`Unsupported garment/color combination: ${garment} / ${color}`);

  let quantity = 0;
  let garments = 0;
  const cleanSizes = {};

  for (const [size, rawQty] of Object.entries(sizes)) {
    const qty = Number(rawQty);
    if (!Number.isInteger(qty) || qty < 0) throw new Error(`Invalid quantity for ${size}`);
    if (qty === 0) continue;
    if (!(size in sizeCosts)) throw new Error(`Invalid size: ${size}`);

    cleanSizes[size] = qty;
    quantity += qty;
    garments += qty * sizeCosts[size] * markup;
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

  const calculatedTotal = garments + dtf;
  const smallRunMinimumApplies = quantity <= SMALL_RUN_MAX_QUANTITY;
  const total = smallRunMinimumApplies ? Math.max(calculatedTotal, SMALL_RUN_MINIMUM) : calculatedTotal;
  const minimumAdjustment = total - calculatedTotal;

  return {
    quantity,
    sizes: cleanSizes,
    garments,
    dtf,
    calculatedTotal,
    total,
    minimumAdjustment,
    smallRunMinimumApplies,
    smallRunMinimum: smallRunMinimumApplies ? SMALL_RUN_MINIMUM : 0,
    tier: tierName,
    prints: printDetails,
    // Backwards-compatible fields for single-print callers:
    rate: printDetails[0]?.rate ?? 0,
    printsPerGarment: printDetails.length,
    printLocation: printDetails.map((p) => p.label).join(" + "),
  };
}
