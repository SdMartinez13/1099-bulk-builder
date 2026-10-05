import { useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import {
  calculateOrder,
  GARMENTS,
  SIZES,
  FRONT_WIDTHS,
  BACK_WIDTHS,
  CHEST_WIDTHS,
  SMALL_RUN_MINIMUM,
} from "../garment-config";

export const loader = async () => null;

const MAX_ARTWORK_BYTES = 25 * 1024 * 1024;
const ALLOWED_ARTWORK_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_ARTWORK_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

const PLACEMENT_RULES = [
  { key: "chest_left", label: "Left chest", field: "artwork_chest_left", widths: CHEST_WIDTHS, note: "2.5–4 in" },
  { key: "chest_right", label: "Right chest", field: "artwork_chest_right", widths: CHEST_WIDTHS, note: "2.5–4 in" },
  { key: "front", label: "Full front", field: "artwork_front", widths: FRONT_WIDTHS, note: "Up to 13 in wide" },
  { key: "back", label: "Full back", field: "artwork_back", widths: BACK_WIDTHS, note: "Up to 13 in wide" },
];

const emailLooksValid = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

class CustomerInputError extends Error {}

function isAllowedArtworkFile(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  return ALLOWED_ARTWORK_TYPES.has(type) || ALLOWED_ARTWORK_EXTENSIONS.some((ext) => name.endsWith(ext));
}

async function uploadArtworkFile(admin, file, label) {
  const stagedResponse = await admin.graphql(`#graphql
    mutation Stage1099Artwork($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`, {
    variables: { input: [{ filename: file.name, mimeType: file.type || "application/octet-stream", httpMethod: "POST", resource: "FILE" }] },
  });
  const staged = (await stagedResponse.json())?.data?.stagedUploadsCreate;
  if (staged?.userErrors?.length) throw new Error(staged.userErrors.map((e) => e.message).join("; "));
  const target = staged?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) throw new Error("Shopify did not return an artwork upload target.");

  const uploadForm = new FormData();
  for (const p of target.parameters || []) uploadForm.append(p.name, p.value);
  uploadForm.append("file", file, file.name);
  const upload = await fetch(target.url, { method: "POST", body: uploadForm });
  if (!upload.ok) throw new Error(`Shopify artwork upload failed (${upload.status}).`);

  const fileResponse = await admin.graphql(`#graphql
    mutation Create1099Artwork($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus ... on GenericFile { url } }
        userErrors { field message }
      }
    }`, {
    variables: { files: [{ filename: file.name, contentType: "FILE", duplicateResolutionMode: "APPEND_UUID", originalSource: target.resourceUrl, alt: `1099 Designs artwork (${label}) - ${file.name}` }] },
  });
  const filePayload = (await fileResponse.json())?.data?.fileCreate;
  if (filePayload?.userErrors?.length) throw new Error(filePayload.userErrors.map((e) => e.message).join("; "));
  const created = filePayload?.files?.[0];
  if (!created?.id) throw new Error("Shopify did not return the created artwork file.");
  return { id: created.id, url: created.url || null, name: file.name };
}

