CREATE TABLE IF NOT EXISTS product_import_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_url text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (base_url)
);
INSERT INTO product_import_sources(name, base_url, position)
VALUES ('Gallery', 'https://gallery.maesvanti.online', 0)
ON CONFLICT (base_url) DO NOTHING;


