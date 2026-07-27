import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import {
  renderTemplateOrderImage,
  type OrderImageProduct,
} from "./order-image.js";
import type { OrderTemplate, SemanticOrderBlock } from "./order-template.js";

const PDF_POINTS_PER_PIXEL = 0.75;

export async function renderTemplateOrderPdf(
  template: OrderTemplate,
  blocks: SemanticOrderBlock[],
  products: OrderImageProduct[],
): Promise<Buffer> {
  const png = await renderTemplateOrderImage(template, blocks, products);
  const metadata = await sharp(png).metadata();
  if (!metadata.width || !metadata.height)
    throw new Error("order_pdf_image_dimensions_missing");
  const document = await PDFDocument.create();
  document.setTitle(orderTitle(blocks));
  document.setCreator("RelayDesk");
  document.setProducer("RelayDesk");
  const width = metadata.width * PDF_POINTS_PER_PIXEL,
    height = metadata.height * PDF_POINTS_PER_PIXEL;
  const page = document.addPage([width, height]),
    image = await document.embedPng(png);
  page.drawImage(image, { x: 0, y: 0, width, height });
  return Buffer.from(await document.save({ useObjectStreams: true }));
}

function orderTitle(blocks: SemanticOrderBlock[]): string {
  return (
    blocks.find((block) => block.type === "orderHeader")?.lines[0] ?? "Order"
  );
}
