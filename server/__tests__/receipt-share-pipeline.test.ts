import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  putReceiptShareImage,
  getReceiptShareImage,
  detectMimeFromBuffer,
} from "../receipt-share-store";
import { resolvePublicBaseForReceiptImages } from "../_core/env";

/** Minimal valid JPEG (1×1 px). */
const MIN_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q==";

describe("receipt-share pipeline (Sheets receipt URL)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("PUBLIC_SERVER_URL", "");
    vi.stubEnv("RECEIPT_IMAGE_PUBLIC_BASE_URL", "");
    vi.stubEnv("RAILWAY_PUBLIC_DOMAIN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores and retrieves a tiny JPEG by token", () => {
    const buf = Buffer.from(MIN_JPEG_B64, "base64");
    expect(buf.length).toBeGreaterThan(0);
    expect(detectMimeFromBuffer(buf)).toBe("image/jpeg");

    const token = putReceiptShareImage(buf, "image/jpeg");
    expect(token).toBeTruthy();
    expect(token!.length).toBe(48);

    const got = getReceiptShareImage(token!);
    expect(got).not.toBeNull();
    expect(got!.buffer.equals(buf)).toBe(true);
    expect(got!.mime).toBe("image/jpeg");
  });

  it("resolvePublicBaseForReceiptImages never returns empty (falls back to production origin)", () => {
    vi.stubEnv("NODE_ENV", "development");
    const withoutClient = resolvePublicBaseForReceiptImages("");
    expect(withoutClient).toMatch(/^https:\/\//);

    const withClient = resolvePublicBaseForReceiptImages(
      "https://invoice-app-production-18c0.up.railway.app",
    );
    expect(withClient).toBe(
      "https://invoice-app-production-18c0.up.railway.app",
    );
  });

  it("builds the same URL shape the exporter uses", () => {
    const buf = Buffer.from(MIN_JPEG_B64, "base64");
    const token = putReceiptShareImage(buf, "image/jpeg")!;
    const base = resolvePublicBaseForReceiptImages("");
    const url = `${base}/api/receipt-share/${token}`;
    expect(url).toMatch(/^https:\/\/[^/]+\/api\/receipt-share\/[a-f0-9]{48}$/i);
  });
});
