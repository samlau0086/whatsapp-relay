"use client";

import { Plus, ShoppingBag, Trash2, UploadCloud, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  MediaImagePreview,
  ProductImageMediaDialog,
  type ProductImageAsset,
} from "./product-image-media-dialog";

type RequestResult = { response: Response; token: string };
type Tier = { minQuantity: number; unitAmount: number };
type Tag = { id: string; name: string; color: string };
type Product = {
  id: string;
  sku: string;
  name: string;
  description: string;
  currency: string;
  imageMediaId: string | null;
  imageName: string;
  priceTiers: Tier[];
  tags: Tag[];
};
export function ProductEditorDialog({
  product,
  products,
  currencies,
  baseCurrency,
  request,
  onToken,
  onClose,
  onSaved,
}: {
  product?: Product;
  products: Product[];
  currencies: Array<{ code: string; name: string }>;
  baseCurrency: string;
  request: (path: string, init?: RequestInit) => Promise<RequestResult>;
  onToken: (token: string) => void;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [name, setName] = useState(product?.name ?? ""),
    [sku, setSku] = useState(product?.sku ?? ""),
    [description, setDescription] = useState(product?.description ?? ""),
    [currency, setCurrency] = useState(product?.currency ?? baseCurrency),
    [tiers, setTiers] = useState(() =>
      (product?.priceTiers.length
        ? product.priceTiers
        : [{ minQuantity: 1, unitAmount: 0 }]
      ).map((tier) => ({
        id: crypto.randomUUID(),
        minQuantity: String(tier.minQuantity),
        unitAmount: product ? tier.unitAmount.toFixed(2) : "",
      })),
    ),
    [imageMediaId, setImageMediaId] = useState<string | null>(
      product?.imageMediaId ?? null,
    ),
    [imageName, setImageName] = useState(product?.imageName ?? ""),
    [imagePickerOpen, setImagePickerOpen] = useState(false),
    [tags, setTags] = useState<Tag[]>(product?.tags ?? []),
    [tagName, setTagName] = useState(""),
    [tagColor, setTagColor] = useState("#E8EEF7"),
    [tagMenuOpen, setTagMenuOpen] = useState(false),
    [tagIndex, setTagIndex] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const CURRENCIES = currencies.map((item) => item.code);
  const duplicateName = products.some(
      (item) =>
        item.id !== product?.id &&
        item.name.trim().toLowerCase() === name.trim().toLowerCase(),
    ),
    duplicateSku = products.some(
      (item) =>
        item.id !== product?.id &&
        item.sku.trim().toLowerCase() === sku.trim().toLowerCase(),
    );
  const catalogTags = useMemo(() => {
      const selected = new Set(
          tags.map((tag) => tag.name.trim().toLowerCase()),
        ),
        unique = new Map<string, Tag>();
      for (const tag of products.flatMap((item) => item.tags)) {
        const key = tag.name.trim().toLowerCase();
        if (key && !selected.has(key) && !unique.has(key)) unique.set(key, tag);
      }
      return [...unique.values()].sort((a, b) =>
        a.name.localeCompare(b.name, "zh-CN"),
      );
    }, [products, tags]),
    tagMatches = catalogTags
      .filter(
        (tag) =>
          !tagName.trim() ||
          tag.name.toLowerCase().includes(tagName.trim().toLowerCase()),
      )
      .slice(0, 8);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy && !imagePickerOpen) onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, imagePickerOpen, onClose]);
  function addTier() {
    const last = Number(tiers.at(-1)?.minQuantity) || 1;
    setTiers((all) => [
      ...all,
      {
        id: crypto.randomUUID(),
        minQuantity: String(last + 1),
        unitAmount: "",
      },
    ]);
  }
  function addTag(source?: Tag) {
    const value = (source?.name ?? tagName).trim();
    if (
      !value ||
      tags.some((tag) => tag.name.toLowerCase() === value.toLowerCase())
    )
      return;
    setTags((all) => [
      ...all,
      {
        id: crypto.randomUUID(),
        name: value,
        color: source?.color ?? tagColor,
      },
    ]);
    setTagName("");
    setTagMenuOpen(false);
    setTagIndex(0);
  }
  function commitTag() {
    if (tagMatches.length)
      addTag(tagMatches[Math.min(tagIndex, tagMatches.length - 1)]);
    else addTag();
  }
  async function save() {
    const money = /^\d+(?:\.\d{1,2})?$/,
      quantities = tiers.map((tier) => Number(tier.minQuantity));
    if (
      !name.trim() ||
      !sku.trim() ||
      tiers[0]?.minQuantity !== "1" ||
      tiers.some(
        (tier) =>
          !/^\d+$/.test(tier.minQuantity) || !money.test(tier.unitAmount),
      ) ||
      quantities.some(
        (value, index) =>
          value < 1 || (index > 0 && value <= quantities[index - 1]),
      )
    ) {
      setError("请填写名称、唯一 SKU，以及从数量 1 开始且门槛递增的阶梯单价");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = {
        name: name.trim(),
        sku: sku.trim(),
        description: description.trim(),
        currency,
        imageMediaId,
        priceTiers: tiers.map((tier) => ({
          minQuantity: Number(tier.minQuantity),
          unitAmount: Number(tier.unitAmount),
        })),
        tags: tags.map((tag) => ({ name: tag.name.trim(), color: tag.color })),
      };
      const result = await request(
        product ? `/api/v1/products/${product.id}` : "/api/v1/products",
        {
          method: product ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            product
              ? payload
              : { clientProductId: crypto.randomUUID(), ...payload },
          ),
        },
      );
      onToken(result.token);
      const body = (await result.response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!result.response.ok)
        throw new Error(
          body.error === "sku_exists"
            ? "SKU 已被另一个有效产品使用"
            : (body.message ?? `保存失败（HTTP ${result.response.status}）`),
        );
      await onSaved(product ? "产品资料已更新" : "产品已加入团队产品库");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "产品保存失败");
      setBusy(false);
    }
  }
  function selectImage(asset: ProductImageAsset) {
    setImageMediaId(asset.id);
    setImageName(asset.fileName);
    setImagePickerOpen(false);
  }
  return (
    <>
      <div
        className="modal-backdrop product-dialog-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) onClose();
        }}
      >
        <section
          className="login-dialog product-dialog product-tier-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="product-editor-title"
        >
          <button
            className="login-close"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
          >
            <X size={17} />
          </button>
          <span className="login-logo">
            <ShoppingBag size={20} />
          </span>
          <h2 id="product-editor-title">{product ? "编辑产品" : "新增产品"}</h2>
          <p>
            SKU
            在有效产品中忽略大小写保持唯一；修改不会影响历史订单和已发送卡片。
          </p>
          <div className="product-form-grid">
            <label>
              产品名称
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                autoFocus
                placeholder="输入产品名称"
              />
            </label>
            <label>
              SKU
              <input
                value={sku}
                onChange={(event) => setSku(event.target.value)}
                maxLength={80}
                placeholder="例如 PERFUME-001"
              />
            </label>
          </div>
          {duplicateName && (
            <span className="duplicate-warning">
              产品库已有同名产品，仍可继续保存。
            </span>
          )}
          {duplicateSku && (
            <span className="duplicate-warning">
              该 SKU 已被有效产品使用，无法保存。
            </span>
          )}
          <label>
            产品描述 · 可选
            <textarea
              className="product-description-input"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="输入规格、材质、用途等产品说明"
            />
            <small className="product-description-count">
              {description.length}/2000
            </small>
          </label>
          <div className="product-tier-editor">
            <header>
              <span>
                <b>阶梯单价</b>
                <small>达到门槛数量后使用对应单件价格</small>
              </span>
              <button onClick={addTier} disabled={tiers.length >= 50}>
                <Plus size={13} />
                添加档位
              </button>
            </header>
            {tiers.map((tier, index) => (
              <div key={tier.id}>
                <label>
                  起购数量
                  <input
                    value={tier.minQuantity}
                    disabled={index === 0}
                    inputMode="numeric"
                    onChange={(event) =>
                      setTiers((all) =>
                        all.map((item) =>
                          item.id === tier.id
                            ? { ...item, minQuantity: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  单件价格
                  <input
                    value={tier.unitAmount}
                    inputMode="decimal"
                    placeholder="0.00"
                    onChange={(event) =>
                      setTiers((all) =>
                        all.map((item) =>
                          item.id === tier.id
                            ? { ...item, unitAmount: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                {index > 0 ? (
                  <button
                    onClick={() =>
                      setTiers((all) =>
                        all.filter((item) => item.id !== tier.id),
                      )
                    }
                    aria-label="删除档位"
                  >
                    <Trash2 size={13} />
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
          <label>
            币种
            <select
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {CURRENCIES.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label className="product-image-input">
            产品图片 · 可选
            <button type="button" onClick={() => setImagePickerOpen(true)}>
              <UploadCloud size={14} />
              {imageName || "从媒体与附件中选择"}
            </button>
          </label>
          {imageMediaId && (
            <div className="product-dialog-image-preview">
              <MediaImagePreview
                mediaId={imageMediaId}
                alt={imageName || name || "产品图片预览"}
                request={request}
                onToken={onToken}
                className="product-image"
              />
              <span title={imageName}>{imageName || "当前产品图片"}</span>
            </div>
          )}
          {imageMediaId && (
            <button
              type="button"
              className="product-image-remove"
              onClick={() => {
                setImageMediaId(null);
                setImageName("");
              }}
            >
              <Trash2 size={11} />
              移除图片
            </button>
          )}
          <div className="product-label-editor">
            <b>产品标签</b>
            {tags.map((tag, index) => (
              <div key={tag.id}>
                <input
                  value={tag.name}
                  maxLength={40}
                  onChange={(event) =>
                    setTags((all) =>
                      all.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, name: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <input
                  type="color"
                  value={tag.color}
                  onChange={(event) =>
                    setTags((all) =>
                      all.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, color: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <button
                  onClick={() =>
                    setTags((all) =>
                      all.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <div
              className="product-label-add product-label-search"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setTagMenuOpen(false);
              }}
            >
              <div className="product-label-search-input">
                <input
                  role="combobox"
                  aria-expanded={tagMenuOpen}
                  aria-controls="product-tag-options"
                  aria-autocomplete="list"
                  value={tagName}
                  onFocus={() => setTagMenuOpen(true)}
                  onChange={(event) => {
                    setTagName(event.target.value);
                    setTagMenuOpen(true);
                    setTagIndex(0);
                  }}
                  maxLength={40}
                  placeholder="搜索或创建标签"
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setTagMenuOpen(true);
                      setTagIndex((index) =>
                        Math.min(index + 1, Math.max(0, tagMatches.length - 1)),
                      );
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setTagIndex((index) => Math.max(0, index - 1));
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      commitTag();
                    } else if (event.key === "Escape") {
                      event.stopPropagation();
                      setTagMenuOpen(false);
                    }
                  }}
                />
                <input
                  type="color"
                  value={tagColor}
                  onChange={(event) => setTagColor(event.target.value)}
                  aria-label="新标签颜色"
                />
                <button
                  type="button"
                  onClick={commitTag}
                  aria-label={tagMatches.length ? "添加匹配标签" : "创建新标签"}
                >
                  <Plus size={13} />
                </button>
              </div>
              {tagMenuOpen &&
                (tagMatches.length > 0 || Boolean(tagName.trim())) && (
                  <div
                    id="product-tag-options"
                    className="product-label-options"
                    role="listbox"
                  >
                    {tagMatches.map((tag, index) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === tagIndex}
                        className={index === tagIndex ? "active" : ""}
                        key={tag.id || tag.name}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => addTag(tag)}
                      >
                        <i style={{ background: tag.color }} />
                        <span>
                          <b>{tag.name}</b>
                          <small>已有标签</small>
                        </span>
                      </button>
                    ))}
                    {!tagMatches.length && tagName.trim() && (
                      <button
                        type="button"
                        role="option"
                        aria-selected="true"
                        className="active create"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => addTag()}
                      >
                        <Plus size={13} />
                        <span>
                          <b>创建“{tagName.trim()}”</b>
                          <small>使用当前选择的颜色</small>
                        </span>
                      </button>
                    )}
                  </div>
                )}
            </div>
          </div>
          {error && <span className="login-error">{error}</span>}
          <button
            className="login-submit"
            disabled={busy || !name.trim() || !sku.trim() || duplicateSku}
            onClick={() => void save()}
          >
            {busy ? "正在保存…" : product ? "保存产品资料" : "创建产品"}
          </button>
        </section>
      </div>
      {imagePickerOpen && (
        <ProductImageMediaDialog
          request={request}
          onToken={onToken}
          onClose={() => setImagePickerOpen(false)}
          onSelect={selectImage}
          libraryPath="/api/v1/products/media?limit=100"
          uploadPath="/api/v1/products/media"
          description="选择或上传团队产品库可复用的 PNG、JPG 图片。"
        />
      )}
    </>
  );
}
