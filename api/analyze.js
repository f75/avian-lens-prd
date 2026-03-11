export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    return res.status(200).end();
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    // New format: { messages, model, maxTokens }
    // Legacy format: { b64, mimeType, location, model }
    const { messages, model, maxTokens, b64, mimeType, location } = req.body;

    let apiMessages;
    if (messages) {
      apiMessages = messages;
    } else if (b64 && mimeType) {
      apiMessages = [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: b64 } },
          { type: "text", text: `You are an ornithologist and wildlife photography expert. Analyze this bird image.\nLocation context: ${location || "Not provided"}\nReturn ONLY valid JSON, no markdown:\n{"species":"Common name or Unidentifiable","scientificName":"Latin or empty","confidence":"High/Medium/Low","qualityScore":<1-10 int>,"qualityGrade":"Masterpiece/Excellent/Good/Fair/Poor","summary":"One sentence","lighting":"Brief","composition":"Brief","focusSharpness":"Brief","behavior":"Brief","strengths":["s1","s2"],"improvements":["t1","t2","t3"],"interestingFact":"One short fact"}` }
        ]
      }];
    } else {
      return res.status(400).json({ error: "Missing messages or image data" });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || "claude-haiku-4-5-20251001",
        max_tokens: maxTokens || 1000,
        messages: apiMessages,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("Anthropic error:", data);
      return res.status(response.status).json({ error: data.error?.message || "API error" });
    }
    return res.status(200).json(data);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
