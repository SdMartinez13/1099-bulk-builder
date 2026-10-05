import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import {
  calculateOrder,
  GARMENTS,
  SIZES,
  FRONT_WIDTHS,
  BACK_WIDTHS,
  CHEST_WIDTHS,
} from "../garment-config";

export const loader = async () => null;

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
    const sizes = JSON.parse(String(form.get("sizes") || "{}"));
    const prints = JSON.parse(String(form.get("prints") || "[]"));

    const quote = calculateOrder({ sizes, prints, garment, color, markup: 2 });
    const sizeText = Object.entries(quote.sizes).map(([size, qty]) => `${size}: ${qty}`).join(", ");

    const artworkSlots = [
      { key: "front", label: "Full front", field: "artwork_front" },
      { key: "chest", label: "Chest", field: "artwork_chest" },
      { key: "back", label: "Back", field: "artwork_back" },
    ];
    const uploadedArtwork = [];
    for (const slot of artworkSlots) {
      const file = form.get(slot.field);
      if (file && typeof file !== "string" && file.size > 0) {
        const uploaded = await uploadArtworkFile(admin, file, slot.label);
        uploadedArtwork.push({ ...slot, ...uploaded });
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

    const response = await admin.graphql(`#graphql
      mutation Create1099DraftOrder($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name totalPriceSet { shopMoney { amount currencyCode } } invoiceUrl }
          userErrors { field message }
        }
      }`, {
      variables: {
        input: {
          lineItems: [{
            title: "1099 Designs Custom Apparel Order",
            quantity: 1,
            originalUnitPriceWithCurrency: { amount: quote.total.toFixed(2), currencyCode: "USD" },
            customAttributes: [
              { key: "Garment", value: GARMENTS[garment].label },
              { key: "Color", value: color },
              { key: "Sizes", value: sizeText },
              ...printAttributes,
              { key: "Total garments", value: String(quote.quantity) },
              { key: "Garments subtotal", value: `$${quote.garments.toFixed(2)}` },
              { key: "DTF printing", value: `$${quote.dtf.toFixed(2)}` },
              { key: "DTF tier", value: quote.tier },
              ...artworkAttributes,
            ],
          }],
          note: "1099 Designs bulk apparel order — server-calculated pricing",
          ...(uploadedArtwork.length
            ? { metafields: uploadedArtwork.map((a) => ({ namespace: "1099_design", key: `artwork_${a.key}`, type: "file_reference", value: a.id })) }
            : {}),
        },
      },
    });

    const json = await response.json();
    const result = json.data?.draftOrderCreate;
    if (result?.userErrors?.length) return Response.json({ ok: false, errors: result.userErrors }, { status: 400 });
    if (!result?.draftOrder) throw new Error("Shopify did not create the Draft Order.");
    console.log("1099 CHECKOUT CREATED", JSON.stringify({
      name: result.draftOrder.name,
      invoiceUrl: result.draftOrder.invoiceUrl,
      total: result.draftOrder.totalPriceSet?.shopMoney?.amount
    }));

    return new Response(JSON.stringify({
      ok: true,
      invoiceUrl: result.draftOrder.invoiceUrl,
      draftOrder: result.draftOrder,
      pricing: {
        quantity: quote.quantity,
        garments: quote.garments.toFixed(2),
        dtf: quote.dtf.toFixed(2),
        total: quote.total.toFixed(2),
        tier: quote.tier,
        prints: quote.prints.map((p) => ({ label: p.label, width: p.width, rate: p.rate.toFixed(2), subtotal: p.subtotal.toFixed(2) })),
      },
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      },
    });
  } catch (error) {
    console.error("APP PROXY DRAFT ORDER ERROR:", error);
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Unable to create order." }, { status: 400 });
  }
};

const money = (value) => `$${value.toFixed(2)}`;

const selectStyle = { width: "100%", padding: 13, marginTop: 7, background: "#191919", color: "#fff", border: "1px solid #3a3a3a", borderRadius: 9 };
const fieldLabelStyle = { display: "block", color: "#a3a3a3", fontSize: 13, fontWeight: 700 };

const PLACEMENT_DEFS = [
  { key: "front", label: "Full front", widths: FRONT_WIDTHS, note: "Up to 13 in wide" },
  { key: "chest", label: "Left / Right chest", widths: CHEST_WIDTHS, sides: ["Left", "Right"], note: "2.5–4 in" },
  { key: "back", label: "Full back", widths: BACK_WIDTHS, note: "Up to 13 in wide" },
];

