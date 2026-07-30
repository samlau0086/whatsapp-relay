import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const source = await readFile(new URL("../src/assets/icon.svg", import.meta.url));
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

async function createIco(svg) {
  const images = await Promise.all(sizes.map((size) => sharp(svg)
    .resize(size, size)
    .png()
    .toBuffer()));

  const headerSize = 6 + (16 * images.length);
  let imageOffset = headerSize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  images.forEach((image, index) => {
    const size = sizes[index];
    const entry = 6 + (index * 16);
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(imageOffset, entry + 12);
    imageOffset += image.length;
  });

  return Buffer.concat([header, ...images]);
}

const attentionSource = Buffer.from(source.toString("utf8").replaceAll("#167b50", "#d97706"));
await mkdir(new URL("../src/assets/", import.meta.url), { recursive: true });
await Promise.all([
  writeFile(new URL("../src/assets/icon.ico", import.meta.url), await createIco(source)),
  writeFile(new URL("../src/assets/icon-attention.ico", import.meta.url), await createIco(attentionSource)),
]);
