export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return Response.json(
        { error: "ใช้คำขอแบบ POST" },
        { status: 405, headers: { Allow: "POST" } }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return Response.json({
        connected: false,
        databaseConnected: false,
        reason: "missing_api_key",
      });
    }

    try {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models",
        {
          headers: { "x-goog-api-key": apiKey },
          signal: AbortSignal.timeout(8000),
        }
      );

      return Response.json({
        connected: response.ok,
        databaseConnected: false,
        ...(response.ok ? {} : { googleStatus: response.status }),
      });
    } catch {
      return Response.json({
        connected: false,
        databaseConnected: false,
        reason: "gemini_request_failed",
      });
    }
  },
};
