import { describe, it, expect, vi, beforeEach } from "vitest";
import { uploadImageToStorage } from "../image-upload-storage";

vi.mock("../_core/env", () => ({
  ENV: {
    forgeApiUrl: "https://forge.test",
    forgeApiKey: "test-forge-key",
  },
  isForgeStorageConfigured: () => true,
}));

// Mock the storage module
vi.mock("../storage", () => ({
  storagePut: vi.fn(),
}));

describe("Image Upload Storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should upload image and return public URL", async () => {
    const { storagePut } = await import("../storage");
    const mockUrl = "https://storage.example.com/invoices/123/receipt.jpg";
    
    vi.mocked(storagePut).mockResolvedValueOnce({
      key: "invoices/123/receipt.jpg",
      url: mockUrl,
    });

    const base64Image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const fileName = "test-receipt.jpg";

    const result = await uploadImageToStorage(base64Image, fileName);

    expect(result).toBe(mockUrl);
    expect(storagePut).toHaveBeenCalledWith(
      expect.stringContaining("invoices/"),
      expect.any(Buffer),
      "image/png",
    );
  });

  it("should return empty string on upload failure", async () => {
    const { storagePut } = await import("../storage");
    
    vi.mocked(storagePut).mockRejectedValueOnce(new Error("Upload failed"));

    const base64Image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const fileName = "test-receipt.jpg";

    const result = await uploadImageToStorage(base64Image, fileName);

    expect(result).toBe("");
  });

  it("should handle empty base64 string", async () => {
    const result = await uploadImageToStorage("", "test.jpg");
    expect(result).toBe("");
  });

  it("should generate unique file paths", async () => {
    const { storagePut } = await import("../storage");
    
    vi.mocked(storagePut).mockResolvedValue({
      key: "invoices/123/receipt.jpg",
      url: "https://storage.example.com/invoices/123/receipt.jpg",
    });

    const base64Image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    
    // Call twice
    await uploadImageToStorage(base64Image, "receipt1.jpg");
    await uploadImageToStorage(base64Image, "receipt2.jpg");

    // Verify storagePut was called twice with different paths
    expect(storagePut).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(storagePut).mock.calls;
    expect(calls[0][0]).not.toBe(calls[1][0]); // Different paths
  });
});
