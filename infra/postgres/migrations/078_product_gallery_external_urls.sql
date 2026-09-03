ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE product_gallery_images DROP CONSTRAINT IF EXISTS product_gallery_images_pkey;
ALTER TABLE product_gallery_images ALTER COLUMN media_id DROP NOT NULL;
ALTER TABLE product_gallery_images ADD COLUMN IF NOT EXISTS external_url text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_gallery_images_source_check'
      AND conrelid = 'product_gallery_images'::regclass
  ) THEN
    ALTER TABLE product_gallery_images ADD CONSTRAINT product_gallery_images_source_check CHECK ((media_id IS NOT NULL AND external_url IS NULL) OR (media_id IS NULL AND external_url ~* '^https?://'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS product_gallery_images_media_unique ON product_gallery_images(product_id, media_id) WHERE media_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS product_gallery_images_external_url_unique ON product_gallery_images(product_id, external_url) WHERE external_url IS NOT NULL;