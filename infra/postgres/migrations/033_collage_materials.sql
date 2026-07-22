CREATE TABLE IF NOT EXISTS collage_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  template jsonb NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS collage_templates_one_default_idx ON collage_templates ((is_default)) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS collage_templates_active_idx ON collage_templates (updated_at DESC,id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS material_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_generation_id uuid UNIQUE NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  template_id uuid REFERENCES collage_templates(id) ON DELETE SET NULL,
  template_name text NOT NULL,
  template_snapshot jsonb NOT NULL,
  product_snapshot jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS material_batches_created_idx ON material_batches (created_at DESC,id);

CREATE TABLE IF NOT EXISTS material_assets (
  batch_id uuid NOT NULL REFERENCES material_batches(id) ON DELETE CASCADE,
  media_id uuid NOT NULL UNIQUE REFERENCES media(id) ON DELETE RESTRICT,
  page_index integer NOT NULL CHECK (page_index >= 0),
  product_ids jsonb NOT NULL,
  PRIMARY KEY (batch_id,page_index)
);
