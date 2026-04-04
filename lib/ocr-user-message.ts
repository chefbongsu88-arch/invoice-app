import { isTRPCClientError } from "@trpc/client";

const DEFAULT_TITLE = "Couldn't read receipt";
const DEFAULT_BODY =
  "Something went wrong while reading this receipt. You can still enter the details manually below. If this keeps happening, try a smaller or clearer photo.";

/**
 * Maps server / network errors to user-facing English copy (no raw stack traces).
 */
export function getOcrAlertForUser(err: unknown): { title: string; message: string } {
  const raw = extractRawMessage(err);
  const lower = raw.toLowerCase();

  if (!raw.trim()) {
    return { title: DEFAULT_TITLE, message: DEFAULT_BODY };
  }

  if (/could not process image|invalid_request_error.*could not process/i.test(lower)) {
    return {
      title: "Photo not accepted",
      message:
        "The recognition service couldn't process this image (it may be too large or in an unsupported form). Try again with a smaller file, better lighting, or enter the receipt details manually.",
    };
  }

  if (/receipt ai is not configured|anthropic_api_key|built_in_forge_api_key|api key/i.test(lower)) {
    return {
      title: "Scanning not available",
      message:
        "Receipt scanning isn't configured on the server. The deployment needs AI API keys (see server documentation). You can still add the invoice by typing the details.",
    };
  }

  if (/too small|image data is too small|bad request/i.test(lower)) {
    return {
      title: "Image too small",
      message:
        "The photo couldn't be read as a valid image. Try taking a new picture or choosing a different file.",
    };
  }

  if (/storage|upload.*failed|storage proxy credentials/i.test(lower)) {
    return {
      title: "Image upload failed",
      message:
        "The server couldn't store the image for processing. This is usually a server configuration issue. Try again later or enter details manually.",
    };
  }

  if (/network|fetch failed|failed to fetch|enotfound|econnrefused|timed out|timeout/i.test(lower)) {
    return {
      title: "Connection problem",
      message:
        "Couldn't reach the server. Check your internet connection and try again.",
    };
  }

  if (/returned no text|no text was recognized|recognition service returned no text/i.test(lower)) {
    return {
      title: "Nothing recognized",
      message:
        "No text could be read from this photo. Try a sharper, well-lit image, or enter the details manually.",
    };
  }

  if (/receipt recognition failed/i.test(lower)) {
    return {
      title: DEFAULT_TITLE,
      message: DEFAULT_BODY,
    };
  }

  return { title: DEFAULT_TITLE, message: DEFAULT_BODY };
}

function extractRawMessage(err: unknown): string {
  if (isTRPCClientError(err)) {
    return err.message?.trim() ?? "";
  }
  if (err instanceof Error && err.message?.trim()) {
    return err.message.trim();
  }
  return String(err ?? "");
}
