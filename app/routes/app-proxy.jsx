import { useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { calculateOrder } from "./api.create-draft-order";

export const loader = async () => null;

export const action = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.public.appProxy(request);
    if (!admin) throw new Error("Unable to access Shopify Admin API.");

    const form = await request.formData();
    const garment = String(form.get("garment") || "PC450").trim();
    const color = String(form.get("color") || "Athletic Heather").trim();
    const printLocation = String(form.get("printLocation") || "Front");
    const printWidth = String(form.get("printWidth") || "4");
    const sizes = JSON.parse(String(form.get("sizes") || "{}"));
    const artwork = form.get("artwork");

    const variants = {
      PC450: { "Athletic Heather": "gid://shopify/ProductVariant/57401445056678" },
      G5000: {
        Black: "gid://shopify/ProductVariant/57401455444134",
        White: "gid://shopify/ProductVariant/57401455476902",
        Blue: "gid://shopify/ProductVariant/57401455509670",
        Red: "gid://shopify/ProductVariant/57401455542438",
        Gray: "gid://shopify/ProductVariant/57401455575206",
        Tan: "gid://shopify/ProductVariant/57401455607974",
      },
    };
    const variantId = variants[garment]?.[color];
    if (!variantId) throw new Error(`Unsupported garment/color combination: ${garment} / ${color}`);

    const quote = calculateOrder({ sizes, printWidth, garment, color, markup: 2 });
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
            variantId,
            quantity: 1,
            priceOverride: { amount: quote.total.toFixed(2), currencyCode: "USD" },
            customAttributes: [
              { key: "Garment", value: garment },
              { key: "Color", value: color },
              { key: "Sizes", value: sizeText },
              { key: "Print location", value: printLocation },
              { key: "Print width", value: `${printWidth} in` },
              { key: "Total garments", value: String(quote.quantity) },
              { key: "Garments subtotal", value: `$${quote.garments.toFixed(2)}` },
              { key: "DTF printing", value: `$${quote.dtf.toFixed(2)}` },
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

    return Response.json({
      ok: true,
      shop: session?.shop || null,
      draftOrder: result.draftOrder,
      artwork: { received: !!artwork, name: artwork?.name || null, size: artwork?.size || 0, id: artworkFileId, url: artworkFileUrl },
      pricing: { quantity: quote.quantity, garments: quote.garments.toFixed(2), dtf: quote.dtf.toFixed(2), total: quote.total.toFixed(2), rate: quote.rate.toFixed(2), tier: quote.tier },
    });
  } catch (error) {
    console.error("APP PROXY DRAFT ORDER ERROR:", error);
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Unable to create order." }, { status: 400 });
  }
};

const PRINT_WIDTHS = ["1.5", "2", "3", "3.5", "4", "5", "6", "7", "8", "9", "10", "10.5", "11", "12", "13", "14", "15", "16"];
const DTF = { "1.5": [1,.8,.65,.55,.45], "2": [1.5,1.2,.98,.83,.68], "3": [2,1.6,1.3,1.1,.9], "3.5": [2.25,1.8,1.46,1.24,1.01], "4": [2.5,2,1.63,1.38,1.13], "5": [3,2.4,1.95,1.65,1.35], "6": [3.25,2.6,2.11,1.79,1.46], "7": [3.5,2.8,2.28,1.93,1.58], "8": [3.75,3,2.44,2.06,1.69], "9": [4,3.2,2.6,2.2,1.8], "10": [4.25,3.4,2.76,2.34,1.91], "10.5": [4.5,3.6,2.93,2.48,2.03], "11": [4.5,3.6,2.93,2.48,2.03], "12": [5.5,4.4,3.58,3.03,2.48], "13": [6,4.8,3.9,3.3,2.7], "14": [7,5.6,4.55,3.85,3.15], "15": [8,6.4,5.2,4.4,3.6], "16": [9,7.2,5.85,4.95,4.05] };

function tierIndex(q) { return q >= 250 ? 4 : q >= 100 ? 3 : q >= 50 ? 2 : q >= 10 ? 1 : 0; }
function garmentCost(garment, color, size) {
  if (garment === "PC450") return size === "S" || size === "M" || size === "L" || size === "XL" ? 2.89 : ({"2XL":4.58,"3XL":5.97,"4XL":5.97}[size] || 0);
  return size === "S" || size === "M" || size === "L" || size === "XL" ? 3 : ({"2XL":6,"3XL":6,"4XL":7}[size] || 0);
}

