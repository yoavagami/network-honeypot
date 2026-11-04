import { esc } from "../render/layout.js";
import { PRODUCTS, SHIPPING_METHODS, formatPrice, fromPrice, type Product, type ShippingMethodId } from "./catalog.js";
import { lineDetails, type CartLine, type CheckoutDetails, type PlacedOrder, type Totals } from "./cart.js";
import type { PaymentProvider } from "./payments.js";

const demoNotice = () => process.env.SHOP_DEMO_NOTICE !== "false";

export function shopLayout(opts: { title: string; body: string; cartCount: number; head?: string; scripts?: string[]; description?: string }): string {
  const scripts = ["/assets/app.js", ...(opts.scripts ?? [])].map((s) => `<script src="${s}" defer></script>`).join("\n  ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(opts.title)} | uHoney</title>
  <meta name="description" content="${esc(opts.description ?? "Raw Dutch honey from our own hives, shipped across Europe.")}" />
  <link rel="stylesheet" href="/assets/shop.css" />
  <link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml" />
  ${opts.head ?? ""}
</head>
<body>
  <div class="announce">Free standard shipping in the Netherlands on orders over €40</div>
  <header class="shop-header">
    <a href="/" class="logo"><span class="logo-mark">u</span>Honey</a>
    <nav class="shop-nav">
      <a href="/">Shop</a>
      <a href="/about">Our bees</a>
      <a href="/shipping">Shipping &amp; returns</a>
    </nav>
    <a href="/cart" class="cart-link" aria-label="Basket">Basket <span class="cart-count">${opts.cartCount}</span></a>
  </header>
  <main class="shop-main">
    ${opts.body}
  </main>
  <footer class="shop-footer">
    <div class="footer-cols">
      <div><strong>uHoney</strong><p>Small-batch raw honey from hives in Gelderland and the Veluwe.</p></div>
      <div><strong>Shop</strong>${PRODUCTS.map((p) => `<a href="/products/${p.slug}">${esc(p.name)}</a>`).join("")}</div>
      <div><strong>Help</strong><a href="/shipping">Shipping &amp; returns</a><a href="/terms">Terms &amp; conditions</a><a href="/privacy">Privacy</a></div>
      <div><strong>Business</strong><a href="/login">Wholesale login</a><a href="/docs">Partner API</a></div>
    </div>
    <p class="fineprint">&copy; ${new Date().getFullYear()} uHoney${demoNotice() ? " &middot; Demonstration store: orders are not charged or shipped." : ""}</p>
  </footer>
  ${scripts}
</body>
</html>`;
}

function jar(p: Product, size: "lg" | "sm" = "lg") {
  return `<img class="jar jar-${size}" src="${p.image}" alt="${esc(p.name)} jar" width="${size === "lg" ? 420 : 96}" height="${size === "lg" ? 420 : 96}" />`;
}

export function shopHomePage(): string {
  const cards = PRODUCTS.map(
    (p) => `
    <a class="product-card" href="/products/${p.slug}">
      ${jar(p)}
      <h3>${esc(p.name)}</h3>
      <p class="muted">${esc(p.tagline)}</p>
      <p class="price">from ${formatPrice(fromPrice(p))}</p>
    </a>`
  ).join("");
  return `
    <section class="hero">
      <h1>Raw honey, straight from our hives</h1>
      <p>Cold-extracted, unfiltered and never blended. Two honeys, two seasons, one small apiary.</p>
      <a class="btn" href="#honeys">Shop the honey</a>
    </section>
    <section id="honeys" class="product-grid">${cards}</section>
    <section class="usp">
      <div><strong>Single origin</strong><p>Every jar comes from our own hives — we know which field it came from.</p></div>
      <div><strong>Never heated</strong><p>Extracted cold so the enzymes and pollen stay in.</p></div>
      <div><strong>Fast delivery</strong><p>Ordered before 16:00, shipped the same day with PostNL.</p></div>
    </section>`;
}

export function productPage(p: Product, opts: { added?: string; error?: string }): { body: string; head: string } {
  const variants = p.variants
    .map(
      (v, i) => `
      <label class="variant">
        <input type="radio" name="sku" value="${v.sku}" ${i === 0 ? "checked" : ""} />
        <span class="variant-label">${esc(v.label)}</span>
        <span class="variant-price">${formatPrice(v.priceCents)}</span>
        <span class="variant-stock">${v.stock <= 5 ? `Only ${v.stock} left` : "In stock"}</span>
      </label>`
    )
    .join("");
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    description: p.description.join(" "),
    image: `https://uhoney.shop${p.image}`,
    brand: { "@type": "Brand", name: "uHoney" },
    offers: p.variants.map((v) => ({
      "@type": "Offer",
      sku: v.sku,
      name: `${p.name} ${v.label}`,
      price: (v.priceCents / 100).toFixed(2),
      priceCurrency: "EUR",
      availability: v.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: `https://uhoney.shop/products/${p.slug}`,
    })),
  };
  const head = `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`;
  return {
    head,
    body: `
    <nav class="crumbs"><a href="/">Shop</a> / ${esc(p.name)}</nav>
    <section class="product">
      <div class="product-media">${jar(p)}</div>
      <div class="product-info">
        <h1>${esc(p.name)}</h1>
        <p class="lead">${esc(p.tagline)}</p>
        ${opts.added ? `<div class="notice">Added to your basket. <a href="/cart">View basket</a></div>` : ""}
        ${opts.error ? `<div class="alert">${esc(opts.error)}</div>` : ""}
        <form method="post" action="/cart/add" class="buy-box">
          <fieldset class="variants"><legend>Size</legend>${variants}</fieldset>
          <label class="qty">Quantity <input type="number" name="qty" value="1" min="1" max="10" /></label>
          <button type="submit" class="btn btn-wide">Add to basket</button>
          <p class="muted small">Incl. VAT. Ships in 1–2 working days.</p>
        </form>
        ${p.description.map((d) => `<p>${esc(d)}</p>`).join("")}
        <dl class="specs">
          <dt>Origin</dt><dd>${esc(p.origin)}</dd>
          <dt>Tasting notes</dt><dd>${esc(p.tastingNotes)}</dd>
          ${p.details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
        </dl>
      </div>
    </section>`,
  };
}

