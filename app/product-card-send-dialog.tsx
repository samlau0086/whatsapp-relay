"use client";

import {
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  Languages,
  LoaderCircle,
  Mail,
  MessageCircle,
  Search,
  Send,
  ShoppingBag,
  X,
} from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

type RequestResult = { response: Response; token: string };
type Request = (path: string, init?: RequestInit) => Promise<RequestResult>;
type Product = {
  id: string;
  sku: string;
  name: string;
  category: string;
  currency: string;
  defaultUnitAmount: number;
  imageMediaId: string | null;
  priceTiers: Array<{ minQuantity: number; unitAmount: number }>;
  variants: Array<{ attributes: Record<string, string>; sku: string; imageMediaId: string | null; priceTiers: Array<{ minQuantity: number; unitAmount: number }> }>;
  tags: Array<{ id: string; name: string; color: string }>;
};
type ContactEmail = {
  id: string;
  label: string;
  email: string;
  isPrimary: boolean;
};
type TranslatedProductName = {
  productId: string;
  source: string;
  translated: string;
};
type ProductCardMode = "individual" | "combined" | "grid";
type CurrencyConfig = { code: string; name: string; rate: number };
const GRID_PRESETS = [2, 3, 4, 5, 8] as const;
function mapProduct(item: Record<string, unknown>): Product {
  return {
    id: String(item.id),
    sku: String(item.sku),
    name: String(item.name),
    category: String(item.category ?? ""),
    currency: String(item.currency),
    defaultUnitAmount: Number(item.defaultUnitAmount),
    imageMediaId: item.imageMediaId ? String(item.imageMediaId) : null,
    priceTiers: Array.isArray(item.priceTiers)
      ? (item.priceTiers as Array<Record<string, unknown>>).map((tier) => ({
          minQuantity: Number(tier.minQuantity),
          unitAmount: Number(tier.unitAmount),
        }))
      : [],
    variants: Array.isArray(item.variants)
      ? (item.variants as Array<Record<string, unknown>>).map((variant) => ({
          attributes: (variant.attributes ?? {}) as Record<string, string>,
          sku: String(variant.sku),
          imageMediaId: variant.imageMediaId ? String(variant.imageMediaId) : null,
          priceTiers: Array.isArray(variant.priceTiers)
            ? (variant.priceTiers as Array<Record<string, unknown>>).map((tier) => ({ minQuantity: Number(tier.minQuantity), unitAmount: Number(tier.unitAmount) }))
            : [],
        }))
      : [],
    tags: Array.isArray(item.tags) ? (item.tags as Product["tags"]) : [],
  };
}

