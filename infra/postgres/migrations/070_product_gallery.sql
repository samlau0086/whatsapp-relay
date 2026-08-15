CREATE TABLE IF NOT EXISTS product_gallery_images (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK(position BETWEEN 0 AND 11),
  PRIMARY KEY(product_id, media_id),
  UNIQUE(product_id, position)
);

CREATE INDEX IF NOT EXISTS product_gallery_images_media_idx
  ON product_gallery_images(media_id);

INSERT INTO product_gallery_images(product_id, media_id, position)
SELECT id, image_media_id, 0
FROM products
WHERE image_media_id IS NOT NULL
ON CONFLICT(product_id, media_id) DO NOTHING;