export function cartPage(lines: CartLine[], totals: Totals, notice?: string): string {
  if (lines.length === 0) {
    return `<h1>Your basket</h1><p>Your basket is empty.</p><a class="btn" href="/">Continue shopping</a>`;
  }
  const rows = lineDetails(lines)
    .map(
      (l) => `
      <tr>
        <td class="cart-item">${jar(l.product, "sm")}<div><a href="/products/${l.product.slug}">${esc(l.product.name)}</a><span class="muted">${esc(l.variant.label)}</span></div></td>
        <td>${formatPrice(l.variant.priceCents)}</td>
        <td>
          <form method="post" action="/cart/update" class="qty-form">
            <input type="hidden" name="sku" value="${l.sku}" />
            <input type="number" name="qty" value="${l.qty}" min="0" max="10" aria-label="Quantity" />
            <button type="submit" class="link-btn">Update</button>
          </form>
        </td>
        <td>${formatPrice(l.lineCents)}</td>
        <td><form method="post" action="/cart/update"><input type="hidden" name="sku" value="${l.sku}" /><input type="hidden" name="qty" value="0" /><button type="submit" class="link-btn" aria-label="Remove">Remove</button></form></td>
      </tr>`
    )
    .join("");
  return `
    <h1>Your basket</h1>
    ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
    <table class="cart-table">
      <thead><tr><th>Product</th><th>Price</th><th>Quantity</th><th>Total</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="cart-summary">
      ${summaryBlock(totals, "standard")}
      <a class="btn btn-wide" href="/checkout">Checkout</a>
      <a class="muted small" href="/">Continue shopping</a>
    </div>`;
}

function summaryBlock(t: Totals, shipping: ShippingMethodId | undefined, final = false) {
  return `
    <dl class="totals">
      <dt>Subtotal</dt><dd>${formatPrice(t.subtotalCents)}</dd>
      <dt>Shipping${shipping ? "" : " (estimated)"}</dt><dd>${t.shippingCents === 0 ? "Free" : formatPrice(t.shippingCents)}</dd>
      <dt class="grand">Total</dt><dd class="grand">${formatPrice(t.totalCents)}</dd>
      <dt class="muted small">${final ? "Includes" : "Incl."} VAT (9%)</dt><dd class="muted small">${formatPrice(t.vatCents)}</dd>
    </dl>`;
}

