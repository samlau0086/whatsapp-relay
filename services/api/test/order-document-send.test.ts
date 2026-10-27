import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { orderDocumentSendSchema, renderOrderDocumentForSend } from "../src/order-document-send.js";
import { parseOrderTemplate, renderSemanticOrder } from "../src/order-template.js";

const clientSendId = "27b641c2-90e6-4d62-8256-53f8a3ef4e48";
const context = {
  orderNumber: "20261027-001", businessStatus: "quotation" as const, currency: "USD", customerName: "Alex",
  customerPhone: "+8613800000000", description: "Updated order",
  items: [{ name: "Perfume", sku: "PERFUME-001", quantity: 3, unitAmount: 25 }],
  fees: [{ name: "Shipping", amount: 6.5 }],
};

test("document sends accept image and PDF and preserve PDF for older clients", () => {
  assert.equal(orderDocumentSendSchema.parse({ clientSendId }).format, "pdf");
  for (const format of ["image", "pdf"] as const) {
    assert.equal(orderDocumentSendSchema.parse({ clientSendId, format }).format, format);
  }
  for (const body of [null, {}, { clientSendId: "invalid", format: "image" },
    { clientSendId, format: "text" }, { clientSendId, format: null }]) {
    assert.equal(orderDocumentSendSchema.safeParse(body).success, false);
  }
});

for (const document of ["qt", "sc", "pi", "ci"] as const) {
  test(`${document.toUpperCase()} sends render real PNG images and PDF documents from the current order`, async () => {
    const template = parseOrderTemplate(null, document);
    const blocks = renderSemanticOrder(template, context);
    const image = await renderOrderDocumentForSend("image", template, blocks, []);
    assert.equal(image.kind, "image");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.extension, "png");
    const metadata = await sharp(image.bytes).metadata();
    assert.equal(metadata.format, "png");
    assert.ok((metadata.height ?? 0) > 0);

    const updatedBlocks = renderSemanticOrder(template, {
      ...context, items: [{ ...context.items[0], quantity: 8 }],
    });
    const updated = await renderOrderDocumentForSend("image", template, updatedBlocks, []);
    assert.notDeepEqual(updated.bytes, image.bytes, "sending again must render the changed order");

    const pdf = await renderOrderDocumentForSend("pdf", template, updatedBlocks, []);
    assert.equal(pdf.kind, "document");
    assert.equal(pdf.mimeType, "application/pdf");
    assert.equal(pdf.extension, "pdf");
    assert.equal(pdf.bytes.subarray(0, 5).toString(), "%PDF-");
    assert.ok((await PDFDocument.load(pdf.bytes)).getPageCount() > 0);
  });
}
