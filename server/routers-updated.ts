// This file shows the updated exportToSheets mutation with image upload
// The key change is in the dataRows processing section

// BEFORE (lines 242-258):
/*
        // Append data rows
        const now = new Date().toISOString();
        const dataRows = rows.map((r) => [
          r.source,
          r.invoiceNumber,
          r.vendor,
          r.date,
          r.totalAmount,
          r.ivaAmount,
          r.baseAmount,
          r.category,
          r.currency,
          r.tip ?? 0,
          r.notes ?? "",
          r.imageUrl ?? "",
          now,
        ]);
*/

// AFTER (with image upload):
/*
        // Append data rows with image upload
        const now = new Date().toISOString();
        const dataRows = await Promise.all(
          rows.map(async (r) => {
            let imageUrl = r.imageUrl ?? "";
            
            // If imageUrl is a base64 string or local file path, upload it to storage
            if (imageUrl && (imageUrl.startsWith("data:") || imageUrl.startsWith("file://"))) {
              try {
                // Extract base64 if it's a data URL
                let base64Data = imageUrl;
                if (imageUrl.startsWith("data:")) {
                  // Format: data:image/jpeg;base64,{base64data}
                  const match = imageUrl.match(/base64,(.+)$/);
                  base64Data = match ? match[1] : imageUrl;
                } else if (imageUrl.startsWith("file://")) {
                  // For local file paths, we'll skip upload (client should send base64)
                  console.warn("[Export] Skipping local file path upload:", imageUrl);
                  imageUrl = "";
                }
                
                if (base64Data && !imageUrl.startsWith("file://")) {
                  // Generate filename from invoice number or timestamp
                  const fileName = `${r.invoiceNumber || "receipt"}-${Date.now()}.jpg`;
                  imageUrl = await uploadImageToStorage(base64Data, fileName);
                  console.log(`[Export] Image uploaded for ${r.vendor}: ${imageUrl}`);
                }
              } catch (error) {
                console.error(`[Export] Failed to upload image for ${r.vendor}:`, error);
                // Continue without image URL if upload fails
                imageUrl = "";
              }
            }
            
            return [
              r.source,
              r.invoiceNumber,
              r.vendor,
              r.date,
              r.totalAmount,
              r.ivaAmount,
              r.baseAmount,
              r.category,
              r.currency,
              r.tip ?? 0,
              r.notes ?? "",
              imageUrl,
              now,
            ];
          })
        );
*/
