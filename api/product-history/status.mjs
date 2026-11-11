import { neon } from "@neondatabase/serverless";

async function checkDatabase() {
  if (!process.env.DATABASE_URL) return false;

  try {
    const sql = neon(process.env.DATABASE_URL);
    const [row] = await sql`
      SELECT
        to_regclass('public.reference_products') IS NOT NULL
        AND to_regclass('public.reference_images') IS NOT NULL
        AND to_regclass('public.product_history_scans') IS NOT NULL
        AS ready
    `;
    return row?.ready === true;
  } catch {
    return false;
  }
}

async function checkGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return false;

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models",
      {
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(8000),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return Response.json(
        { error: "ใช้คำขอแบบ POST" },
        { status: 405, headers: { Allow: "POST" } }
      );
    }

    const [connected, databaseConnected] = await Promise.all([
      checkGemini(),
      checkDatabase(),
    ]);

    return Response.json({
      connected,
      databaseConnected,
      lensConfigured: Boolean(process.env.SERPAPI_API_KEY),
      braveConfigured: Boolean(process.env.BRAVE_SEARCH_API_KEY),
    }, { headers: { "Cache-Control": "no-store" } });
  },
};
