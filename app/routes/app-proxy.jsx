import { useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { calculateOrder, GARMENTS, PRINT_WIDTHS, SIZES } from "../garment-config";

export const loader = async () => null;

export const action = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.public.appProxy(request);
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
    const printLocation = String(form.get("printLocation") || "Front");
    const printWidth = String(form.get("printWidth") || "4");
    const sizes = JSON.parse(String(form.get("sizes") || "{}"));
    const artwork = form.get("artwork");

    const quote = calculateOrder({ sizes, printWidth, printLocation, garment, color, markup: 2 });
    const sizeText = Object.entries(quote.sizes).map(([size, qty]) => `${size}: ${qty}`).join(", ");

    let artworkFileId = null;
    let artworkFileUrl = null;
    if (artwork && typeof artwork !== "string" && artwork.size > 0) {
      const stagedResponse = await admin.graphql(`#graphql
        mutation Stage1099Artwork($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { field message }
          }
        }`, {
        variables: { input: [{ filename: artwork.name, mimeType: artwork.type || "application/octet-stream", httpMethod: "POST", resource: "FILE" }] },
      });
      const staged = (await stagedResponse.json())?.data?.stagedUploadsCreate;
      if (staged?.userErrors?.length) throw new Error(staged.userErrors.map((e) => e.message).join("; "));
      const target = staged?.stagedTargets?.[0];
      if (!target?.url || !target?.resourceUrl) throw new Error("Shopify did not return an artwork upload target.");

      const uploadForm = new FormData();
      for (const p of target.parameters || []) uploadForm.append(p.name, p.value);
      uploadForm.append("file", artwork, artwork.name);
      const upload = await fetch(target.url, { method: "POST", body: uploadForm });
      if (!upload.ok) throw new Error(`Shopify artwork upload failed (${upload.status}).`);

      const fileResponse = await admin.graphql(`#graphql
        mutation Create1099Artwork($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files { id fileStatus ... on GenericFile { url } }
            userErrors { field message }
          }
        }`, {
        variables: { files: [{ filename: artwork.name, contentType: "FILE", duplicateResolutionMode: "APPEND_UUID", originalSource: target.resourceUrl, alt: `1099 Designs artwork - ${artwork.name}` }] },
      });
      const filePayload = (await fileResponse.json())?.data?.fileCreate;
      if (filePayload?.userErrors?.length) throw new Error(filePayload.userErrors.map((e) => e.message).join("; "));
      const created = filePayload?.files?.[0];
      if (!created?.id) throw new Error("Shopify did not return the created artwork file.");
      artworkFileId = created.id;
      artworkFileUrl = created.url || null;
    }

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
              { key: "Print location", value: printLocation },
              { key: "Print width", value: `${printWidth} in` },
              { key: "Total garments", value: String(quote.quantity) },
              { key: "Garments subtotal", value: `$${quote.garments.toFixed(2)}` },
              { key: "DTF printing", value: `$${quote.dtf.toFixed(2)}` },
              { key: "DTF prints per garment", value: String(quote.printsPerGarment) },
              { key: "DTF tier", value: `${quote.tier} @ $${quote.rate.toFixed(2)}/print` },
              ...(artworkFileId ? [{ key: "Artwork file ID", value: artworkFileId }] : []),
              ...(artworkFileUrl ? [{ key: "Artwork URL", value: artworkFileUrl }] : []),
              ...(artworkFileId ? [{ key: "Artwork filename", value: artwork.name }] : []),
            ],
          }],
          note: "1099 Designs bulk apparel order — server-calculated pricing",
          ...(artworkFileId ? { metafields: [{ namespace: "1099_design", key: "artwork", type: "file_reference", value: artworkFileId }] } : {}),
        },
      },
    });

    const json = await response.json();
    const result = json.data?.draftOrderCreate;
    if (result?.userErrors?.length) return Response.json({ ok: false, errors: result.userErrors }, { status: 400 });
    if (!result?.draftOrder) throw new Error("Shopify did not create the Draft Order.");

    return new Response(result.draftOrder.invoiceUrl, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });;
  } catch (error) {
    console.error("APP PROXY DRAFT ORDER ERROR:", error);
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Unable to create order." }, { status: 400 });
  }
};

const money = (value) => `$${value.toFixed(2)}`;