function steps(active: 1 | 2 | 3) {
  const names = ["Details", "Shipping", "Payment"];
  return `<ol class="steps">${names.map((n, i) => `<li class="${i + 1 === active ? "active" : i + 1 < active ? "done" : ""}">${n}</li>`).join("")}</ol>`;
}

function orderSidebar(lines: CartLine[], totals: Totals, shipping?: ShippingMethodId) {
  const items = lineDetails(lines)
    .map((l) => `<li>${jar(l.product, "sm")}<span>${esc(l.product.name)} · ${esc(l.variant.label)} × ${l.qty}</span><span>${formatPrice(l.lineCents)}</span></li>`)
    .join("");
  return `<aside class="order-side"><h2>Order summary</h2><ul class="side-items">${items}</ul>${summaryBlock(totals, shipping)}<a class="small" href="/cart">Edit basket</a></aside>`;
}

const COUNTRIES = [["NL", "Netherlands"], ["BE", "Belgium"], ["DE", "Germany"], ["FR", "France"], ["LU", "Luxembourg"]];

export function checkoutDetailsPage(lines: CartLine[], totals: Totals, d: Partial<CheckoutDetails>, error?: string): string {
  const v = (k: keyof CheckoutDetails) => esc(d[k] ?? "");
  return `
    <div class="checkout">
      <section class="checkout-main">
        ${steps(1)}
        <h1>Contact &amp; delivery</h1>
        ${error ? `<div class="alert">${esc(error)}</div>` : ""}
        <form method="post" action="/checkout/details" class="checkout-form">
          <label>Email<input type="email" name="email" value="${v("email")}" autocomplete="email" required /></label>
          <div class="row">
            <label>First name<input name="firstName" value="${v("firstName")}" autocomplete="given-name" required /></label>
            <label>Last name<input name="lastName" value="${v("lastName")}" autocomplete="family-name" required /></label>
          </div>
          <label>Street and house number<input name="address" value="${v("address")}" autocomplete="street-address" required /></label>
          <div class="row">
            <label>Postcode<input name="postcode" value="${v("postcode")}" autocomplete="postal-code" required /></label>
            <label>City<input name="city" value="${v("city")}" autocomplete="address-level2" required /></label>
          </div>
          <label>Country<select name="country" autocomplete="country">${COUNTRIES.map(([c, n]) => `<option value="${c}" ${d.country === c || (!d.country && c === "NL") ? "selected" : ""}>${n}</option>`).join("")}</select></label>
          <label>Phone (optional, for delivery updates)<input type="tel" name="phone" value="${v("phone")}" autocomplete="tel" /></label>
          <button type="submit" class="btn btn-wide">Continue to shipping</button>
        </form>
      </section>
      ${orderSidebar(lines, totals)}
    </div>`;
}

export function checkoutShippingPage(lines: CartLine[], totals: Totals, d: CheckoutDetails, selected: ShippingMethodId | undefined, subtotalCents: number): string {
  const options = SHIPPING_METHODS.map((m) => {
    const free = m.freeOverCents !== null && subtotalCents >= m.freeOverCents;
    return `<label class="ship-option"><input type="radio" name="shipping" value="${m.id}" ${(selected ?? "standard") === m.id ? "checked" : ""} /><span>${esc(m.label)}</span><strong>${free ? "Free" : formatPrice(m.priceCents)}</strong></label>`;
  }).join("");
  return `
    <div class="checkout">
      <section class="checkout-main">
        ${steps(2)}
        <div class="review-box"><span class="muted">Ship to</span><span>${esc(d.firstName)} ${esc(d.lastName)}, ${esc(d.address)}, ${esc(d.postcode)} ${esc(d.city)}</span><a href="/checkout">Change</a></div>
        <h1>Shipping method</h1>
        <form method="post" action="/checkout/shipping" class="checkout-form">
          ${options}
          <button type="submit" class="btn btn-wide">Continue to payment</button>
        </form>
      </section>
      ${orderSidebar(lines, totals, selected)}
    </div>`;
}