export default function BulkBuilder() {
  const fetcher = useFetcher();
  const [garment, setGarment] = useState("PC450");
  const [color, setColor] = useState("Athletic Heather");
  const [sizes, setSizes] = useState(Object.fromEntries(SIZES.map((size) => [size, 0])));
  const [prints, setPrints] = useState({
    front: { enabled: false, width: "" },
    chest: { enabled: false, width: "", side: "Left" },
    back: { enabled: false, width: "" },
  });
  const [fileNames, setFileNames] = useState({ front: "", chest: "", back: "" });

  const config = GARMENTS[garment];
  const colors = config.colors;

  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data?.invoiceUrl) {
      window.location.assign(fetcher.data.invoiceUrl);
    }
  }, [fetcher.data]);

  const garmentCount = useMemo(
    () => Object.values(sizes).reduce((sum, q) => sum + Math.max(0, Math.floor(Number(q) || 0)), 0),
    [sizes]
  );

  const activePrints = useMemo(() => {
    const list = [];
    if (prints.front.enabled && prints.front.width) list.push({ key: "front", label: "Full front", width: prints.front.width });
    if (prints.chest.enabled && prints.chest.width) list.push({ key: "chest", label: `${prints.chest.side} chest`, width: prints.chest.width });
    if (prints.back.enabled && prints.back.width) list.push({ key: "back", label: "Full back", width: prints.back.width });
    return list;
  }, [prints]);

  const quote = useMemo(() => {
    try {
      if (activePrints.length < 1) throw new Error("no prints selected");
      return calculateOrder({ sizes, prints: activePrints, garment, color, markup: 2 });
    } catch {
      return { quantity: 0, garments: 0, dtf: 0, total: 0, tier: "1–9", prints: [] };
    }
  }, [sizes, garment, color, activePrints]);

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

  const submit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("sizes", JSON.stringify(sizes));
    fd.set("prints", JSON.stringify(activePrints));
    const action = `/apps/1099-builder${window.location.search}`;
    fetcher.submit(fd, { method: "post", action, encType: "multipart/form-data" });
  };

  const canSubmit = garmentCount >= 1 && activePrints.length >= 1 && fetcher.state === "idle";

  return (
    <main style={{ minHeight: "100vh", background: "#0a0a0a", color: "#f5f5f5", fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif", padding: "40px 20px 70px" }}>
      <div style={{ maxWidth: 1040, margin: "0 auto" }}>
        <header style={{ marginBottom: 34 }}>
          <div style={{ color: "#ef233c", fontSize: 12, letterSpacing: 3, fontWeight: 900 }}>1099 DESIGNS / CUSTOM APPAREL</div>
          <h1 style={{ fontSize: "clamp(34px, 6vw, 58px)", lineHeight: 1.02, margin: "10px 0 12px", letterSpacing: -2 }}>Build Your Bulk Order</h1>
          <p style={{ margin: 0, color: "#a3a3a3", fontSize: 16 }}>Choose your blank, build your size breakdown, add your prints with artwork, and get your price instantly.</p>
        </header>

        {fetcher.data?.ok ? (
          <section style={{ padding: 30, border: "1px solid #22c55e", borderRadius: 16, background: "#0d1b12" }}>
            <div style={{ color: "#4ade80", fontSize: 12, letterSpacing: 2, fontWeight: 800 }}>ORDER READY</div>
            <h2 style={{ fontSize: 30, margin: "8px 0" }}>Order created ✓</h2>
            <p style={{ color: "#d4d4d4" }}><strong>{fetcher.data.draftOrder?.name}</strong> · {fetcher.data.pricing?.quantity} garments · {money(Number(fetcher.data.pricing?.total || 0))}</p>
            {fetcher.data.pricing?.prints?.length > 0 && (
              <p style={{ color: "#a3a3a3", fontSize: 14 }}>
                {fetcher.data.pricing.prints.map((p) => `${p.label} (${p.width}")`).join(" · ")}
              </p>
            )}
            {fetcher.data.draftOrder?.invoiceUrl && <a href={fetcher.data.draftOrder.invoiceUrl} style={{ display: "inline-block", marginTop: 10, padding: "12px 18px", borderRadius: 9, background: "#f5f5f5", color: "#111", textDecoration: "none", fontWeight: 800 }}>Continue to invoice →</a>}
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
                    {colors.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
              </div>
            </section>

            <section style={{ marginTop: 16, padding: 22, border: "1px solid #292929", borderRadius: 16, background: "#111" }}>
              <div style={{ color: "#ef233c", fontSize: 12, fontWeight: 900 }}>02</div>
              <h2 style={{ margin: "7px 0 6px", fontSize: 25 }}>Print placements</h2>
              <p style={{ color: "#737373", fontSize: 13, margin: "0 0 18px" }}>Add up to three prints — each with its own size and artwork. Leave a placement off to skip it.</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(270px,1fr))", gap: 12 }}>
                {PLACEMENT_DEFS.map((def) => {
                  const state = prints[def.key];
                  return (
                    <div key={def.key} style={{ padding: 18, border: `1px solid ${state.enabled ? "#ef233c" : "#2b2b2b"}`, borderRadius: 12, background: "#161616" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800, fontSize: 15, cursor: "pointer" }}>
                        <input type="checkbox" checked={state.enabled} onChange={(e) => updatePrint(def.key, { enabled: e.target.checked })} style={{ width: 18, height: 18, accentColor: "#ef233c" }} />
                        {def.label}
                      </label>
                      <div style={{ color: "#737373", fontSize: 12, margin: "6px 0 0 28px" }}>{def.note}</div>
                      {state.enabled && (
                        <div style={{ marginTop: 12 }}>
                          {def.sides && (
                            <label style={fieldLabelStyle}>Side
                              <select value={state.side} onChange={(e) => updatePrint(def.key, { side: e.target.value })} style={selectStyle}>
                                {def.sides.map((s) => <option key={s}>{s}</option>)}
                              </select>
                            </label>
                          )}
                          <label style={{ ...fieldLabelStyle, marginTop: def.sides ? 12 : 0 }}>Print size
                            <select value={state.width} onChange={(e) => updatePrint(def.key, { width: e.target.value })} style={selectStyle}>
                              <option value="">Choose size…</option>
                              {def.widths.map((w) => <option key={w} value={w}>{w} in</option>)}
                            </select>
                          </label>
                          <label style={{ ...fieldLabelStyle, marginTop: 12 }}>Artwork
                            <input name={`artwork_${def.key}`} type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFileNames((f) => ({ ...f, [def.key]: e.target.files?.[0]?.name || "" }))} style={{ width: "100%", padding: 12, boxSizing: "border-box", background: "#191919", color: "#ddd", border: "1px dashed #555", borderRadius: 9, marginTop: 7 }} />
                          </label>
                          <p style={{ color: "#737373", fontSize: 12, marginBottom: 0 }}>{fileNames[def.key] ? `Selected: ${fileNames[def.key]}` : "PNG, JPG, or WebP. Transparent PNG recommended."}</p>
                          {!state.width && <p style={{ color: "#f59e0b", fontSize: 12, fontWeight: 700, marginBottom: 0 }}>Pick a size to include this print in your price.</p>}
                        </div>
                      )}
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
              <div style={{ marginTop: 16, paddingTop: 15, borderTop: "1px solid #292929", color: "#a3a3a3" }}><strong style={{ color: "#fff" }}>{garmentCount}</strong> total garments · current DTF tier <strong style={{ color: "#fff" }}>{quote.tier}</strong></div>
            </section>

            <section style={{ marginTop: 16, padding: 24, borderRadius: 16, background: "#f5f5f5", color: "#111" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 22, alignItems: "end" }}>
                <div><div style={{ color: "#737373", fontSize: 11, letterSpacing: 2, fontWeight: 900 }}>ESTIMATED TOTAL</div><div style={{ fontSize: 44, lineHeight: 1.05, fontWeight: 900, letterSpacing: -1 }}>{money(quote.total)}</div><div style={{ color: "#737373", marginTop: 7 }}>{garmentCount} garments{quote.prints.length > 0 && ` · ${quote.prints.length} print${quote.prints.length === 1 ? "" : "s"} (${quote.prints.map((p) => p.label).join(", ")})`}</div></div>
                <div style={{ fontSize: 13, color: "#525252", lineHeight: 1.7 }}>
                  <div>Garments: <strong>{money(quote.garments)}</strong></div>
                  {quote.prints.map((p) => (
                    <div key={p.key}>{p.label} ({p.width}"): <strong>{money(p.subtotal)}</strong> <span style={{ color: "#737373" }}>@ {money(p.rate)}/print</span></div>
                  ))}
                  <div>DTF total: <strong>{money(quote.dtf)}</strong></div>
                  <div>Tier: <strong>{quote.tier}</strong></div>
                </div>
                <button type="submit" disabled={!canSubmit} style={{ width: "100%", padding: "15px 20px", border: 0, borderRadius: 9, background: "#111", color: "#fff", fontWeight: 900, fontSize: 15, cursor: canSubmit ? "pointer" : "not-allowed", opacity: canSubmit ? 1 : .45 }}>{fetcher.state === "idle" ? "Create Order →" : "Creating…"}</button>
              </div>
              {activePrints.length < 1 && garmentCount >= 1 && <div style={{ marginTop: 16, padding: 13, borderRadius: 9, background: "#fef3c7", color: "#92400e", fontWeight: 700 }}>Add at least one print placement above to price your order.</div>}
              {fetcher.data && !fetcher.data.ok && <div style={{ marginTop: 16, padding: 13, borderRadius: 9, background: "#fee2e2", color: "#991b1b", fontWeight: 700 }}>{fetcher.data.error || fetcher.data.errors?.map((e) => e.message).join("; ")}</div>}
            </section>
          </form>
        )}
      </div>
    </main>
  );
}
