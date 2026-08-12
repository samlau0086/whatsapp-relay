"use client";

import { ArrowUpRight, Check, Pencil, Plus, ShoppingBag, Trash2, UploadCloud, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { confirmAction } from "./confirmation-ui";
import {
  MediaImagePreview,
  ProductImageMediaDialog,
  type ProductImageAsset,
} from "./product-image-media-dialog";
import { WEIGHT_UNITS, type WeightUnit } from "./weight";

type RequestResult = { response: Response; token: string };
type ProductErrorBody = {
  error?: string;
  message?: string;
  details?: {
    formErrors?: string[];
    fieldErrors?: Record<string, string[]>;
  };
};
type Tier = { minQuantity: number; unitAmount: number; costAmount?: number; profitMargin?: number };
type ProductVariant = { id?: string; attributes: Record<string, string>; sku: string; priceTiers: Tier[]; imageMediaId?: string | null };
type VariantDimension = { id: string; name: string; values: string };
type TierDraft = { id: string; minQuantity: string; unitAmount: string; costAmount: string; profitMargin: string };
type VariantDraft = { id: string; attributes: Record<string, string>; sku: string; priceTiers: TierDraft[]; imageMediaId: string | null; imageName: string };
type SupplierLink = { label: string; url: string };
type SupplierLinkDraft = SupplierLink & { id: string };
type Tag = { id: string; name: string; color: string };
type Product = {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  brand: string;
  currency: string;
  weightAmount: number | null;
  weightUnit: WeightUnit | null;
  shippingClassId: string | null;
  shippingClass: string | null;
  imageMediaId: string | null;
  imageName: string;
  priceTiers: Tier[];
  supplierLinks: SupplierLink[];
  internalNote: string;
  tags: Tag[];
  variants?: ProductVariant[];
};

function uniqueCatalogTags(products: Product[]) {
  const unique = new Map<string, Tag>();
  for (const tag of products.flatMap((item) => item.tags)) {
    const key = tag.name.trim().toLowerCase();
    if (key && !unique.has(key)) unique.set(key, tag);
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function uniqueValues(values: string[]) {
  return [...new Map(values.map((value) => [value.trim().toLowerCase(), value.trim()])).values()]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function SearchableCreatableField({
  id,
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState(value),
    [open, setOpen] = useState(false),
    [activeIndex, setActiveIndex] = useState(0);
  const normalized = query.trim().toLowerCase(),
    matches = options
      .filter((option) => !normalized || option.toLowerCase().includes(normalized))
      .slice(0, 8),
    exact = options.some((option) => option.toLowerCase() === normalized),
    canCreate = Boolean(query.trim()) && !exact,
    choices = matches.length + (canCreate ? 1 : 0);
  function choose(next: string) {
    onChange(next.trim());
    setQuery(next.trim());
    setOpen(false);
    setActiveIndex(0);
  }
  return (
    <label className="product-taxonomy-field">
      {label} · 可选
      <div
        className="product-taxonomy-combobox"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setOpen(false);
            setQuery(value);
          }
        }}
      >
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-options`}
          aria-autocomplete="list"
          value={query}
          maxLength={80}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            setOpen(true);
            setActiveIndex(0);
            if (!next) onChange("");
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => Math.min(Math.max(0, choices - 1), index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => Math.max(0, index - 1));
            } else if (event.key === "Enter" && open && choices) {
              event.preventDefault();
              if (activeIndex < matches.length) choose(matches[activeIndex]);
              else choose(query);
            } else if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
              setQuery(value);
            }
          }}
        />
        {open && (
          <div id={`${id}-options`} className="product-taxonomy-options" role="listbox">
            {matches.map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={option.toLowerCase() === value.toLowerCase()}
                className={index === activeIndex ? "active" : ""}
                key={option}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
              >
                <span>{option}</span>
                {option.toLowerCase() === value.toLowerCase() && <small>已选择</small>}
              </button>
            ))}
            {canCreate && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                className={activeIndex === matches.length ? "active create" : "create"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(query)}
              >
                <Plus size={14} />
                <span>创建“{query.trim()}”</span>
              </button>
            )}
            {!choices && <p>没有匹配项，请输入新名称</p>}
          </div>
        )}
      </div>
    </label>
  );
}

export function ProductEditorDialog({
  product,
  products,
  categories,
  brands,
  currencies,
  baseCurrency,
  request,
  onToken,
  onClose,
  onSaved,
  onCatalogChanged,
}: {
  product?: Product;
  products: Product[];
  categories: string[];
  brands: string[];
  currencies: Array<{ code: string; name: string }>;
  baseCurrency: string;
  request: (path: string, init?: RequestInit) => Promise<RequestResult>;
  onToken: (token: string) => void;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
  onCatalogChanged: (message: string) => Promise<void>;
}) {
  const tierDraft = (tier: Tier, emptyPrice = false): TierDraft => ({
    id: crypto.randomUUID(),
    minQuantity: String(tier.minQuantity),
    unitAmount: emptyPrice ? "" : tier.unitAmount.toFixed(2),
    costAmount: tier.costAmount === undefined ? "" : tier.costAmount.toFixed(2),
    profitMargin: tier.profitMargin === undefined ? "" : String(tier.profitMargin),
  });
  const [name, setName] = useState(product?.name ?? ""),
    [sku, setSku] = useState(product?.sku ?? ""),
    [description, setDescription] = useState(product?.description ?? ""),
    [category, setCategory] = useState(product?.category ?? ""),
    [brand, setBrand] = useState(product?.brand ?? ""),
    [currency, setCurrency] = useState(
      product?.currency ?? (currencies.some((item) => item.code === "CNY") ? "CNY" : baseCurrency),
    ),
    [weightAmount,setWeightAmount]=useState(product?.weightAmount?.toString()??""),
    [weightUnit,setWeightUnit]=useState<WeightUnit>(product?.weightUnit??"kg"),
    [shippingClassId,setShippingClassId]=useState(product?.shippingClassId??""),
    [shippingClasses,setShippingClasses]=useState<Array<{id:string;name:string}>>([]),
    [tiers, setTiers] = useState(() =>
      (product?.priceTiers.length
        ? product.priceTiers
        : [{ minQuantity: 1, unitAmount: 0 }]
      ).map((tier) => tierDraft(tier, !product)),
    ),
    [supplierLinks,setSupplierLinks]=useState<SupplierLinkDraft[]>(()=>(product?.supplierLinks??[]).map(link=>({...link,id:crypto.randomUUID()}))),
    [internalNote,setInternalNote]=useState(product?.internalNote??""),
    [imageMediaId, setImageMediaId] = useState<string | null>(
      product?.imageMediaId ?? null,
    ),
    [imageName, setImageName] = useState(product?.imageName ?? ""),
    [variantDimensions, setVariantDimensions] = useState<VariantDimension[]>(() => {
      const names = [...new Set((product?.variants ?? []).flatMap((variant) => Object.keys(variant.attributes)))];
      return names.map((name) => ({ id: crypto.randomUUID(), name, values: [...new Set((product?.variants ?? []).map((variant) => variant.attributes[name]).filter(Boolean))].join(", ") }));
    }),
    [variantRows, setVariantRows] = useState<VariantDraft[]>(() => (product?.variants ?? []).map((variant) => ({ id: variant.id ?? crypto.randomUUID(), attributes: variant.attributes, sku: variant.sku, priceTiers: (variant.priceTiers.length ? variant.priceTiers : [{ minQuantity: 1, unitAmount: 0 }]).map((tier) => tierDraft(tier)), imageMediaId: variant.imageMediaId ?? null, imageName: "" }))),
    [variantImageIndex, setVariantImageIndex] = useState<number | null>(null),
    [imagePickerOpen, setImagePickerOpen] = useState(false),
    [tags, setTags] = useState<Tag[]>(product?.tags ?? []),
    [tagName, setTagName] = useState(""),
    [tagColor, setTagColor] = useState("#E8EEF7"),
    [tagMenuOpen, setTagMenuOpen] = useState(false),
    [tagIndex, setTagIndex] = useState(0),
    [catalog, setCatalog] = useState<Tag[]>(() => uniqueCatalogTags(products)),
    [tagEditing, setTagEditing] = useState<{
      currentName: string;
      name: string;
      color: string;
    } | null>(null),
    [tagActionBusy, setTagActionBusy] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const CURRENCIES = currencies.map((item) => item.code);
  const categoryOptions = useMemo(
      () => uniqueValues([...categories, ...products.map((item) => item.category)]),
      [categories, products],
    ),
    brandOptions = useMemo(
      () => uniqueValues([...brands, ...products.map((item) => item.brand)]),
      [brands, products],
    );
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
        );
      return catalog.filter((tag) => !selected.has(tag.name.trim().toLowerCase()));
    }, [catalog, tags]),
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
  useEffect(()=>{let cancelled=false;void request("/api/v1/shipping-classes").then(async result=>{onToken(result.token);if(result.response.ok&&!cancelled){const body=await result.response.json() as {data:Array<{id:string;name:string}>};setShippingClasses(body.data);}});return()=>{cancelled=true;};},[request,onToken]);
  function addTier() {
    const last = Number(tiers.at(-1)?.minQuantity) || 1;
    setTiers((all) => [
      ...all,
      {
        id: crypto.randomUUID(),
        minQuantity: String(last + 1),
        unitAmount: "",
        costAmount: "",
        profitMargin: "",
      },
    ]);
  }
  function calculatedPrice(costAmount:string,profitMargin:string){
    const cost=Number(costAmount),margin=Number(profitMargin);
    return costAmount!==""&&profitMargin!==""&&Number.isFinite(cost)&&Number.isFinite(margin)&&margin>=0&&margin<100?(Math.round(cost/(1-margin/100)*100)/100).toFixed(2):"";
  }
  function updateTierDraft(tier:TierDraft,field:keyof Pick<TierDraft,"minQuantity"|"unitAmount"|"costAmount"|"profitMargin">,value:string){
    const next={...tier,[field]:value};
    if(field==="costAmount"||field==="profitMargin")next.unitAmount=calculatedPrice(next.costAmount,next.profitMargin)||next.unitAmount;
    return next;
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
  async function updateCatalogTag() {
    if (!tagEditing || !tagEditing.name.trim()) return;
    setTagActionBusy(true);
    setError("");
    try {
      const next = { ...tagEditing, name: tagEditing.name.trim() };
      const result = await request("/api/v1/product-labels", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      onToken(result.token);
      const body = (await result.response.json().catch(() => ({}))) as ProductErrorBody;
      if (!result.response.ok) throw new Error(body.message ?? (body.error === "not_found" ? "标签已不存在" : `标签更新失败（HTTP ${result.response.status}）`));
      const currentKey = next.currentName.toLowerCase(), updated = { id: crypto.randomUUID(), name: next.name, color: next.color };
      setCatalog((all) => {
        const unique = new Map<string, Tag>();
        for (const item of all) {
          const value = item.name.trim().toLowerCase() === currentKey ? updated : item;
          unique.set(value.name.trim().toLowerCase(), value);
        }
        return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
      });
      setTags((all) => all.map((item) => item.name.trim().toLowerCase() === currentKey ? { ...item, name: next.name, color: next.color } : item));
      setTagEditing(null);
      await onCatalogChanged(`产品标签“${next.name}”已更新`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "标签更新失败");
    } finally {
      setTagActionBusy(false);
    }
  }
  async function deleteCatalogTag(tag: Tag) {
    if (!await confirmAction(`删除产品标签“${tag.name}”后，所有产品都会移除它。`, { title: "删除产品标签？", confirmLabel: "删除" })) return;
    setTagActionBusy(true);
    setError("");
    try {
      const result = await request("/api/v1/product-labels", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: tag.name }),
      });
      onToken(result.token);
      const body = (await result.response.json().catch(() => ({}))) as ProductErrorBody;
      if (!result.response.ok) throw new Error(body.message ?? (body.error === "not_found" ? "标签已不存在" : `标签删除失败（HTTP ${result.response.status}）`));
      const key = tag.name.trim().toLowerCase();
      setCatalog((all) => all.filter((item) => item.name.trim().toLowerCase() !== key));
      setTags((all) => all.filter((item) => item.name.trim().toLowerCase() !== key));
      if (tagEditing?.currentName.trim().toLowerCase() === key) setTagEditing(null);
      await onCatalogChanged(`产品标签“${tag.name}”已删除`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "标签删除失败");
    } finally {
      setTagActionBusy(false);
    }
  }
  async function save() {
    const money = /^\d+(?:\.\d{1,2})?$/,
      positiveNumber=/^\d+(?:\.\d+)?$/,
      quantities = tiers.map((tier) => Number(tier.minQuantity)),
      invalidInternalPricing=tiers.some(tier=>(tier.costAmount==="")!==(tier.profitMargin==="")||(tier.costAmount!==""&&(!money.test(tier.costAmount)||!/^\d+(?:\.\d{1,4})?$/.test(tier.profitMargin)||calculatedPrice(tier.costAmount,tier.profitMargin)!==Number(tier.unitAmount).toFixed(2)))),
      normalizedSupplierLinks=supplierLinks.map(link=>({label:link.label.trim(),url:link.url.trim()})).filter(link=>link.label||link.url);
    if (
      !name.trim() ||
      !sku.trim() ||
      tiers[0]?.minQuantity !== "1" ||
      tiers.some(
        (tier) =>
          !/^\d+$/.test(tier.minQuantity) || !money.test(tier.unitAmount),
      ) ||
      invalidInternalPricing ||
      normalizedSupplierLinks.some(link=>!link.url||!/^https?:\/\//i.test(link.url)) ||
      (weightAmount!==""&&(!positiveNumber.test(weightAmount)||Number(weightAmount)<=0)) ||
      quantities.some(
        (value, index) =>
          value < 1 || (index > 0 && value <= quantities[index - 1]),
      )
    ) {
      setError("请检查名称、SKU、阶梯价格、成本利润率和供应商链接；成本与利润率需同时填写");
      return;
    }
    const variants: ProductVariant[] = variantRows.filter((variant) => variant.sku.trim()).map((variant) => ({ id: variant.id, attributes: variant.attributes, sku: variant.sku.trim(), priceTiers: variant.priceTiers.map((tier) => ({ minQuantity: Number(tier.minQuantity), unitAmount: Number(tier.unitAmount),...(tier.costAmount!==""?{costAmount:Number(tier.costAmount),profitMargin:Number(tier.profitMargin)}:{}) })), imageMediaId: variant.imageMediaId }));
    if (variantRows.some(variant=>variant.priceTiers.some(tier=>(tier.costAmount==="")!==(tier.profitMargin==="")||(tier.costAmount!==""&&calculatedPrice(tier.costAmount,tier.profitMargin)!==Number(tier.unitAmount).toFixed(2))))||variants.some((variant) => !variant.priceTiers.length || variant.priceTiers[0].minQuantity !== 1 || variant.priceTiers.some((tier, index) => !Number.isInteger(tier.minQuantity) || tier.minQuantity < 1 || !Number.isFinite(tier.unitAmount) || (index > 0 && tier.minQuantity <= variant.priceTiers[index - 1].minQuantity)))) { setError("请完善每个变体从数量 1 开始、门槛递增的阶梯价格和成本利润率"); return; }
    setBusy(true);
    setError("");
    try {
      const payload = {
        name: name.trim(),
        sku: sku.trim(),
        description: description.trim(),
        category: category.trim(),
        brand: brand.trim(),
        supplierLinks:normalizedSupplierLinks,
        internalNote:internalNote.trim(),
        currency,
        weightAmount:weightAmount===""?null:Number(weightAmount),
        weightUnit:weightAmount===""?null:weightUnit,
        shippingClassId:product?.shippingClassId&&!shippingClasses.some(item=>item.id===product.shippingClassId)?undefined:shippingClassId||null,
        imageMediaId,
        priceTiers: tiers.map((tier) => ({
          minQuantity: Number(tier.minQuantity),
          unitAmount: Number(tier.unitAmount),
          ...(tier.costAmount!==""?{costAmount:Number(tier.costAmount),profitMargin:Number(tier.profitMargin)}:{}),
        })),
        tags: tags.map((tag) => ({ name: tag.name.trim(), color: tag.color })),
        variants,
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
      const body = (await result.response
        .json()
        .catch(() => ({}))) as ProductErrorBody;
      if (!result.response.ok)
        throw new Error(productSaveError(body, result.response.status));
      await onSaved(product ? "产品资料已更新" : "产品已加入团队产品库");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "产品保存失败");
      setBusy(false);
    }
  }
  function selectImage(asset: ProductImageAsset) {
    if (variantImageIndex !== null) {
      setVariantRows((rows) => rows.map((row, index) => index === variantImageIndex ? { ...row, imageMediaId: asset.id, imageName: asset.fileName } : row));
      setVariantImageIndex(null);
      setImagePickerOpen(false);
      return;
    }
    setImageMediaId(asset.id);
    setImageName(asset.fileName);
    setImagePickerOpen(false);
  }
  function generateVariantCombinations() {
    const dimensions = variantDimensions.map((dimension) => ({ name: dimension.name.trim(), values: [...new Set(dimension.values.split(",").map((value) => value.trim()).filter(Boolean))] })).filter((dimension) => dimension.name && dimension.values.length);
    const combinations = dimensions.reduce<Record<string, string>[]>((all, dimension) => all.flatMap((current) => dimension.values.map((value) => ({ ...current, [dimension.name]: value }))), [{}]);
    const parentTiers = tiers.map((tier) => ({ ...tier, id: crypto.randomUUID() }));
    setVariantRows((current) => combinations.slice(0, 500).map((attributes) => {
      const existing = current.find((row) => JSON.stringify(row.attributes) === JSON.stringify(attributes));
      if (existing) return existing;
      const suffix = Object.values(attributes).map((value) => value.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter(Boolean).join("-");
      return { id: crypto.randomUUID(), attributes, sku: [sku.trim(), suffix].filter(Boolean).join("-"), priceTiers: parentTiers.map((tier) => ({ ...tier, id: crypto.randomUUID() })), imageMediaId: null, imageName: "" };
    }));
  }
  return (
    <>
      <div
        className="modal-backdrop product-dialog-backdrop"
        role="presentation"
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
          <label>
            Shipping class · 可选
            <select value={shippingClassId} onChange={event=>setShippingClassId(event.target.value)}>
              <option value="">未设置（使用默认规则）</option>
              {product?.shippingClassId&&!shippingClasses.some(item=>item.id===product.shippingClassId)&&<option value={product.shippingClassId}>{product.shippingClass??"已停用 class"} · 已停用</option>}
              {shippingClasses.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
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
          <div className="product-form-grid">
            <SearchableCreatableField
              id="product-category"
              label="分类"
              value={category}
              options={categoryOptions}
              placeholder="搜索或创建分类"
              onChange={setCategory}
            />
            <SearchableCreatableField
              id="product-brand"
              label="品牌"
              value={brand}
              options={brandOptions}
              placeholder="搜索或创建品牌"
              onChange={setBrand}
            />
          </div>
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
                            ? updateTierDraft(item,"minQuantity",event.target.value)
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  单件价格
                  <input
                    type="number"
                    value={tier.unitAmount}
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    onPaste={(event) => {
                      const value = event.clipboardData
                        .getData("text")
                        .replace(/\s+/g, "");
                      if (!/^\d*(?:\.\d*)?$/.test(value)) return;
                      event.preventDefault();
                      setTiers((all) =>
                        all.map((item) =>
                          item.id === tier.id
                            ? updateTierDraft(item,"unitAmount",value)
                            : item,
                        ),
                      );
                    }}
                    onChange={(event) =>
                      setTiers((all) =>
                        all.map((item) =>
                          item.id === tier.id
                            ? updateTierDraft(item,"unitAmount",event.target.value)
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  成本 · 内部
                  <input type="number" value={tier.costAmount} inputMode="decimal" min="0" step="0.01" placeholder="可选" onChange={event=>setTiers(all=>all.map(item=>item.id===tier.id?updateTierDraft(item,"costAmount",event.target.value):item))}/>
                </label>
                <label>
                  利润率 % · 内部
                  <input type="number" value={tier.profitMargin} inputMode="decimal" min="0" max="99.9999" step="0.0001" placeholder="可选" onChange={event=>setTiers(all=>all.map(item=>item.id===tier.id?updateTierDraft(item,"profitMargin",event.target.value):item))}/>
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
          <section className="product-supplier-editor">
            <header><span><b>供应商链接</b><small>仅供内部采购参考，可灵活增删</small></span><button type="button" onClick={()=>setSupplierLinks(all=>[...all,{id:crypto.randomUUID(),label:"",url:""}])} disabled={supplierLinks.length>=30}><Plus size={13}/>添加链接</button></header>
            {supplierLinks.map(link=>{const href=link.url.trim(),openable=/^https?:\/\//i.test(href);return <div key={link.id}><input value={link.label} maxLength={120} placeholder="名称，如 1688 供应商" onChange={event=>setSupplierLinks(all=>all.map(item=>item.id===link.id?{...item,label:event.target.value}:item))}/><input type="url" value={link.url} maxLength={2000} placeholder="https://..." onChange={event=>setSupplierLinks(all=>all.map(item=>item.id===link.id?{...item,url:event.target.value}:item))}/><button type="button" className="supplier-link-open" aria-label="打开供应商链接" title={openable?"打开供应商链接":"请输入完整链接后打开"} disabled={!openable} onClick={()=>window.open(href,"_blank","noopener,noreferrer")}><ArrowUpRight size={13}/></button><button type="button" aria-label="删除供应商链接" onClick={()=>setSupplierLinks(all=>all.filter(item=>item.id!==link.id))}><Trash2 size={13}/></button></div>;})}
          </section>
          <label>
            内部备注 · 仅内部可见
            <textarea className="product-description-input product-internal-note" value={internalNote} onChange={event=>setInternalNote(event.target.value)} maxLength={4000} rows={4} placeholder="采购要求、质检重点、供应商沟通信息等；不会出现在产品卡片或客户订单中"/>
            <small className="product-description-count">{internalNote.length}/4000</small>
          </label>
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
          <div className="product-form-grid">
            <label>
              单件重量 · 可选
              <input
                type="number"
                value={weightAmount}
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="例如 500"
                onChange={(event)=>setWeightAmount(event.target.value)}
              />
            </label>
            <label>
              重量单位
              <select value={weightUnit} disabled={!weightAmount} onChange={(event)=>setWeightUnit(event.target.value as WeightUnit)}>
                {WEIGHT_UNITS.map(unit=><option key={unit} value={unit}>{unit}</option>)}
              </select>
            </label>
          </div>
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
          <section className="product-variant-editor">
            <button type="button" className="secondary-action variant-inherit-generate" onClick={generateVariantCombinations}><Plus size={13} />按父 SKU 和阶梯价生成组合</button>
            <header><span><b>产品变体</b><small>添加规格和值后自动生成组合，每个组合可设置独立 SKU、价格和图片。</small></span><button type="button" onClick={() => setVariantDimensions((items) => [...items, { id: crypto.randomUUID(), name: "", values: "" }])}><Plus size={13} />添加规格</button></header>
            {variantDimensions.map((dimension, index) => <div className="product-variant-dimension" key={dimension.id}><input value={dimension.name} placeholder="规格名，如颜色" onChange={(event) => setVariantDimensions((items) => items.map((item) => item.id === dimension.id ? { ...item, name: event.target.value } : item))} /><input value={dimension.values} placeholder="规格值，用逗号分隔，如红色, 蓝色" onChange={(event) => setVariantDimensions((items) => items.map((item) => item.id === dimension.id ? { ...item, values: event.target.value } : item))} /><button type="button" aria-label="删除规格" onClick={() => setVariantDimensions((items) => items.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={13} /></button></div>)}
            <button type="button" className="secondary-action" onClick={() => { const dimensions = variantDimensions.map((dimension) => ({ name: dimension.name.trim(), values: [...new Set(dimension.values.split(",").map((value) => value.trim()).filter(Boolean))] })).filter((dimension) => dimension.name && dimension.values.length); const combinations = dimensions.reduce<Record<string, string>[]>((result, dimension) => result.flatMap((current) => dimension.values.map((value) => ({ ...current, [dimension.name]: value }))), [{}]); setVariantRows((current) => combinations.slice(0, 500).map((attributes) => { const old = current.find((row) => JSON.stringify(row.attributes) === JSON.stringify(attributes)); return old ?? { id: crypto.randomUUID(), attributes, sku: "", priceTiers: [{ id: crypto.randomUUID(), minQuantity: "1", unitAmount: "", costAmount: "", profitMargin: "" }], imageMediaId: null, imageName: "" }; })); }}>生成组合</button>
            {variantRows.map((variant, index) => (
              <div className="product-variant-row" key={variant.id}>
                <header>
                  <span>{Object.entries(variant.attributes).map(([key, value]) => `${key}: ${value}`).join(" / ")}</span>
                  <input value={variant.sku} placeholder="变体 SKU" onChange={(event) => setVariantRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, sku: event.target.value } : row))} />
                  <button type="button" onClick={() => { setVariantImageIndex(index); setImagePickerOpen(true); }}>{variant.imageName || (variant.imageMediaId ? "更换图片" : "选择图片")}</button>
                  <button type="button" aria-label="删除变体" onClick={() => setVariantRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}><Trash2 size={13} /></button>
                </header>
                {variant.imageMediaId && (
                  <div className="product-variant-image-preview">
                    <MediaImagePreview mediaId={variant.imageMediaId} alt={`${variant.sku || "变体"}图片预览`} request={request} onToken={onToken} className="product-image" />
                    <span title={variant.imageName}>{variant.imageName || "当前变体图片"}</span>
                    <button type="button" aria-label="移除变体图片" onClick={() => setVariantRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, imageMediaId: null, imageName: "" } : row))}><Trash2 size={12} />移除图片</button>
                  </div>
                )}
                <div className="product-variant-tier-list">{variant.priceTiers.map((tier, tierIndex) => <div key={tier.id}><input value={tier.minQuantity} disabled={tierIndex === 0} inputMode="numeric" placeholder="起购量" onChange={(event) => setVariantRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, priceTiers: row.priceTiers.map((item, itemIndex) => itemIndex === tierIndex ? updateTierDraft(item,"minQuantity",event.target.value) : item) } : row))} /><input value={tier.unitAmount} inputMode="decimal" placeholder="单价" onChange={(event) => setVariantRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, priceTiers: row.priceTiers.map((item, itemIndex) => itemIndex === tierIndex ? updateTierDraft(item,"unitAmount",event.target.value) : item) } : row))} /><input value={tier.costAmount} inputMode="decimal" placeholder="成本" onChange={(event) => setVariantRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, priceTiers: row.priceTiers.map((item, itemIndex) => itemIndex === tierIndex ? updateTierDraft(item,"costAmount",event.target.value) : item) } : row))} /><input type="number" value={tier.profitMargin} inputMode="decimal" min="0" max="99.9999" step="0.0001" placeholder="利润率 %" onChange={(event) => setVariantRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, priceTiers: row.priceTiers.map((item, itemIndex) => itemIndex === tierIndex ? updateTierDraft(item,"profitMargin",event.target.value) : item) } : row))} />{tierIndex > 0 && <button type="button" aria-label="删除价格档位" onClick={() => setVariantRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, priceTiers: row.priceTiers.filter((_, itemIndex) => itemIndex !== tierIndex) } : row))}><Trash2 size={13} /></button>}</div>)}</div>
                <button type="button" className="variant-add-tier" onClick={() => setVariantRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, priceTiers: [...row.priceTiers, { id: crypto.randomUUID(), minQuantity: String((Number(row.priceTiers.at(-1)?.minQuantity) || 1) + 1), unitAmount: "", costAmount: "", profitMargin: "" }] } : row))}><Plus size={13} />添加价格档位</button>
              </div>
            ))}
          </section>
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
                    {tagMatches.map((tag, index) => {
                      const editing = tagEditing?.currentName.toLowerCase() === tag.name.toLowerCase();
                      return editing ? (
                        <div className="product-label-option-edit" key={tag.id || tag.name}>
                          <input
                            value={tagEditing.name}
                            maxLength={40}
                            autoFocus
                            aria-label={`编辑标签名称 ${tag.name}`}
                            onChange={(event) => setTagEditing({ ...tagEditing, name: event.target.value })}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") { event.preventDefault(); void updateCatalogTag(); }
                              else if (event.key === "Escape") { event.stopPropagation(); setTagEditing(null); }
                            }}
                          />
                          <input type="color" value={tagEditing.color} aria-label={`编辑标签颜色 ${tag.name}`} onChange={(event) => setTagEditing({ ...tagEditing, color: event.target.value })} />
                          <button type="button" disabled={tagActionBusy || !tagEditing.name.trim()} onClick={() => void updateCatalogTag()} aria-label={`保存标签 ${tag.name}`} title="保存"><Check size={13} /></button>
                          <button type="button" disabled={tagActionBusy} onClick={() => setTagEditing(null)} aria-label={`取消编辑标签 ${tag.name}`} title="取消"><X size={13} /></button>
                        </div>
                      ) : (
                        <div className={`product-label-option-row ${index === tagIndex ? "active" : ""}`} role="option" aria-selected={index === tagIndex} key={tag.id || tag.name}>
                          <button type="button" className="product-label-option-add" onMouseDown={(event) => event.preventDefault()} onClick={() => addTag(tag)}>
                            <i style={{ background: tag.color }} />
                            <span><b>{tag.name}</b><small>已有标签</small></span>
                          </button>
                          <span className="product-label-option-actions">
                            <button type="button" disabled={tagActionBusy} onMouseDown={(event) => event.preventDefault()} onClick={() => setTagEditing({ currentName: tag.name, name: tag.name, color: tag.color })} aria-label={`编辑标签 ${tag.name}`} title="编辑标签"><Pencil size={13} /></button>
                            <button type="button" disabled={tagActionBusy} onMouseDown={(event) => event.preventDefault()} onClick={() => void deleteCatalogTag(tag)} aria-label={`删除标签 ${tag.name}`} title="删除标签"><Trash2 size={13} /></button>
                          </span>
                        </div>
                      );
                    })}
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

function productSaveError(body: ProductErrorBody, status: number) {
  if (body.error === "sku_exists") return "SKU 已被另一个有效产品使用";
  if (body.error === "invalid_product_image")
    return "所选产品图片不可用，请重新选择图片";
  if (body.message) return body.message;
  const field = Object.entries(body.details?.fieldErrors ?? {}).find(
    ([, messages]) => messages.length,
  );
  if (field) return `${field[0]}：${field[1][0]}`;
  if (body.details?.formErrors?.[0]) return body.details.formErrors[0];
  return `保存失败（HTTP ${status}）`;
}
