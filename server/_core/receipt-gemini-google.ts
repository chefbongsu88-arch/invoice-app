import { ENV } from "./env";

/**
 * Call Google Generative Language API directly (bypasses Forge/Manus chat completions).
 * Get an API key from Google AI Studio: https://aistudio.google.com/apikey
 * Set GOOGLE_GEMINI_API_KEY or GEMINI_API_KEY on the server.
 */
export async function parseReceiptWithGoogleGemini(
  jpegBase64: string,
  mimeType: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const key = ENV.googleGeminiApiKey?.trim();
  if (!key) {
    throw new Error("GOOGLE_GEMINI_API_KEY is not set");
  }

  /** Must match v1beta `generateContent` — `gemini-1.5-flash` often 404s on current API. */
  const model = ENV.googleGeminiModel?.trim() || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const fullText = `${systemPrompt}\n\n${userPrompt}`;

  const body = {
    contents: [
      {
        parts: [
          { text: fullText },
          {
            inline_data: {
              mime_type: mimeType === "image/png" ? "image/png" : "image/jpeg",
              data: jpegBase64.replace(/\s/g, ""),
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  if (!res.ok) {
    console.error("[OCR] Google Gemini API error:", res.status, raw.slice(0, 500));
    throw new Error(`Google Gemini API failed (${res.status}): ${raw.slice(0, 200)}`);
  }

  let parsed: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error("Google Gemini returned non-JSON");
  }

  const text =
    parsed.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";

  if (!text.trim()) {
    throw new Error("Google Gemini returned empty text");
  }
  return text.trim();
}