export const action = async ({ request }) => {
  try {
    const { admin } = await authenticate.public.appProxy(request);
    if (!admin) throw new Error("Unable to access Shopify Admin API.");

    const contentType = request.headers.get("content-type") || "";
    let form;
    if (contentType.includes("application/json")) {
      const body = await request.json();
      form = new Map(Object.entries(body || {}));
    } else {
      form = await request.formData();
    }

    const garment = String(form.get("garment") || "PC450").trim();
    const color = String(form.get("color") || "Athletic Heather").trim();
    const customerName = String(form.get("customer_name") || "").trim();
    const customerEmail = String(form.get("customer_email") || "").trim();
    const customerPhone = String(form.get("customer_phone") || "").trim();
    const customerCompany = String(form.get("customer_company") || "").trim();
    const sizes = JSON.parse(String(form.get("sizes") || "{}"));
    const submittedPrints = JSON.parse(String(form.get("prints") || "[]"));

    if (!customerName) throw new CustomerInputError("Please enter your name.");
    if (!emailLooksValid(customerEmail)) throw new CustomerInputError("Please enter a valid email address.");
    if (!Array.isArray(submittedPrints) || submittedPrints.length < 1) throw new CustomerInputError("Select at least one print placement.");

    const seenPrints = new Set();
    const prints = submittedPrints.map((print) => {
      const key = String(print?.key || "");
      const rule = PLACEMENT_RULES.find((item) => item.key === key);
      if (!rule) throw new CustomerInputError("One of the selected print placements is invalid.");
      if (seenPrints.has(key)) throw new CustomerInputError(`Duplicate print placement: ${rule.label}.`);
      seenPrints.add(key);
      const width = String(print?.width || "");
      if (!rule.widths.includes(width)) throw new CustomerInputError(`Invalid print size for ${rule.label}.`);
      return { key: rule.key, label: rule.label, width };
    });

    const artworkByKey = {};
    for (const rule of PLACEMENT_RULES) {
      const file = form.get(rule.field);
      if (file && typeof file !== "string" && file.size > 0) {
        if (file.size > MAX_ARTWORK_BYTES) throw new CustomerInputError(`${rule.label} artwork must be 25 MB or smaller.`);
        if (!isAllowedArtworkFile(file)) throw new CustomerInputError(`${rule.label} artwork must be a PNG, JPG, or WebP file.`);
        artworkByKey[rule.key] = file;
      }
    }

    for (const rule of PLACEMENT_RULES) {
      const selected = seenPrints.has(rule.key);
      const hasArtwork = Boolean(artworkByKey[rule.key]);
      if (selected && !hasArtwork) throw new CustomerInputError(`Please upload artwork for ${rule.label}.`);
      if (!selected && hasArtwork) throw new CustomerInputError(`Choose a print size for ${rule.label}, or remove its artwork.`);
    }

    const quote = calculateOrder({ sizes, prints, garment, color, markup: 2 });
    const sizeText = Object.entries(quote.sizes).map(([size, qty]) => `${size}: ${qty}`).join(", ");

    const uploadedArtwork = [];
    for (const rule of PLACEMENT_RULES) {
      const file = artworkByKey[rule.key];
      if (file) {
        const uploaded = await uploadArtworkFile(admin, file, rule.label);
        uploadedArtwork.push({ ...rule, ...uploaded });
      }
    }

    const printAttributes = quote.prints.flatMap((p) => [
      { key: `${p.label} width`, value: `${p.width} in` },
      { key: `${p.label} print cost`, value: `$${p.subtotal.toFixed(2)} ($${p.rate.toFixed(2)}/print)` },
    ]);
    const artworkAttributes = uploadedArtwork.flatMap((a) => [
      { key: `${a.label} artwork file ID`, value: a.id },
      ...(a.url ? [{ key: `${a.label} artwork URL`, value: a.url }] : []),
      { key: `${a.label} artwork filename`, value: a.name },
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
          draftOrder { id name totalPriceSet { shopMoney { amount currencyCode } } }
          userErrors { field message }
        }
      }`, {
      variables: {
        input: {
          email: customerEmail,
          customAttributes: [
            { key: "Customer name", value: customerName },
            ...(customerPhone ? [{ key: "Phone", value: customerPhone }] : []),
            ...(customerCompany ? [{ key: "Company / Organization", value: customerCompany }] : []),
            { key: "Workflow", value: "Proof required before invoice/payment" },
          ],
          tags: ["1099-builder", "proof-required"],
          lineItems: [{
            title: "1099 Designs Custom Apparel Order",
            quantity: 1,
            requiresShipping: true,
            taxable: true,
            originalUnitPriceWithCurrency: { amount: quote.total.toFixed(2), currencyCode: "USD" },
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
          note: `Proof required before invoicing. Submitted through the 1099 Designs custom apparel builder by ${customerName}.`,
          ...(uploadedArtwork.length
            ? { metafields: uploadedArtwork.map((a) => ({ namespace: "1099_design", key: `artwork_${a.key}`, type: "file_reference", value: a.id })) }
            : {}),
        },
      },
    });

    const json = await response.json();
    const result = json.data?.draftOrderCreate;
    if (result?.userErrors?.length) {
      console.error("SHOPIFY DRAFT ORDER USER ERRORS:", JSON.stringify(result.userErrors));
      return Response.json({ ok: false, error: "We couldn’t submit your order. Please try again." }, { status: 400 });
    }
    if (!result?.draftOrder) throw new Error("Shopify did not create the Draft Order.");

    console.log("1099 PROOF REQUEST CREATED", JSON.stringify({
      name: result.draftOrder.name,
      customerEmail,
      total: result.draftOrder.totalPriceSet?.shopMoney?.amount,
    }));

    return new Response(JSON.stringify({
      ok: true,
      draftOrder: result.draftOrder,
      pricing: {
        quantity: quote.quantity,
        garments: quote.garments.toFixed(2),
        dtf: quote.dtf.toFixed(2),
        calculatedTotal: quote.calculatedTotal.toFixed(2),
        minimumAdjustment: quote.minimumAdjustment.toFixed(2),
        total: quote.total.toFixed(2),
        tier: quote.tier,
        prints: quote.prints.map((p) => ({ label: p.label, width: p.width, rate: p.rate.toFixed(2), subtotal: p.subtotal.toFixed(2) })),
      },
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("APP PROXY DRAFT ORDER ERROR:", error);
    const message = error instanceof CustomerInputError
      ? error.message
      : "We couldn’t submit your order. Please try again.";
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
};

const money = (value) => `$${Number(value || 0).toFixed(2)}`;

const selectStyle = { width: "100%", padding: 13, marginTop: 7, background: "#191919", color: "#fff", border: "1px solid #3a3a3a", borderRadius: 9 };
const inputStyle = { width: "100%", padding: 13, marginTop: 7, boxSizing: "border-box", background: "#191919", color: "#fff", border: "1px solid #3a3a3a", borderRadius: 9 };
const fieldLabelStyle = { display: "block", color: "#a3a3a3", fontSize: 13, fontWeight: 700 };

export default function BulkBuilder() {
  const fetcher = useFetcher();
  const [garment, setGarment] = useState("PC450");
  const [color, setColor] = useState("Athletic Heather");
  const [sizes, setSizes] = useState(Object.fromEntries(SIZES.map((size) => [size, 0])));
  const [prints, setPrints] = useState({
    front: { width: "" },
    chest_left: { width: "" },
    chest_right: { width: "" },
    back: { width: "" },
  });
  const [fileInfo, setFileInfo] = useState({ front: null, chest_left: null, chest_right: null, back: null });
  const [contact, setContact] = useState({ name: "", email: "", phone: "", company: "" });

  const config = GARMENTS[garment];
  const colors = config.colors;

  const garmentCount = useMemo(
    () => Object.values(sizes).reduce((sum, q) => sum + Math.max(0, Math.floor(Number(q) || 0)), 0),
    [sizes]
  );

  const activePrints = useMemo(() => {
    const list = [];
    for (const rule of PLACEMENT_RULES) {
      if (prints[rule.key].width) list.push({ key: rule.key, label: rule.label, width: prints[rule.key].width });
    }
    return list;
  }, [prints]);

  const quote = useMemo(() => {
    try {
      if (activePrints.length < 1) throw new Error("no prints selected");
      return calculateOrder({ sizes, prints: activePrints, garment, color, markup: 2 });
    } catch {
      return {
        quantity: 0,
        garments: 0,
        dtf: 0,
        calculatedTotal: 0,
        total: 0,
        minimumAdjustment: 0,
        smallRunMinimumApplies: false,
        smallRunMinimum: 0,
        tier: "1–9",
        prints: [],
      };
    }
  }, [sizes, garment, color, activePrints]);

  const validationMessages = useMemo(() => {
    const messages = [];
    if (garmentCount < 1) messages.push("Add at least one garment size and quantity.");
    if (activePrints.length < 1) messages.push("Select at least one print placement and size.");
    if (!contact.name.trim()) messages.push("Enter your name.");
    if (!emailLooksValid(contact.email)) messages.push("Enter a valid email address.");

    for (const rule of PLACEMENT_RULES) {
      const widthSelected = Boolean(prints[rule.key].width);
      const file = fileInfo[rule.key];
      if (widthSelected && !file) messages.push(`Upload artwork for ${rule.label}.`);
      if (!widthSelected && file) messages.push(`Choose a print size for ${rule.label}, or remove its artwork.`);
      if (file?.size > MAX_ARTWORK_BYTES) messages.push(`${rule.label} artwork must be 25 MB or smaller.`);
      if (file && !isAllowedArtworkFile(file)) messages.push(`${rule.label} artwork must be PNG, JPG, or WebP.`);
    }

    return messages;
  }, [garmentCount, activePrints, contact, prints, fileInfo]);

  const updateGarment = (next) => {
    setGarment(next);
    setColor(GARMENTS[next].colors[0]);
  };

  const updateSize = (size, value) => {
    const qty = Math.max(0, Math.floor(Number(value) || 0));
    setSizes((current) => ({ ...current, [size]: qty }));
  };

  const updatePrint = (key, patch) =>
    setPrints((current) => ({ ...current, [key]: { ...current[key], ...patch } }));

  const updateContact = (key, value) =>
    setContact((current) => ({ ...current, [key]: value }));

  const submit = (e) => {
    e.preventDefault();
    if (validationMessages.length > 0 || fetcher.state !== "idle") return;
    const fd = new FormData(e.currentTarget);
    fd.set("sizes", JSON.stringify(sizes));
    fd.set("prints", JSON.stringify(activePrints));
    const action = `/apps/1099-builder${window.location.search}`;
    fetcher.submit(fd, { method: "post", action, encType: "multipart/form-data" });
  };

  const canSubmit = validationMessages.length === 0 && fetcher.state === "idle";
  const sizeSummary = Object.entries(sizes).filter(([, qty]) => Number(qty) > 0).map(([size, qty]) => `${size}: ${qty}`).join(" · ");
  const isSmallRun = garmentCount >= 1 && garmentCount <= 11;

  return (
    <main style={{ minHeight: "100vh", background: "#0a0a0a", color: "#f5f5f5", fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif", padding: "40px 20px 70px" }}>
      <div style={{ maxWidth: 1040, margin: "0 auto" }}>
        <header style={{ marginBottom: 34 }}>
          <div style={{ color: "#ef233c", fontSize: 12, letterSpacing: 3, fontWeight: 900 }}>1099 DESIGNS / CUSTOM APPAREL</div>
          <h1 style={{ fontSize: "clamp(34px, 6vw, 58px)", lineHeight: 1.02, margin: "10px 0 12px", letterSpacing: -2 }}>Build Your Custom Apparel Order</h1>
          <p style={{ margin: 0, color: "#a3a3a3", fontSize: 16 }}>Build your order, upload your artwork, and receive an estimated subtotal before submitting for proof.</p>
        </header>

        {fetcher.data?.ok ? (
          <section style={{ padding: 30, border: "1px solid #22c55e", borderRadius: 16, background: "#0d1b12" }}>
            <div style={{ color: "#4ade80", fontSize: 12, letterSpacing: 2, fontWeight: 800 }}>ORDER REQUEST RECEIVED</div>
            <h2 style={{ fontSize: 30, margin: "8px 0" }}>Order Request Received ✓</h2>
            <p style={{ color: "#d4d4d4", lineHeight: 1.7, maxWidth: 760 }}>Thanks! We’ll review your artwork and prepare your proof. Once you approve the proof, we’ll confirm garment availability and send your final invoice with a secure payment link.</p>
            <p style={{ color: "#a3a3a3", marginBottom: 0 }}>
              Reference: <strong style={{ color: "#fff" }}>{fetcher.data.draftOrder?.name}</strong> · {fetcher.data.pricing?.quantity} garments · estimated subtotal {money(fetcher.data.pricing?.total)}
            </p>
            <p style={{ color: "#d4d4d4", margin: "24px 0 12px" }}>While we work on your proof, check out the rest of our stuff.</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
              <a href="/pages/low-morale-apparel" target="_top" style={{ display: "inline-block", padding: "12px 18px", borderRadius: 9, background: "#f5f5f5", color: "#111", textDecoration: "none", fontWeight: 900 }}>Shop Low Morale Apparel →</a>
              <a href="/" target="_top" style={{ color: "#d4d4d4", fontWeight: 800, textDecoration: "underline", textUnderlineOffset: 3 }}>Back to 1099 Designs</a>
            </div>
          </section>
        ) : (
          <form onSubmit={submit} encType="multipart/form-data">
            <section style={{ padding: 22, border: "1px solid #292929", borderRadius: 16, background: "#111" }}>
              <div style={{ color: "#ef233c", fontSize: 12, fontWeight: 900 }}>01</div>
              <h2 style={{ margin: "7px 0 18px", fontSize: 25 }}>Choose your garment</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 16 }}>
                <label style={fieldLabelStyle}>Style
                  <select name="garment" value={garment} onChange={(e) => updateGarment(e.target.value)} style={selectStyle}>
                    {Object.entries(GARMENTS).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
                  </select>
                </label>
                <label style={fieldLabelStyle}>Color
                  <select name="color" value={color} onChange={(e) => setColor(e.target.value)} style={selectStyle}>
                    {colors.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </div>
            </section>

            <section style={{ marginTop: 16, padding: 22, border: "1px solid #292929", borderRadius: 16, background: "#111" }}>
              <div style={{ color: "#ef233c", fontSize: 12, fontWeight: 900 }}>02</div>
              <h2 style={{ margin: "7px 0 6px", fontSize: 25 }}>Print placements</h2>
              <p style={{ color: "#737373", fontSize: 13, margin: "0 0 6px" }}>Add up to four prints — each with its own size and artwork. Leave a placement blank to skip it.</p>
              <p style={{ color: "#a3a3a3", fontSize: 12, margin: "0 0 18px" }}>Left and right chest are based on the wearer’s left and right.</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(270px,1fr))", gap: 12 }}>
                {PLACEMENT_RULES.map((def) => {
                  const state = prints[def.key];
                  const file = fileInfo[def.key];
                  return (
                    <div key={def.key} style={{ padding: 18, border: `1px solid ${state.width ? "#ef233c" : "#2b2b2b"}`, borderRadius: 12, background: "#161616" }}>
                      <div style={{ fontWeight: 800, fontSize: 15 }}>{def.label}</div>
                      <div style={{ color: "#737373", fontSize: 12, margin: "6px 0 0" }}>{def.note}</div>
                      <div style={{ marginTop: 12 }}>
                        <label style={{ ...fieldLabelStyle, marginTop: 0 }}>Print size
                          <select value={state.width} onChange={(e) => updatePrint(def.key, { width: e.target.value })} style={selectStyle}>
                            <option value="">Choose size…</option>
                            {def.widths.map((w) => <option key={w} value={w}>{w} in</option>)}
                          </select>
                        </label>
                        <label style={{ ...fieldLabelStyle, marginTop: 12 }}>Artwork
                          <input
                            name={def.field}
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            onChange={(e) => setFileInfo((current) => ({ ...current, [def.key]: e.target.files?.[0] || null }))}
                            style={{ width: "100%", padding: 12, boxSizing: "border-box", background: "#191919", color: "#ddd", border: "1px dashed #555", borderRadius: 9, marginTop: 7 }}
                          />
                        </label>
                        <p style={{ color: "#737373", fontSize: 12, marginBottom: 0 }}>{file ? `Selected: ${file.name}` : "PNG, JPG, or WebP · 25 MB max · transparent PNG recommended."}</p>
                        {state.width && !file && <p style={{ color: "#f59e0b", fontSize: 12, fontWeight: 700, marginBottom: 0 }}>Artwork is required for this selected placement.</p>}
                        {!state.width && file && <p style={{ color: "#f59e0b", fontSize: 12, fontWeight: 700, marginBottom: 0 }}>Choose a print size to include this artwork.</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section style={{ marginTop: 16, padding: 22, border: "1px solid #292929", borderRadius: 16, background: "#111" }}>
              <div style={{ color: "#ef233c", fontSize: 12, fontWeight: 900 }}>03</div>
              <h2 style={{ margin: "7px 0 18px", fontSize: 25 }}>Sizes & quantities</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(92px,1fr))", gap: 10 }}>
                {SIZES.map((size) => (
                  <label key={size} style={{ color: "#a3a3a3", fontSize: 12, fontWeight: 800 }}>{size}
                    <input name={`size_${size}`} type="number" min="0" step="1" value={sizes[size]} onChange={(e) => updateSize(size, e.target.value)} style={{ display: "block", width: "100%", boxSizing: "border-box", padding: 12, marginTop: 6, background: "#191919", color: "#fff", border: "1px solid #3a3a3a", borderRadius: 9, fontSize: 16 }} />
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 16, paddingTop: 15, borderTop: "1px solid #292929", color: "#a3a3a3" }}>
                <strong style={{ color: "#fff" }}>{garmentCount}</strong> total garments · current DTF tier <strong style={{ color: "#fff" }}>{quote.tier}</strong>
                {isSmallRun && <span> · {money(SMALL_RUN_MINIMUM)} small-run minimum applies</span>}
              </div>
            </section>

            <section style={{ marginTop: 16, padding: 22, border: "1px solid #292929", borderRadius: 16, background: "#111" }}>
              <div style={{ color: "#ef233c", fontSize: 12, fontWeight: 900 }}>04</div>
              <h2 style={{ margin: "7px 0 6px", fontSize: 25 }}>Your information</h2>
              <p style={{ color: "#737373", fontSize: 13, margin: "0 0 18px" }}>We’ll use your email to send your proof and final payment link after approval.</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 16 }}>
                <label style={fieldLabelStyle}>Name *
                  <input name="customer_name" type="text" required value={contact.name} onChange={(e) => updateContact("name", e.target.value)} autoComplete="name" style={inputStyle} />
                </label>
                <label style={fieldLabelStyle}>Email *
                  <input name="customer_email" type="email" required value={contact.email} onChange={(e) => updateContact("email", e.target.value)} autoComplete="email" style={inputStyle} />
                </label>
                <label style={fieldLabelStyle}>Phone
                  <input name="customer_phone" type="tel" value={contact.phone} onChange={(e) => updateContact("phone", e.target.value)} autoComplete="tel" style={inputStyle} />
                </label>
                <label style={fieldLabelStyle}>Company / Organization
                  <input name="customer_company" type="text" value={contact.company} onChange={(e) => updateContact("company", e.target.value)} autoComplete="organization" style={inputStyle} />
                </label>
              </div>
            </section>

            <section style={{ marginTop: 16, padding: 24, borderRadius: 16, background: "#f5f5f5", color: "#111" }}>
              <div style={{ color: "#ef233c", fontSize: 12, fontWeight: 900 }}>05</div>
              <h2 style={{ margin: "7px 0 18px", fontSize: 25 }}>Review your order</h2>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 18 }}>
                <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                  <div><strong>Garment:</strong> {GARMENTS[garment].label}</div>
                  <div><strong>Color:</strong> {color}</div>
                  <div><strong>Quantity:</strong> {garmentCount}</div>
                  <div><strong>Sizes:</strong> {sizeSummary || "None yet"}</div>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                  <div><strong>Prints:</strong> {quote.prints.length || 0}</div>
                  {quote.prints.map((p) => <div key={p.key}>{p.label}: {p.width}"</div>)}
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                  <div><strong>Name:</strong> {contact.name || "—"}</div>
                  <div><strong>Email:</strong> {contact.email || "—"}</div>
                  {contact.phone && <div><strong>Phone:</strong> {contact.phone}</div>}
                  {contact.company && <div><strong>Organization:</strong> {contact.company}</div>}
                </div>
              </div>

              <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid #d4d4d4", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 22, alignItems: "end" }}>
                <div>
                  <div style={{ color: "#737373", fontSize: 11, letterSpacing: 2, fontWeight: 900 }}>ESTIMATED ORDER SUBTOTAL</div>
                  <div style={{ fontSize: 44, lineHeight: 1.05, fontWeight: 900, letterSpacing: -1 }}>{money(quote.total)}</div>
                  <div style={{ color: "#737373", marginTop: 7 }}>Shipping and applicable tax are handled later at payment.</div>
                </div>
                <div style={{ fontSize: 13, color: "#525252", lineHeight: 1.7 }}>
                  <div>Garments: <strong>{money(quote.garments)}</strong></div>
                  {quote.prints.map((p) => (
                    <div key={p.key}>{p.label} ({p.width}"): <strong>{money(p.subtotal)}</strong> <span style={{ color: "#737373" }}>@ {money(p.rate)}/print</span></div>
                  ))}
                  <div>DTF printing: <strong>{money(quote.dtf)}</strong></div>
                  {quote.minimumAdjustment > 0 && (
                    <>
                      <div>Calculated subtotal: <strong>{money(quote.calculatedTotal)}</strong></div>
                      <div>Small-run minimum adjustment: <strong>{money(quote.minimumAdjustment)}</strong></div>
                    </>
                  )}
                  <div>DTF tier: <strong>{quote.tier}</strong></div>
                </div>
                <button type="submit" disabled={!canSubmit} style={{ width: "100%", padding: "15px 20px", border: 0, borderRadius: 9, background: "#111", color: "#fff", fontWeight: 900, fontSize: 15, cursor: canSubmit ? "pointer" : "not-allowed", opacity: canSubmit ? 1 : .45 }}>
                  {fetcher.state === "idle" ? "Submit Order for Proof →" : "Submitting…"}
                </button>
              </div>

              <div style={{ marginTop: 20, padding: 16, borderRadius: 10, background: "#e5e5e5", color: "#404040", fontSize: 12, lineHeight: 1.65 }}>
                <strong>Custom order policy:</strong> Standard custom orders begin at 12 garments. Orders of 1–11 garments are subject to a {money(SMALL_RUN_MINIMUM)} minimum order subtotal. Standard production is 7–10 business days for 12–99 garments and 10–14 business days for 100+ garments. Production begins after proof approval, invoice payment, and garment availability are confirmed. Local pickup and shipping are available. Artwork cleanup fees may apply and will be confirmed before invoicing. Rush service may be available depending on garment availability.
              </div>

              {validationMessages.length > 0 && (
                <div style={{ marginTop: 16, padding: 13, borderRadius: 9, background: "#fef3c7", color: "#92400e", fontWeight: 700 }}>
                  {validationMessages.map((message) => <div key={message}>• {message}</div>)}
                </div>
              )}
              {fetcher.data && !fetcher.data.ok && (
                <div style={{ marginTop: 16, padding: 13, borderRadius: 9, background: "#fee2e2", color: "#991b1b", fontWeight: 700 }}>
                  {fetcher.data.error || "We couldn’t submit your order. Please try again."}
                </div>
              )}
            </section>
          </form>
        )}
      </div>
    </main>
  );
}