import { z } from "zod";
import { renderTemplateOrderImage } from "./order-image.js";
import { renderTemplateOrderPdf } from "./order-pdf.js";

export const orderDocumentSendSchema = z.object({
  clientSendId: z.string().uuid(),
  format: z.enum(["image", "pdf"]).default("pdf"),
});

export async function renderOrderDocumentForSend(
  format: "image" | "pdf",
  ...args: Parameters<typeof renderTemplateOrderPdf>
) {
  if (format === "image") {
    return {
      bytes: await renderTemplateOrderImage(...args, { groupItemsWithRoundedFrames: true }),
      extension: "png",
      mimeType: "image/png",
      kind: "image" as const,
    };
  }
  return {
    bytes: await renderTemplateOrderPdf(...args),
    extension: "pdf",
    mimeType: "application/pdf",
    kind: "document" as const,
  };
}
