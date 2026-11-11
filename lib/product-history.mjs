import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { searchProductHistory } from "./product-history-search.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const IMAGE = /^data:(image\/(?:jpeg|png|webp));base64,([a-z0-9+/]+={0,2})$/i;
export const keys = ["brand", "origin", "year"];
export const text = (value, limit) =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";

export function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

export function reply(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

export async function runHistory(request, action) {
  if (request.method !== "POST") {
    return reply({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  }

  const { DATABASE_URL, GEMINI_API_KEY } = process.env;
  if (!DATABASE_URL || !GEMINI_API_KEY) {
    return reply({ error: "server_not_configured" }, 503);
  }

  const body = await request.json().catch(() => null);
  const token = /(?:^|;\s*)__Host-sanso_scan=([0-9a-f]{64})(?:;|$)/
    .exec(request.headers.get("cookie") ?? "")?.[1];
  if (!UUID.test(text(body?.scanId, 100)) || !token) {
    return reply({ error: "valid_scan_required" }, 400);
  }

  try {
    const sellerId = "demo:" + createHash("sha256").update(token).digest("hex");
    const sql = neon(DATABASE_URL);
    const rows = await sql`
      SELECT p.name, p.brand, p.source_url, i.sha256, i.image_url
      FROM public.product_history_scans AS s
      JOIN public.reference_products AS p ON p.id = s.reference_product_id
      JOIN public.reference_images AS i ON i.reference_product_id = p.id
      WHERE s.id = ${body.scanId}::uuid
        AND s.seller_id = ${sellerId}
        AND s.expires_at > now()
    `;
    if (!rows.length) return reply({ error: "scan_not_found_or_expired" }, 404);

    const allowed = new Map(rows.map((row) => [row.sha256, row.image_url]));
    const supplied = body.images ?? [];
    if (!Array.isArray(supplied) || supplied.length > 12 ||
        supplied.some((image) => typeof image !== "string") ||
        supplied.reduce((total, image) => total + image.length, 0) > 4_000_000) {
      return reply({ error: "invalid_images" }, 400);
    }

    const photos = [];
    const matchedImageUrls = new Set();
    for (const image of supplied) {
      const match = IMAGE.exec(image);
      if (!match || match[2].length % 4 !== 0) {
        return reply({ error: "invalid_image_data" }, 400);
      }
      const hash = createHash("sha256").update(Buffer.from(match[2], "base64")).digest("hex");
      if (!allowed.has(hash)) return reply({ error: "image_does_not_match_scan" }, 400);
      photos.push({ inlineData: { mimeType: match[1].toLowerCase(), data: match[2] } });
      const imageUrl = httpsUrl(allowed.get(hash));
      if (imageUrl) matchedImageUrls.add(imageUrl);
    }

    const primaryPhoto = photos[0]?.inlineData;
    const answers = Array.isArray(body.sellerAnswers) ? body.sellerAnswers.slice(0, 4) : [];
    let evidenceCount = 0;
    for (const answer of answers) {
      const evidence = answer?.evidenceImages;
      if (evidence === undefined) continue;
      if (!Array.isArray(evidence) || ![...keys, "model"].includes(answer.key) ||
          evidenceCount + evidence.length > 2) {
        return reply({ error: "invalid_evidence_images" }, 400);
      }

      for (const image of evidence) {
        const match = typeof image === "string" && image.length <= 150_000
          ? IMAGE.exec(image)
          : null;
        if (!match || match[1].toLowerCase() !== "image/jpeg" || match[2].length % 4 !== 0) {
          return reply({ error: "invalid_evidence_image_data" }, 400);
        }
        const bytes = Buffer.from(match[2], "base64");
        if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
            bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
          return reply({ error: "invalid_evidence_image_data" }, 400);
        }
        evidenceCount += 1;
        photos.push(
          { text: `รูปหลักฐานเพิ่มเติมที่ร้านแนบสำหรับข้อ ${answer.key} (รอตรวจสอบ)` },
          { inlineData: { mimeType: "image/jpeg", data: match[2] } }
        );
      }
    }

    const reference = rows[0];
    const product = {
      name: text(body.name, 200),
      brand: text(body.brand, 120),
      category: text(body.category, 120),
      description: text(body.description, 1200),
      referenceName: text(reference.name, 200),
      referenceBrand: text(reference.brand, 120),
    };
    const askGemini = async (instructions, data) => {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: instructions }] },
            contents: [{ parts: [{ text: JSON.stringify(data) }, ...photos] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
          signal: AbortSignal.timeout(30000),
        }
      );
      if (!response.ok) throw new Error("gemini_http_" + response.status);
      const result = await response.json();
      const output = (result.candidates?.[0]?.content?.parts ?? [])
        .filter((part) => !part.thought)
        .map((part) => part.text ?? "")
        .join("");
      return JSON.parse(output);
    };

    return await action({
      body, product, reference, askGemini, matchedImageUrls: [...matchedImageUrls],
      searchHistory: () => searchProductHistory(product, primaryPhoto),
    });
  } catch (error) {
    console.error("Product history failed", error?.code ?? error?.name);
    return reply({ error: "product_history_failed" }, 502);
  }
}