export default function BulkBuilder() {
  const fetcher = useFetcher();
  const [garment, setGarment] = useState("PC450");
  const [color, setColor] = useState("Athletic Heather");
  const [location, setLocation] = useState("Front");
  const [width, setWidth] = useState("4");
  const [sizes, setSizes] = useState(Object.fromEntries(SIZES.map((size) => [size, 0])));
  const [fileName, setFileName] = useState("");

  const config = GARMENTS[garment];
  const colors = config.colors;

  const quote = useMemo(() => {
    try {
      return calculateOrder({ sizes, printWidth: width, printLocation: location, garment, color, markup: 2 });
    } catch {
      return { quantity: 0, rate: 0, garments: 0, dtf: 0, total: 0, tier: "1–9", printsPerGarment: location === "Front + Back" ? 2 : 1 };
    }
  }, [sizes, garment, color, width, location]);

  const updateGarment = (next) => {
    setGarment(next);
    setColor(GARMENTS[next].colors[0]);
  };

  const updateSize = (size, value) => {
    const qty = Math.max(0, Math.floor(Number(value) || 0));
    setSizes((current) => ({ ...current, [size]: qty }));
  };

  const submit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("sizes", JSON.stringify(sizes));
    fetcher.submit(fd, { method: "post", action: "/apps/1099-builder", encType: "multipart/form-data" });
  };

  return (
    <main style={{ minHeight: "100vh", background: "#0a0a0a", color: "#f5f5f5", fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif", padding: "40px 20px 70px" }}>
      <div style={{ maxWidth: 1040, margin: "0 auto" }}>
        <header style={{ marginBottom: 34 }}>
          <div style={{ color: "#ef233c", fontSize: 12, letterSpacing: 3, fontWeight: 900 }}>1099 DESIGNS / CUSTOM APPAREL</div>
          <h1 style={{ fontSize: "clamp(34px, 6vw, 58px)", lineHeight: 1.02, margin: "10px 0 12px", letterSpacing: -2 }}>Build Your Bulk Order</h1>
          <p style={{ margin: 0, color: "#a3a3a3", fontSize: 16 }}>Choose your blank, build your size breakdown, upload your artwork, and get your price instantly.</p>
        </header>

        {fetcher.data?.ok ? (
          <section style={{ padding: 30, border: "1px solid #22c55e", borderRadius: 16, background: "#0d1b12" }}>
            <div style={{ color: "#4ade80", fontSize: 12, letterSpacing: 2, fontWeight: 800 }}>ORDER READY</div>
            <h2 style={{ fontSize: 30, margin: "8px 0" }}>Order created ✓</h2>
            <p style={{ color: "#d4d4d4" }}><strong>{fetcher.data.draftOrder?.name}</strong> · {fetcher.data.pricing?.quantity} garments · {money(Number(fetcher.data.pricing?.total || 0))}</p>
            {fetcher.data.draftOrder?.invoiceUrl && <a href={fetcher.data.draftOrder.invoiceUrl} style={{ display: "inline-block", marginTop: 10, padding: "12px 18px", borderRadius: 9, background: "#f5f5f5", color: "#111", textDecoration: "none", fontWeight: 800 }}>Continue to invoice →</a>}
          </section>
        ) : (
          <form onSubmit={submit} encType="multipart/form-data">
            <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16 }}>
              <div style={{ padding: 22, border: "1px solid #292929", borderRadius: 16, background: "#111" }}>
                <div style={{ color: "#ef233c", fontSize: 12, fontWeight: 900 }}>01</div>
                <h2 style={{ margin: "7px 0 18px", fontSize: 25 }}>Choose your garment</h2>
                <label style={{ display: "block", color: "#a3a3a3", fontSize: 13, fontWeight: 700 }}>Style
                  <select name="garment" value={garment} onChange={(e) => updateGarment(e.target.value)} style={{ width: "100%", padding: 13, marginTop: 7, background: "#191919", color: "#fff", border: "1px solid #3a3a3a", borderRadius: 9 }}>
                    {Object.entries(GARMENTS).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
                  </select>
                </label>
                <label style={{ display: "block", marginTop: 15, color: "#a3a3a3", fontSize: 13, fontWeight: 700 }}>Color
                  <select name="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: "100%", padding: 13, marginTop: 7, background: "#191919", color: "#fff", border: "1px solid #3a3a3a", borderRadius: 9 }}>
                    {colors.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
              </div>

              <div style={{ padding: 22, border: "1px solid #292929", borderRadius: 16, background: "#111" }}>
                <div style={{ color: "#ef233c", fontSize: 12, fontWeight: 900 }}>02</div>
                <h2 style={{ margin: "7px 0 18px", fontSize: 25 }}>Print setup</h2>
                <label style={{ display: "block", color: "#a3a3a3", fontSize: 13, fontWeight: 700 }}>Location
                  <select name="printLocation" value={location} onChange={(e) => setLocation(e.target.value)} style={{ width: "100%", padding: 13, marginTop: 7, background: "#191919", color: "#fff", border: "1px solid #3a3a3a", borderRadius: 9 }}>
                    <option>Front</option><option>Back</option><option>Front + Back</option>
                  </select>
                </label>
                <label style={{ display: "block", marginTop: 15, color: "#a3a3a3", fontSize: 13, fontWeight: 700 }}>Print width
                  <select name="printWidth" value={width} onChange={(e) => setWidth(e.target.value)} style={{ width: "100%", padding: 13, marginTop: 7, background: "#191919", color: "#fff", border: "1px solid #3a3a3a", borderRadius: 9 }}>
                    {PRINT_WIDTHS.map((w) => <option key={w} value={w}>{w} in</option>)}
                  </select>
                </label>
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
              <div style={{ marginTop: 16, paddingTop: 15, borderTop: "1px solid #292929", color: "#a3a3a3" }}><strong style={{ color: "#fff" }}>{quote.quantity}</strong> total garments · current DTF tier <strong style={{ color: "#fff" }}>{quote.tier}</strong></div>
            </section>

            <section style={{ marginTop: 16, padding: 22, border: "1px solid #292929", borderRadius: 16, background: "#111" }}>
              <div style={{ color: "#ef233c", fontSize: 12, fontWeight: 900 }}>04</div>
              <h2 style={{ margin: "7px 0 18px", fontSize: 25 }}>Upload artwork</h2>
              <input name="artwork" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFileName(e.target.files?.[0]?.name || "")} style={{ width: "100%", padding: 12, boxSizing: "border-box", background: "#191919", color: "#ddd", border: "1px dashed #555", borderRadius: 9 }} />
              <p style={{ color: "#737373", fontSize: 13, marginBottom: 0 }}>{fileName ? `Selected: ${fileName}` : "PNG, JPG, or WebP. Transparent PNG recommended."}</p>
            </section>

            <section style={{ marginTop: 16, padding: 24, borderRadius: 16, background: "#f5f5f5", color: "#111" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 22, alignItems: "end" }}>
                <div><div style={{ color: "#737373", fontSize: 11, letterSpacing: 2, fontWeight: 900 }}>ESTIMATED TOTAL</div><div style={{ fontSize: 44, lineHeight: 1.05, fontWeight: 900, letterSpacing: -1 }}>{money(quote.total)}</div><div style={{ color: "#737373", marginTop: 7 }}>{quote.quantity} garments · {quote.printsPerGarment} print{quote.printsPerGarment === 1 ? "" : "s"}/garment · {money(quote.rate)}/print</div></div>
                <div style={{ fontSize: 13, color: "#525252", lineHeight: 1.7 }}><div>Garments: <strong>{money(quote.garments)}</strong></div><div>DTF: <strong>{money(quote.dtf)}</strong></div><div>Tier: <strong>{quote.tier}</strong></div></div>
                <button type="submit" disabled={quote.quantity < 1 || fetcher.state !== "idle"} style={{ width: "100%", padding: "15px 20px", border: 0, borderRadius: 9, background: "#111", color: "#fff", fontWeight: 900, fontSize: 15, cursor: quote.quantity < 1 ? "not-allowed" : "pointer", opacity: quote.quantity < 1 ? .45 : 1 }}>{fetcher.state === "idle" ? "Create Order →" : "Creating…"}</button>
              </div>
              {fetcher.data && !fetcher.data.ok && <div style={{ marginTop: 16, padding: 13, borderRadius: 9, background: "#fee2e2", color: "#991b1b", fontWeight: 700 }}>{fetcher.data.error || fetcher.data.errors?.map((e) => e.message).join("; ")}</div>}
            </section>
          </form>
        )}
      </div>
    </main>
  );
}
