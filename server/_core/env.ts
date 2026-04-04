export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  /** Direct Anthropic API — used for receipt vision when set (preferred over Forge/Gemini). */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  /** e.g. claude-3-5-sonnet-20241022 */
  anthropicReceiptModel:
    process.env.ANTHROPIC_RECEIPT_MODEL ?? "claude-3-5-sonnet-20241022",
  /** Google AI Studio — bypasses Forge when set. https://aistudio.google.com/apikey */
  googleGeminiApiKey: process.env.GOOGLE_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? "",
  /** e.g. gemini-1.5-flash, gemini-2.0-flash */
  googleGeminiModel: process.env.GOOGLE_GEMINI_MODEL ?? "gemini-1.5-flash",
};