export default function BulkBuilder() {
  const fetcher = useFetcher();
  const [garment, setGarment] = useState("PC450");
  const [color, setColor] = useState("Athletic Heather");
  const [location, setLocation] = useState("Front");
  const [width, setWidth] = useState("4");
  const [sizes, setSizes] = useState({ S: 0, M: 0, L: 0, XL: 0, "2XL": 0, "3XL": 0, "4XL": 0 });
  const [fileName, setFileName] = useState("");

  const quote = useMemo(() => {
    const quantity = Object.values(sizes).reduce((a, b) => a + Number(b || 0), 0);
    const rate = DTF[width][tierIndex(quantity)] || 0;
    const garments = Object.entries(sizes).reduce((sum, [s, q]) => sum + Number(q || 0) * garmentCost(garment, color, s) * 2, 0);
    return { quantity, rate, garments, dtf: quantity * rate, total: garments + quantity * rate };
  }, [sizes, garment, color, width]);

  const colors = garment === "PC450" ? ["Athletic Heather"] : ["Black", "White", "Blue", "Red", "Gray", "Tan"];
  const submit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("sizes", JSON.stringify(sizes));
    fetcher.submit(fd, { method: "post", action: "/apps/1099-builder", encType: "multipart/form-data" });
  };

  return (
    <main style={{ fontFamily: "Inter, system-ui, sans-serif", maxWidth: 980, margin: "0 auto", padding: "32px 20px", color: "#171717" }}>
      <header style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 13, letterSpacing: 2, fontWeight: 800 }}>1099 DESIGNS</div>
        <h1 style={{ fontSize: 36, margin: "8px 0 6px" }}>Custom Bulk Apparel Builder</h1>
        <p style={{ margin: 0, color: "#666" }}>Build your order, upload your artwork, and get an instant quote.</p>
      </header>

      {fetcher.data?.ok ? (
        <section style={{ padding: 24, border: "1px solid #16a34a", borderRadius: 14, background: "#f0fdf4" }}>
          <h2 style={{ marginTop: 0 }}>Order created ✓</h2>
          <p><strong>{fetcher.data.draftOrder?.name}</strong> — ${fetcher.data.pricing?.total}</p>
          {fetcher.data.draftOrder?.invoiceUrl && <a href={fetcher.data.draftOrder.invoiceUrl}>Continue to invoice</a>}
        </section>
      ) : (
        <form onSubmit={submit} encType="multipart/form-data">
          <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 18 }}>
            <div style={{ padding: 20, border: "1px solid #ddd", borderRadius: 14 }}>
              <h2>1. Garment</h2>
              <label>Style<select name="garment" value={garment} onChange={e => { setGarment(e.target.value); setColor(e.target.value === "PC450" ? "Athletic Heather" : "Black"); }} style={{ width: "100%", padding: 11, marginTop: 6 }}><option value="PC450">PC450 Core Cotton Tee</option><option value="G5000">Gildan G5000 100% Cotton Tee</option></select></label>
              <label style={{ display: "block", marginTop: 14 }}>Color<select name="color" value={color} onChange={e => setColor(e.target.value)} style={{ width: "100%", padding: 11, marginTop: 6 }}>{colors.map(c => <option key={c}>{c}</option>)}</select></label>
            </div>
            <div style={{ padding: 20, border: "1px solid #ddd", borderRadius: 14 }}>
              <h2>2. Print</h2>
              <label>Location<select name="printLocation" value={location} onChange={e => setLocation(e.target.value)} style={{ width: "100%", padding: 11, marginTop: 6 }}><option>Front</option><option>Back</option><option>Front + Back</option></select></label>
              <label style={{ display: "block", marginTop: 14 }}>Print width<select name="printWidth" value={width} onChange={e => setWidth(e.target.value)} style={{ width: "100%", padding: 11, marginTop: 6 }}>{PRINT_WIDTHS.map(w => <option key={w} value={w}>{w} in</option>)}</select></label>
            </div>
          </section>

          <section style={{ marginTop: 18, padding: 20, border: "1px solid #ddd", borderRadius: 14 }}>
            <h2>3. Sizes & quantities</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 10 }}>
              {Object.keys(sizes).map(s => <label key={s} style={{ fontSize: 13, fontWeight: 700 }}>{s}<input type="number" min="0" step="1" value={sizes[s]} onChange={e => setSizes({ ...sizes, [s]: Math.max(0, Number(e.target.value || 0)) })} style={{ width: "100%", boxSizing: "border-box", padding: 10, marginTop: 5 }} /></label>)}
            </div>
          </section>

          <section style={{ marginTop: 18, padding: 20, border: "1px solid #ddd", borderRadius: 14 }}>
            <h2>4. Artwork</h2>
            <input name="artwork" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setFileName(e.target.files?.[0]?.name || "")} />
            <p style={{ color: "#666", fontSize: 13 }}>{fileName ? `Selected: ${fileName}` : "PNG, JPG, or WebP. Transparent PNG recommended."}</p>
          </section>

          <section style={{ marginTop: 18, padding: 22, borderRadius: 14, background: "#171717", color: "white" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "end", gap: 20, flexWrap: "wrap" }}>
              <div><div style={{ opacity: .7, fontSize: 13 }}>ESTIMATED TOTAL</div><div style={{ fontSize: 40, fontWeight: 800 }}>${quote.total.toFixed(2)}</div><div style={{ opacity: .7 }}>{quote.quantity} garments · ${quote.rate.toFixed(2)}/print</div></div>
              <button type="submit" disabled={quote.quantity < 1 || fetcher.state !== "idle"} style={{ padding: "14px 24px", border: 0, borderRadius: 9, fontWeight: 800, cursor: "pointer" }}>{fetcher.state === "idle" ? "Create Order" : "Creating…"}</button>
            </div>
            {fetcher.data && !fetcher.data.ok && <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: "#7f1d1d" }}>{fetcher.data.error || fetcher.data.errors?.map(e => e.message).join("; ")}</div>}
          </section>
        </form>
      )}
    </main>
  );
}
