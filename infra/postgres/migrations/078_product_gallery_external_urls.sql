ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE product_gallery_images ALTER COLUMN media_id DROP NOT NULL;
ALTER TABLE product_gallery_images ADD COLUMN IF NOT EXISTS external_url text;
ALTER TABLE product_gallery_images ADD CONSTRAINT product_gallery_images_source_check CHECK ((media_id IS NOT NULL AND external_url IS NULL) OR (media_id IS NULL AND external_url ~* '^https?://'));
CREATE UNIQUE INDEX IF NOT EXISTS product_gallery_images_external_url_unique ON product_gallery_images(product_id, external_url) WHERE external_url IS NOT NULL;