export function checkoutPaymentPage(lines: CartLine[], totals: Totals, d: CheckoutDetails, shipping: ShippingMethodId, providers: PaymentProvider[], error?: string, selected?: string): string {
  const method = SHIPPING_METHODS.find((m) => m.id === shipping)!;
  const chosen = selected ?? providers[0]?.id;
  const options = providers
    .map(
      (p) => `
      <div class="pay-option">
        <label class="pay-option-head"><input type="radio" name="method" value="${p.id}" ${p.id === chosen ? "checked" : ""} /><span><strong>${esc(p.label)}</strong><span class="muted small">${esc(p.description)}</span></span></label>
        <div class="pay-option-body" data-method="${p.id}">${p.renderFields()}</div>
      </div>`
    )
    .join("");
  return `
    <div class="checkout">
      <section class="checkout-main">
        ${steps(3)}
        <div class="review-box"><span class="muted">Contact</span><span>${esc(d.email)}</span><a href="/checkout">Change</a></div>
        <div class="review-box"><span class="muted">Ship to</span><span>${esc(d.address)}, ${esc(d.postcode)} ${esc(d.city)}</span><a href="/checkout">Change</a></div>
        <div class="review-box"><span class="muted">Method</span><span>${esc(method.label)}</span><a href="/checkout/shipping">Change</a></div>
        <h1>Payment</h1>
        <p class="muted small">All transactions are secure and encrypted.</p>
        ${error ? `<div class="alert">${esc(error)}</div>` : ""}
        <form method="post" action="/checkout/pay" class="checkout-form" id="payment-form">
          ${options}
          <label class="terms"><input type="checkbox" name="terms" value="yes" required /> I agree to the <a href="/terms" target="_blank">terms &amp; conditions</a></label>
          <button type="submit" class="btn btn-wide" id="pay-button">Pay ${formatPrice(totals.totalCents)}</button>
        </form>
      </section>
      ${orderSidebar(lines, totals, shipping)}
    </div>`;
}

export function confirmationPage(o: PlacedOrder): string {
  const pending = o.paymentStatus === "pending";
  return `
    <section class="confirm">
      <p class="check">✓</p>
      <h1>Thank you for your order!</h1>
      <p>Order <strong>${esc(o.id)}</strong> · a confirmation has been sent to <strong>${esc(o.email)}</strong>.</p>
      ${pending ? `<div class="notice">Your invoice with payment details is on its way. We'll ship as soon as your payment arrives.</div>` : `<div class="notice">Payment received. Your honey ships within 1–2 working days.</div>`}
      <table class="cart-table">
        <tbody>${o.lines.map((l) => `<tr><td>${esc(l.name)} · ${esc(l.label)} × ${l.qty}</td><td>${formatPrice(l.unitCents * l.qty)}</td></tr>`).join("")}</tbody>
      </table>
      ${summaryBlock(o.totals, o.shipping, true)}
      <a class="btn" href="/">Back to the shop</a>
    </section>`;
}

export function infoPage(kind: "about" | "shipping" | "terms"): { title: string; body: string } {
  if (kind === "about")
    return {
      title: "Our bees",
      body: `<section class="prose"><h1>Our bees</h1><p>We keep around forty colonies across two sites: meadows and orchards in Gelderland in spring, and the Veluwe heathland in late summer.</p><p>We harvest twice a year, extract cold, and bottle by hand in small batches. No blending, no heating, no additives.</p></section>`,
    };
  if (kind === "shipping")
    return {
      title: "Shipping & returns",
      body: `<section class="prose"><h1>Shipping &amp; returns</h1><h2>Shipping</h2><p>Standard delivery with PostNL in 2–3 working days for €4,95, free in the Netherlands on orders over €40. Express next-working-day delivery for €9,95 when ordered before 16:00.</p><p>We ship to the Netherlands, Belgium, Germany, France and Luxembourg.</p><h2>Returns</h2><p>Unopened jars can be returned within 14 days. If a jar arrives damaged, email us a photo and we'll replace it.</p></section>`,
    };
  return {
    title: "Terms & conditions",
    body: `<section class="prose"><h1>Terms &amp; conditions</h1>${demoNotice() ? `<p><strong>This is a demonstration store.</strong> Orders placed here are not charged, processed or shipped, and card payments run in test mode only.</p>` : ""}<p>Prices include VAT. An order is confirmed once you receive our confirmation email. Bank-transfer orders are reserved for 7 days pending payment.</p></section>`,
  };
}
