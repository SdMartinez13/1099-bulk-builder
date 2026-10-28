export const ENGRAVING_BULK_TIERS = Object.freeze([
  Object.freeze({ minQuantity: 24, percent: 25, label: "24+ items" }),
  Object.freeze({ minQuantity: 10, percent: 20, label: "10–23 items" }),
  Object.freeze({ minQuantity: 6, percent: 10, label: "6–9 items" }),
]);

export function getEngravingBulkDiscount(quantity) {
  const normalizedQuantity = Number.parseInt(String(quantity ?? "0"), 10);
  if (!Number.isInteger(normalizedQuantity) || normalizedQuantity < 1) return null;

  const tier = ENGRAVING_BULK_TIERS.find(
    ({ minQuantity }) => normalizedQuantity >= minQuantity,
  );

  if (!tier) return null;

  return {
    percent: tier.percent,
    label: tier.label,
    title: `Bulk Engraving — ${tier.percent}% off`,
    description: `${tier.percent}% bulk engraving discount for ${tier.label}`,
  };
}
