import { createHash, randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";

const MAX_IMAGES = 12;
const MAX_BASE64_LENGTH = 4_000_000;
const COOKIE_NAME = "__Host-sanso_scan";

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "POST" } }
      );
    }

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      return Response.json(
        { error: "database_not_configured" },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => null);
    const images = body?.images;

    if (
      !Array.isArray(images) ||
      !images.length ||
      images.length > MAX_IMAGES ||
      images.some((image) => typeof image !== "string")
    ) {
      return Response.json({ error: "invalid_images" }, { status: 400 });
    }

    const totalLength = images.reduce((size, image) => size + image.length, 0);
    if (totalLength > MAX_BASE64_LENGTH) {
      return Response.json({ error: "images_too_large" }, { status: 413 });
    }

    const hashes = [];
    for (const image of images) {
      const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(image);
      if (!match || match[1].length % 4 !== 0) {
        return Response.json({ error: "invalid_image_data" }, { status: 400 });
      }
      hashes.push(sha256(Buffer.from(match[1], "base64")));
    }

    const cookie = request.headers.get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(COOKIE_NAME + "="))
      ?.slice(COOKIE_NAME.length + 1);

    const token = /^[0-9a-f]{64}$/.test(cookie ?? "")
      ? cookie
      : randomBytes(32).toString("hex");
    const sellerId = "demo:" + sha256(token);
    const uniqueHashes = [...new Set(hashes)];

    try {
      const sql = neon(databaseUrl);
      const [result] = await sql`
        WITH requested AS (
          SELECT jsonb_array_elements_text(
            ${JSON.stringify(uniqueHashes)}::jsonb
          ) AS sha256
        ), candidates AS (
          SELECT i.reference_product_id, min(i.image_url) AS image_url
          FROM public.reference_images AS i
          JOIN requested AS r ON r.sha256 = i.sha256
          GROUP BY i.reference_product_id
          HAVING count(DISTINCT i.sha256) = ${uniqueHashes.length}
        ), saved AS (
          INSERT INTO public.product_history_scans
            (seller_id, reference_product_id, expires_at)
          SELECT ${sellerId}, reference_product_id, now() + interval '15 minutes'
          FROM candidates
          WHERE (SELECT count(*) FROM candidates) = 1
          RETURNING id, reference_product_id
        )
        SELECT s.id AS scan_id, p.id AS product_id,
               p.name, p.source_url, c.image_url
        FROM saved AS s
        JOIN public.reference_products AS p ON p.id = s.reference_product_id
        JOIN candidates AS c ON c.reference_product_id = p.id
      `;

      if (!result) {
        return Response.json({
          status: "no_match",
          verifiedByDatabase: false,
          totalImages: images.length,
          matchedImages: 0,
          matches: [],
        }, { headers: { "Cache-Control": "no-store" } });
      }

      return Response.json({
        status: "identified",
        verifiedByDatabase: true,
        matchMethod: "sha256_exact",
        totalImages: images.length,
        matchedImages: images.length,
        referenceProductId: result.product_id,
        scanId: result.scan_id,
        matches: result.source_url ? [{
          title: result.name,
          url: result.source_url,
          imageUrl: result.image_url,
          match: "exact",
        }] : [],
      }, {
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": COOKIE_NAME + "=" + token
            + "; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Strict",
        },
      });
    } catch (error) {
      console.error("Product history scan failed", error?.code ?? error?.name);
      return Response.json({ error: "database_scan_failed" }, { status: 503 });
    }
  },
};
