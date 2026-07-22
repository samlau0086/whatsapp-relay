ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_sku text;

UPDATE order_items item
SET product_sku=product.sku
FROM products product
WHERE item.product_id=product.id AND item.product_sku IS NULL;