function ProductThumbnail({
  mediaId,
  name,
  request,
  onToken,
}: {
  mediaId: string | null;
  name: string;
  request: Request;
  onToken: (token: string) => void;
}) {
  const [url, setUrl] = useState("");
  const requestRef = useRef(request),
    onTokenRef = useRef(onToken);
  useEffect(() => {
    requestRef.current = request;
    onTokenRef.current = onToken;
  }, [request, onToken]);
  useEffect(() => {
    if (!mediaId) return;
    const controller = new AbortController();
    let objectUrl = "";
    void (async () => {
      try {
        const result = await requestRef.current(`/api/v1/media/${mediaId}`, {
          signal: controller.signal,
        });
        onTokenRef.current(result.token);
        if (!result.response.ok) return;
        objectUrl = URL.createObjectURL(await result.response.blob());
        if (!controller.signal.aborted) setUrl(objectUrl);
      } catch {}
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mediaId]);
  return (
    <span className="product-card-thumbnail">
      {url ? (
        <Image src={url} alt={name} width={48} height={48} unoptimized />
      ) : (
        <ShoppingBag size={16} />
      )}
    </span>
  );
}

export function ProductCardSendDialog({
  accountId,
  conversationId,
  contactId,
  translationEnabled,
  translationConfigured,
  targetLanguage,
  targetLanguageName,
  request,
  onToken,
  onClose,
  onSent,
}: {
  accountId: string;
  conversationId: string;
  contactId: string;
  translationEnabled: boolean;
  translationConfigured: boolean;
  targetLanguage: string;
  targetLanguageName: string;
  request: Request;
  onToken: (token: string) => void;
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const [catalogProducts, setCatalogProducts] = useState<Product[]>([]),
    [categories, setCategories] = useState<string[]>([]),
    [category, setCategory] = useState(""),
    [currencies, setCurrencies] = useState<CurrencyConfig[]>([]),
    [targetCurrency, setTargetCurrency] = useState("USD"),
    [productCache, setProductCache] = useState<Map<string, Product>>(
      () => new Map(),
    ),
    [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [exactMatch, setExactMatch] = useState(false),
    [mode, setMode] = useState<ProductCardMode>("individual"),
    [gridPreset, setGridPreset] = useState<
      "2" | "3" | "4" | "5" | "8" | "custom"
    >("2"),
    [customRows, setCustomRows] = useState(2),
    [customColumns, setCustomColumns] = useState(2),
    [gridOutputFormat, setGridOutputFormat] = useState<"image" | "pdf">(
      "image",
    ),
    [showPrice, setShowPrice] = useState(true),
    [translateNames, setTranslateNames] = useState(translationEnabled),
    [channel, setChannel] = useState<"whatsapp" | "email">("whatsapp"),
    [emails, setEmails] = useState<ContactEmail[]>([]),
    [recipientIds, setRecipientIds] = useState<string[]>([]),
    [subjectOverride, setSubject] = useState<string | null>(null),
    [messageBody, setMessageBody] = useState(
      "Hi,\n\nPlease find the requested product information below.\n\nBest regards,",
    ),
    [captionTemplate, setCaptionTemplate] = useState(
      "{{productCount}} products",
    ),
    [captionOverride, setCaptionOverride] = useState<string | null>(null),
    [translationPreview, setTranslationPreview] = useState<{
      source: string;
      translated: string;
      names: TranslatedProductName[];
    } | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [translating, setTranslating] = useState(false),
    [confirming, setConfirming] = useState(false),
    [error, setError] = useState(""),
    [dragId, setDragId] = useState("");
  const requestRef = useRef(request),
    onTokenRef = useRef(onToken);
  const pendingBatchRef = useRef<{ id: string; fingerprint: string } | null>(
    null,
  );
  useEffect(() => {
    const controller = new AbortController();
    void (async () => { try { const result = await requestRef.current("/api/v1/currencies", { signal: controller.signal }); onTokenRef.current(result.token); const body = (await result.response.json().catch(() => ({}))) as { currencies?: CurrencyConfig[] }; if (result.response.ok && body.currencies?.length && !controller.signal.aborted) { setCurrencies(body.currencies); setTargetCurrency(body.currencies.some(item => item.code === "USD") ? "USD" : body.currencies[0].code); } } catch {} })();
    return () => controller.abort();
  }, []);
  useEffect(() => {
    requestRef.current = request;
    onTokenRef.current = onToken;
  }, [request, onToken]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await requestRef.current(
          "/api/v1/product-card-template",
          { signal: controller.signal },
        );
        onTokenRef.current(result.token);
        const body = (await result.response.json().catch(() => ({}))) as {
          template?: { captionTemplate?: string };
        };
        if (result.response.ok && !controller.signal.aborted)
          setCaptionTemplate(
            body.template?.captionTemplate ?? "{{productCount}} products",
          );
      } catch {}
    })();
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const contactResult = await requestRef.current(
          `/api/v1/contacts/${contactId}`,
          { signal: controller.signal },
        );
        onTokenRef.current(contactResult.token);
        const profile = (await contactResult.response.json()) as {
          emails?: Array<Record<string, unknown>>;
        };
        if (!contactResult.response.ok)
          throw new Error(
            `联系人邮箱加载失败（HTTP ${contactResult.response.status}）`,
          );
        if (!controller.signal.aborted) {
          const nextEmails = (profile.emails ?? []).map((item) => ({
            id: String(item.id),
            label: String(item.label ?? ""),
            email: String(item.email),
            isPrimary: Boolean(item.isPrimary ?? item.is_primary),
          }));
          setEmails(nextEmails);
          setRecipientIds(
            nextEmails.filter((item) => item.isPrimary).map((item) => item.id),
          );
        }
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : "联系人邮箱加载失败",
          );
      }
    })();
    return () => controller.abort();
  }, [contactId]);
  useEffect(() => {
    const controller = new AbortController(),
      timer = window.setTimeout(
        () => {
          void (async () => {
            setLoading(true);
            try {
              const needle = query.trim(),
                params = new URLSearchParams({ limit: "100" });
              if (needle) {
                params.set("q", needle);
                if (exactMatch) params.set("exact", "true");
              }
              if (category) params.set("category", category);
              const path = `/api/v1/products?${params.toString()}`,
                productResult = await requestRef.current(path, {
                  signal: controller.signal,
                });
              onTokenRef.current(productResult.token);
              const body = (await productResult.response.json()) as {
                data?: Array<Record<string, unknown>>;
                categories?: string[];
                message?: string;
              };
              if (!productResult.response.ok)
                throw new Error(
                  body.message ?? `HTTP ${productResult.response.status}`,
                );
              if (!controller.signal.aborted) {
                const nextProducts = (body.data ?? []).map(mapProduct);
                setCatalogProducts(nextProducts);
                setCategories(body.categories ?? []);
                setProductCache((current) => {
                  const next = new Map(current);
                  for (const product of nextProducts)
                    next.set(product.id, product);
                  return next;
                });
                setError("");
              }
            } catch (reason) {
              if (!controller.signal.aborted)
                setError(
                  reason instanceof Error ? reason.message : "产品库搜索失败",
                );
            } finally {
              if (!controller.signal.aborted) setLoading(false);
            }
          })();
        },
        query.trim() ? 250 : 0,
      );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, exactMatch, category]);
  const chosen = selected
      .map((id) => productCache.get(id))
      .filter(Boolean) as Product[],
    converted = chosen.map((product) => { const source = currencies.find(item => item.code === product.currency)?.rate; const target = currencies.find(item => item.code === targetCurrency)?.rate; const factor = source && target ? target / source : 1; return {...product, currency: targetCurrency, priceTiers: product.priceTiers.map(tier => ({...tier, unitAmount: tier.unitAmount * factor})),variants:product.variants.map(variant=>({...variant,priceTiers:variant.priceTiers.map(tier=>({...tier,unitAmount:tier.unitAmount*factor}))}))}; }),
    gridSize =
      gridPreset === "custom"
        ? { rows: customRows, columns: customColumns }
        : { rows: Number(gridPreset), columns: Number(gridPreset) },
    gridCapacity = gridSize.rows * gridSize.columns,
    gridPageCount = mode === "grid" ? Math.ceil(selected.length / gridCapacity) : 0;
  const defaultCaption = renderCaptionTemplate(captionTemplate, chosen),
    caption = captionOverride ?? defaultCaption;
  function resetTranslationPreview() {
    setTranslationPreview(null);
    pendingBatchRef.current = null;
  }
  function toggle(id: string) {
    resetTranslationPreview();
    setSelected((all) =>
      all.includes(id) ? all.filter((item) => item !== id) : [...all, id],
    );
  }
  const visibleProductIds = catalogProducts.map((product) => product.id),
    allVisibleSelected =
      visibleProductIds.length > 0 &&
      visibleProductIds.every((id) => selected.includes(id));
  function toggleAllVisible() {
    resetTranslationPreview();
    setSelected((all) => {
      const visible = new Set(visibleProductIds);
      if (visibleProductIds.every((id) => all.includes(id)))
        return all.filter((id) => !visible.has(id));
      const next = [...all];
      for (const id of visibleProductIds) {
        if (next.length >= 50) break;
        if (!next.includes(id)) next.push(id);
      }
      return next;
    });
  }
  function move(id: string, to: number) {
    resetTranslationPreview();
    setSelected((all) => {
      const from = all.indexOf(id);
      if (from < 0 || to < 0 || to >= all.length || from === to) return all;
      const next = [...all],
        [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }
  const subject =
    subjectOverride ??
    (chosen.length === 1
      ? `Product information: ${chosen[0].name}`
      : chosen.length > 1
        ? `Product information (${chosen.length} items)`
        : "Product information");
  async function requestJsonWithTimeout(
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ) {
    const controller = new AbortController(),
      timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await requestRef.current(path, {
        ...init,
        signal: controller.signal,
      });
      onTokenRef.current(result.token);
      const body = (await result.response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      return { result, body };
    } finally {
      window.clearTimeout(timer);
    }
  }
  async function waitForBatch(batchId: string) {
    // eslint-disable-next-line react-hooks/purity -- Polling starts only after an explicit send action.
    const deadline = Date.now() + 20_000,
      path = `/api/v1/conversations/${conversationId}/product-cards/batches/${encodeURIComponent(batchId)}?accountId=${encodeURIComponent(accountId)}`;
    // eslint-disable-next-line react-hooks/purity -- The clock bounds this event-driven polling loop.
    while (Date.now() < deadline) {
      try {
        const { result, body } = await requestJsonWithTimeout(path, {}, 3_500);
        if (result.response.ok && body.committed === true) return true;
        if (
          result.response.status >= 400 &&
          result.response.status < 500 &&
          result.response.status !== 404
        )
          return false;
      } catch {}
      await new Promise((resolve) => window.setTimeout(resolve, 750));
    }
    return false;
  }
  function completeSend(email: boolean) {
    pendingBatchRef.current = null;
    onSent(
      `${selected.length} 个产品${mode === "combined" ? "长图" : mode === "grid" ? "网格拼图" : "卡片"}已进入${email ? "邮件" : "WhatsApp"}发送队列`,
    );
    onClose();
  }
  async function send(
    translatedCaption?: string,
    translationSourceText?: string,
    translatedProductNames?: TranslatedProductName[],
  ) {
    if (!selected.length) return;
    if (mode === "combined" && selected.length > 10) {
      setError("合并长图一次最多选择 10 个产品");
      return;
    }
    if (channel === "email" && !recipientIds.length) {
      setError("请选择至少一个联系人邮箱");
      return;
    }
    const email = channel === "email",
      sourceCaption = caption.trim();
    const shouldTranslateCaption = Boolean(sourceCaption && translationEnabled),
      shouldTranslateNames = translateNames && chosen.length > 0;
    if (
      !email &&
      translatedCaption === undefined &&
      translatedProductNames === undefined &&
      (shouldTranslateCaption || shouldTranslateNames)
    ) {
      if (!translationConfigured) {
        setError("AI 翻译暂不可用，请联系管理员配置 Provider");
        return;
      }
      setTranslating(true);
      setError("");
      try {
        const [captionResult, nameResult] = await Promise.all([
          shouldTranslateCaption
            ? requestJsonWithTimeout(
                "/api/v1/translations/preview",
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ text: sourceCaption, targetLanguage }),
                },
                45_000,
              )
            : Promise.resolve(null),
          shouldTranslateNames
            ? requestJsonWithTimeout(
                "/api/v1/translations/product-names/preview",
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    names: chosen.map((product) => product.name),
                    targetLanguage,
                  }),
                },
                45_000,
              )
            : Promise.resolve(null),
        ]);
        if (
          captionResult &&
          (!captionResult.result.response.ok ||
            !captionResult.body.translatedText)
        )
          throw new Error(
            String(captionResult.body.message ?? "图片说明翻译失败"),
          );
        const translatedNames = nameResult?.body.translatedNames;
        if (
          nameResult &&
          (!nameResult.result.response.ok ||
            !Array.isArray(translatedNames) ||
            translatedNames.length !== chosen.length)
        )
          throw new Error(
            String(nameResult.body.message ?? "产品名称翻译失败"),
          );
        setTranslationPreview({
          source: sourceCaption,
          translated: captionResult
            ? String(captionResult.body.translatedText)
            : sourceCaption,
          names: nameResult
            ? chosen.map((product, index) => ({
                productId: product.id,
                source: product.name,
                translated: String((translatedNames as unknown[])[index]),
              }))
            : [],
        });
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "AI 翻译失败，产品卡片未发送",
        );
      } finally {
        setTranslating(false);
      }
      return;
    }
    const outgoingCaption = (translatedCaption ?? sourceCaption).trim();
    setBusy(true);
    setConfirming(false);
    setError("");
    const outgoingNames = translatedProductNames?.map((item) => ({
      productId: item.productId,
      name: item.translated.trim(),
    }));
    const translationTargetLanguage =
      translationSourceText || outgoingNames?.length
        ? targetLanguage
        : undefined;
    const grid = mode === "grid" ? gridSize : undefined,
      fingerprint = JSON.stringify({
        accountId,
        conversationId,
        productIds: selected,
        mode,
        grid,
        gridOutputFormat: mode === "grid" ? gridOutputFormat : undefined,
        showPrice,
        targetCurrency,
        caption: outgoingCaption,
        translationSourceText,
        translationTargetLanguage,
        translatedProductNames: outgoingNames,
      }),
      pending = pendingBatchRef.current,
      clientBatchId =
        pending?.fingerprint === fingerprint ? pending.id : crypto.randomUUID();
    if (!email) pendingBatchRef.current = { id: clientBatchId, fingerprint };
    try {
      if (email) {
        const result = await request(
          `/api/v1/conversations/${conversationId}/email-sends`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              clientSendId: crypto.randomUUID(),
              targetCurrency,
              recipientEmailIds: recipientIds,
              subject,
              messageBody,
              content: {
                type: "product_cards",
                productIds: selected,
                mode,
                grid,
                gridOutputFormat: mode === "grid" ? gridOutputFormat : undefined,
                showPrice,
                targetCurrency,
              },
            }),
          },
        );
        onToken(result.token);
        const body = (await result.response.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        if (!result.response.ok)
          throw new Error(
            body.message ?? body.error ?? `HTTP ${result.response.status}`,
          );
        completeSend(true);
        return;
      }
      const { result, body } = await requestJsonWithTimeout(
        `/api/v1/conversations/${conversationId}/product-cards/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountId,
            clientBatchId,
            productIds: selected,
            mode,
            grid,
            gridOutputFormat: mode === "grid" ? gridOutputFormat : undefined,
            showPrice,
            caption: outgoingCaption,
            translationSourceText,
            translationTargetLanguage,
            translatedProductNames: outgoingNames,
          }),
        },
        15_000,
      );
      if (!result.response.ok) {
        const failure = Object.assign(
          new Error(
            String(
              body.message ?? body.error ?? `HTTP ${result.response.status}`,
            ),
          ),
          { recoverable: result.response.status >= 500 },
        );
        throw failure;
      }
      completeSend(false);
    } catch (reason) {
      const recoverable =
        !email &&
        (reason instanceof TypeError ||
          (reason instanceof DOMException && reason.name === "AbortError") ||
          Boolean((reason as { recoverable?: boolean })?.recoverable));
      if (recoverable) {
        setConfirming(true);
        if (await waitForBatch(clientBatchId)) {
          completeSend(false);
          return;
        }
        setError(
          "发送请求超时，暂未确认是否已入队。请稍后重试；系统会复用同一批次，不会重复发送。",
        );
      } else
        setError(reason instanceof Error ? reason.message : "产品卡片发送失败");
    } finally {
      setConfirming(false);
      setBusy(false);
    }
  }
  const unavailable = busy || translating;
  return (
    <div
      className="modal-backdrop product-card-send-backdrop"
      role="presentation"
    >
      <section
        className="product-card-send-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-card-send-title"
      >
        <header>
          <span>
            <ShoppingBag size={20} />
            <span>
              <b id="product-card-send-title">发送产品卡片</b>
              <small>搜索并选择要直接发送给客户的产品</small>
            </span>
          </span>
          <button onClick={onClose} disabled={unavailable} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="product-card-send-body">
          <section className="product-card-catalog">
            <div className="product-card-search">
              <label>
                <Search size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={
                    exactMatch
                      ? "输入完整 SKU 或产品标题"
                      : "搜索名称、SKU 或标签"
                  }
                />
              </label>
              <label className="product-card-exact-toggle">
                <span>
                  <b>精准匹配</b>
                  <small>完整匹配 SKU 或标题</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="精准匹配 SKU 或标题"
                  checked={exactMatch}
                  onChange={(event) => setExactMatch(event.target.checked)}
                />
              </label>
            </div>
            <div className="product-card-filter-bar">
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                aria-label="按类目筛选产品"
              >
                <option value="">全部类目</option>
                {categories.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              <label>
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  disabled={loading || catalogProducts.length === 0}
                  onChange={toggleAllVisible}
                />
                <span>全选当前结果</span>
              </label>
              <small>{catalogProducts.length} 个产品</small>
            </div>
            <div>
              {loading ? (
                <p>{query.trim() ? "正在搜索产品…" : "正在读取产品库…"}</p>
              ) : catalogProducts.length ? (
                catalogProducts.map((product) => (
                  <button
                    key={product.id}
                    className={selected.includes(product.id) ? "selected" : ""}
                    onClick={() => toggle(product.id)}
                  >
                    <ProductThumbnail
                      mediaId={product.imageMediaId}
                      name={product.name}
                      request={request}
                      onToken={onToken}
                    />
                    <span>
                      <b>{product.name}</b>
                      <small>
                        {product.sku} ·{" "}
                        {product.tags.map((tag) => tag.name).join(" · ") ||
                          "暂无标签"}
                      </small>
                    </span>
                    <strong>
                      {product.currency} {product.defaultUnitAmount.toFixed(2)}{" "}
                      起
                    </strong>
                    {selected.includes(product.id) && <Check size={15} />}
                  </button>
                ))
              ) : (
                <p>
                  {exactMatch && query.trim()
                    ? "没有找到 SKU 或标题完全一致的产品"
                    : "没有找到匹配的产品"}
                </p>
              )}
            </div>
          </section>
          <section className="product-card-selection">
            <header>
              <b>已选择 {chosen.length} 个</b>
              <span>
                {mode === "combined"
                  ? "长图最多 10 个"
                  : mode === "grid"
                    ? `${gridSize.rows}×${gridSize.columns} · 最多 ${gridCapacity} 个`
                    : "独立卡片最多 50 个"}
              </span>
            </header>
            <div className="product-card-selected-list">
              {chosen.length ? (
                chosen.map((product, index) => (
                  <article
                    key={product.id}
                    draggable
                    onDragStart={() => setDragId(product.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      move(dragId, index);
                      setDragId("");
                    }}
                  >
                    <GripVertical size={14} />
                    <span>
                      <b>{product.name}</b>
                      <small>{product.sku}</small>
                    </span>
                    <button
                      disabled={index === 0}
                      onClick={() => move(product.id, index - 1)}
                      aria-label="上移"
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      disabled={index === chosen.length - 1}
                      onClick={() => move(product.id, index + 1)}
                      aria-label="下移"
                    >
                      <ArrowDown size={12} />
                    </button>
                    <button
                      onClick={() => toggle(product.id)}
                      aria-label="移除"
                    >
                      <X size={12} />
                    </button>
                  </article>
                ))
              ) : (
                <p>从左侧选择产品</p>
              )}
            </div>
            <div className="product-card-options">
              <label>
                输出币种
                <select value={targetCurrency} onChange={(event) => setTargetCurrency(event.target.value)} disabled={!currencies.length}>
                  {currencies.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}
                </select>
                <small>发送前统一换算，默认 USD</small>
              </label>
              <label>
                <input
                  type="radio"
                  checked={mode === "individual"}
                  onChange={() => setMode("individual")}
                />
                逐个发送独立卡片
              </label>
              <label>
                <input
                  type="radio"
                  checked={mode === "combined"}
                  onChange={() => setMode("combined")}
                />
                合并为一张长图
              </label>
              <label>
                <input
                  type="radio"
                  checked={mode === "grid"}
                  onChange={() => setMode("grid")}
                />
                合并为网格拼图
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showPrice}
                  onChange={(event) => setShowPrice(event.target.checked)}
                />
                显示阶梯价格
              </label>
              <label>
                <input
                  type="checkbox"
                  role="switch"
                  checked={translateNames}
                  disabled={channel === "email"}
                  onChange={(event) => {
                    setTranslateNames(event.target.checked);
                    resetTranslationPreview();
                  }}
                />
                自动翻译产品名称
                {channel === "whatsapp" && (
                  <small>发送前翻译为 {targetLanguageName}</small>
                )}
              </label>
            </div>
            {mode === "grid" && (
              <div
                className="product-card-grid-settings"
                role="group"
                aria-label="网格拼图规格"
              >
                <div className="product-card-grid-presets">
                  {GRID_PRESETS.map((size) => (
                    <button
                      key={size}
                      type="button"
                      className={gridPreset === String(size) ? "active" : ""}
                      aria-pressed={gridPreset === String(size)}
                      onClick={() =>
                        setGridPreset(
                          String(size) as "2" | "3" | "4" | "5" | "8",
                        )
                      }
                    >
                      {size}×{size}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={gridPreset === "custom" ? "active" : ""}
                    aria-pressed={gridPreset === "custom"}
                    onClick={() => setGridPreset("custom")}
                  >
                    自定义
                  </button>
                </div>
                {gridPreset === "custom" && (
                  <div className="product-card-grid-custom">
                    <label>
                      行
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={customRows}
                        onChange={(event) =>
                          setCustomRows(
                            Math.min(
                              10,
                              Math.max(1, Number(event.target.value) || 1),
                            ),
                          )
                        }
                      />
                    </label>
                    <span>×</span>
                    <label>
                      列
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={customColumns}
                        onChange={(event) =>
                          setCustomColumns(
                            Math.min(
                              10,
                              Math.max(1, Number(event.target.value) || 1),
                            ),
                          )
                        }
                      />
                    </label>
                  </div>
                )}
                <div className="product-card-grid-output" role="group" aria-label="输出格式">
                  <span>输出格式</span>
                  <button
                    type="button"
                    className={gridOutputFormat === "image" ? "active" : ""}
                    aria-pressed={gridOutputFormat === "image"}
                    onClick={() => setGridOutputFormat("image")}
                  >
                    图片
                  </button>
                  <button
                    type="button"
                    className={gridOutputFormat === "pdf" ? "active" : ""}
                    aria-pressed={gridOutputFormat === "pdf"}
                    onClick={() => setGridOutputFormat("pdf")}
                  >
                    PDF
                  </button>
                </div>
                <small>
                  按当前排序从左到右、从上到下排列，每张容纳 {gridCapacity} 个产品
                  {selected.length > 0 &&
                    (gridOutputFormat === "pdf"
                      ? `，将生成 1 个包含 ${gridPageCount} 页的 PDF。`
                      : `，将生成 ${gridPageCount} 张网格拼图。`)}
                </small>
              </div>
            )}
            <div className="email-channel-picker">
              <button
                className={channel === "whatsapp" ? "active" : ""}
                onClick={() => setChannel("whatsapp")}
              >
                <MessageCircle size={13} />
                WhatsApp
              </button>
              <button
                className={channel === "email" ? "active" : ""}
                onClick={() => setChannel("email")}
              >
                <Mail size={13} />
                Email
              </button>
            </div>
            {channel === "email" ? (
              <div className="email-compose-fields">
                <fieldset>
                  <legend>收件人</legend>
                  {emails.length ? (
                    emails.map((item) => (
                      <label key={item.id}>
                        <input
                          type="checkbox"
                          checked={recipientIds.includes(item.id)}
                          onChange={() =>
                            setRecipientIds((ids) =>
                              ids.includes(item.id)
                                ? ids.filter((id) => id !== item.id)
                                : [...ids, item.id],
                            )
                          }
                        />
                        <span>
                          {item.label || "邮箱"} · {item.email}
                          {item.isPrimary ? " · Primary" : ""}
                        </span>
                      </label>
                    ))
                  ) : (
                    <p>联系人尚未保存邮箱，请先编辑联系人资料。</p>
                  )}
                </fieldset>
                <label>
                  邮件主题
                  <input
                    value={subject}
                    maxLength={200}
                    onChange={(event) => setSubject(event.target.value)}
                  />
                </label>
                <label>
                  正文说明
                  <textarea
                    value={messageBody}
                    maxLength={5000}
                    onChange={(event) => setMessageBody(event.target.value)}
                  />
                </label>
              </div>
            ) : (
              <label className="product-card-caption">
                图片说明（可选）
                {translationEnabled && (
                  <span className="material-caption-translation">
                    <Languages size={11} />
                    发送前自动翻译为 {targetLanguageName}
                  </span>
                )}
                <textarea
                  value={caption}
                  maxLength={65536}
                  onChange={(event) => {
                    setCaptionOverride(event.target.value);
                    resetTranslationPreview();
                  }}
                  placeholder="随图片一起发送的文字"
                />
                <small>默认取自产品卡片模板，可在本次发送前修改。</small>
              </label>
            )}
            <div
              className={`product-card-live-preview ${mode === "grid" ? "grid-preview" : ""}`}
              style={
                mode === "grid"
                  ? {
                      gridTemplateColumns: `repeat(${Math.min(gridSize.columns, 5)}, minmax(0, 1fr))`,
                    }
                  : undefined
              }
            >
              <b>发送预览</b>
              {converted
                .slice(
                  0,
                  mode === "combined" ? 10 : mode === "grid" ? gridCapacity : 3,
                )
                .map((product) => (
                  <div key={product.id}>
                    <strong>{product.name}</strong>
                    <span>SKU: {product.sku}</span>
                    {showPrice && <ProductPricingPreview product={product} />}
                  </div>
                ))}
              {chosen.length >
                (mode === "combined"
                  ? 10
                  : mode === "grid"
                    ? gridCapacity
                    : 3) && (
                <p>
                  另有{" "}
                  {chosen.length -
                    (mode === "combined"
                      ? 10
                      : mode === "grid"
                        ? gridCapacity
                        : 3)}{" "}
                  个产品
                </p>
              )}
            </div>
          </section>
        </div>
        {error && (
          <span className="login-error product-card-send-error">{error}</span>
        )}
        <footer>
          <button
            className="secondary-action"
            onClick={onClose}
            disabled={unavailable}
          >
            取消
          </button>
          <button
            className="primary-action"
            onClick={() => void send()}
            disabled={
              unavailable ||
              !selected.length ||
              (mode === "combined" && selected.length > 10) ||
              (channel === "email" && (!recipientIds.length || !subject.trim()))
            }
          >
            {translating ? (
              <>
                <LoaderCircle className="spin" size={14} />
                正在翻译…
              </>
            ) : busy ? (
              <>
                <LoaderCircle className="spin" size={14} />
                {confirming ? "正在确认发送状态…" : "正在生成卡片…"}
              </>
            ) : (translationEnabled &&
                channel === "whatsapp" &&
                caption.trim()) ||
              (translateNames && channel === "whatsapp") ? (
              <>
                <Languages size={14} />
                翻译并预览
              </>
            ) : (
              <>
                <Send size={14} />
                {`通过 ${channel === "email" ? "Email" : "WhatsApp"} 发送 ${selected.length || ""} 个产品`}
              </>
            )}
          </button>
        </footer>
        {translationPreview && (
          <ProductCardTranslationConfirm
            source={translationPreview.source}
            translated={translationPreview.translated}
            names={translationPreview.names}
            targetLanguageName={targetLanguageName}
            busy={unavailable}
            onClose={() => setTranslationPreview(null)}
            onConfirm={(text, names) => {
              setTranslationPreview(null);
              void send(text, translationPreview.source || undefined, names);
            }}
          />
        )}
      </section>
    </div>
  );
}

function ProductPricingPreview({ product }: { product: Product }) {
  const groups = product.variants.length
    ? product.variants.map((variant) => ({
        title:
          Object.entries(variant.attributes)
            .map(([key, value]) => `${key}: ${value}`)
            .join(" / ") || variant.sku,
        sku: variant.sku,
        tiers: variant.priceTiers,
      }))
    : [{ title: "", sku: product.sku, tiers: product.priceTiers }];
  return (
    <div className="product-card-send-price-preview">
      {groups.filter((group) => group.tiers.length).map((group) => (
        <section key={group.sku}>
          {group.title && <b>{group.title}</b>}
          <div className="product-card-send-price-table">
            <span>SKU</span><span>QTY</span><span>Price</span>
            {group.tiers.map((tier) => (
              <div key={tier.minQuantity}>
                <span>{group.sku}</span>
                <span>{tier.minQuantity}+</span>
                <span>{product.currency} {tier.unitAmount.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ProductCardTranslationConfirm({
  source,
  translated,
  names,
  targetLanguageName,
  busy,
  onClose,
  onConfirm,
}: {
  source: string;
  translated: string;
  names: TranslatedProductName[];
  targetLanguageName: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (text: string, names: TranslatedProductName[]) => void;
}) {
  const [text, setText] = useState(translated),
    [editedNames, setEditedNames] = useState(names);
  const invalidName = editedNames.some((item) => !item.translated.trim());
  return (
    <div className="material-translation-confirm-backdrop" role="presentation">
      <section
        className="login-dialog translation-preview-dialog material-translation-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-card-translation-title"
      >
        <button
          className="login-close"
          onClick={onClose}
          disabled={busy}
          aria-label="关闭翻译确认"
        >
          <X size={17} />
        </button>
        <span className="login-logo">
          <Languages size={21} />
        </span>
        <h2 id="product-card-translation-title">确认产品卡片翻译</h2>
        <p>已翻译为 {targetLanguageName}。请确认或修改译文后再发送产品卡片。</p>
        {names.length > 0 && (
          <div className="product-name-translation-list">
            <b>产品名称</b>
            {editedNames.map((item, index) => (
              <label key={item.productId}>
                <span>{item.source}</span>
                <input
                  value={item.translated}
                  maxLength={120}
                  onChange={(event) =>
                    setEditedNames((all) =>
                      all.map((name, nameIndex) =>
                        nameIndex === index
                          ? { ...name, translated: event.target.value }
                          : name,
                      ),
                    )
                  }
                />
              </label>
            ))}
          </div>
        )}
        {source && (
          <>
            <label>
              图片说明原文
              <textarea value={source} readOnly />
            </label>
            <label>
              将发送的图片说明
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                maxLength={65536}
              />
            </label>
          </>
        )}
        <div className="translation-preview-actions">
          <button
            className="secondary-action"
            onClick={onClose}
            disabled={busy}
          >
            返回修改
          </button>
          <button
            className="primary-action"
            disabled={busy || invalidName || (Boolean(source) && !text.trim())}
            onClick={() => onConfirm(text.trim(), editedNames)}
          >
            <Send size={14} />
            确认并发送卡片
          </button>
        </div>
      </section>
    </div>
  );
}

function renderCaptionTemplate(template: string, products: Product[]): string {
  const first = products[0],
    values: Record<string, string> = {
      productCount: String(products.length),
      productNames: products.map((product) => product.name).join("、"),
      productName: first?.name ?? "",
      sku: first?.sku ?? "",
    };
  return template
    .replace(
      /{{\s*(productCount|productNames|productName|sku)\s*}}/g,
      (_, key: string) => values[key] ?? "",
    )
    .trim();
}
