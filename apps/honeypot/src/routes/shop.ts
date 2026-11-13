import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PRODUCTS, SHIPPING_METHODS, findProduct, findVariant, type ShippingMethodId } from "../shop/catalog.js";
import {
  readCart, writeCart, addToCart, setQty, computeTotals, lineDetails,
  readCheckout, writeCheckout, readOrder, completeOrder, type CheckoutDetails, type PlacedOrder,
} from "../shop/cart.js";
import { enabledProviders, providerById } from "../shop/payments.js";
import { stripeTestConfig, createTestPaymentIntent } from "../shop/stripeTest.js";
import {
  shopLayout, shopHomePage, productPage, cartPage, checkoutDetailsPage, checkoutShippingPage,
  checkoutPaymentPage, confirmationPage, infoPage,
} from "../shop/render.js";
import { jarSvg, FAVICON_SVG } from "../shop/assets.js";

/**
 * uHoney storefront — browse → basket → checkout → order, so AI shopping agents have a realistic
 * e-commerce flow to go through (docs/AGENT_SENSING.md). Every step emits a SHOP_* event whose
 * metadata records what was shown and chosen (prices, totals, steps) — never contact details or
 * payment data: checkout form bodies are excluded from request capture (bodyRedaction.ts) and
 * only "which fields were filled, how long, valid format" is kept.
 */

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "static");
const SHOP_CSS = readFileSync(path.join(STATIC_DIR, "shop.css"), "utf8");
const CHECKOUT_JS = readFileSync(path.join(STATIC_DIR, "checkout.js"), "utf8");
const STRIPE_CHECKOUT_JS = readFileSync(path.join(STATIC_DIR, "stripe-checkout.js"), "utf8");

type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function tag(request: FastifyRequest, endpoint: string, events: string[] = [], meta: Record<string, unknown> = {}) {
  request.hp.endpoint = endpoint;
  request.hp.applicationComponent = "shop";
  request.hp.extraEventTypes.push(...events);
  Object.assign(request.hp.extraEventMetadata, { shop: meta });
}

function send(reply: FastifyReply, request: FastifyRequest, title: string, body: string, extra: { head?: string; scripts?: string[]; status?: number } = {}) {
  const cartCount = readCart(request).reduce((s, l) => s + l.qty, 0);
  // Returned so async handlers can `return send(...)`: an async handler that sends without
  // returning the reply makes Fastify treat it as unsent, and the error handler then tries to
  // write headers a second time ("Reply was already sent" + "Cannot write headers" per page).
  return reply.status(extra.status ?? 200).type("text/html").send(shopLayout({ title, body, cartCount, head: extra.head, scripts: extra.scripts }));
}

function cartSnapshot(lines: ReturnType<typeof readCart>, shipping?: ShippingMethodId) {
  return {
    lines: lineDetails(lines).map((l) => ({ sku: l.sku, qty: l.qty, unitCents: l.variant.priceCents })),
    totals: computeTotals(lines, shipping),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTCODE_RE: Record<string, RegExp> = { NL: /^\d{4}\s?[A-Za-z]{2}$/, BE: /^\d{4}$/, DE: /^\d{5}$/, FR: /^\d{5}$/, LU: /^(L-)?\d{4}$/ };

/** Shape of what was typed, never the values. */
function detailsShape(d: CheckoutDetails) {
  return {
    filled: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length])),
    emailValid: EMAIL_RE.test(d.email),
    postcodeMatchesCountry: POSTCODE_RE[d.country]?.test(d.postcode) ?? null,
    country: d.country,
    phoneGiven: d.phone.length > 0,
    sameFirstLast: d.firstName.toLowerCase() === d.lastName.toLowerCase(),
  };
}

export function registerShopRoutes(app: FastifyInstance) {
  // ---- static
  app.get("/assets/shop.css", async (request, reply) => {
    tag(request, "site.asset");
    return reply.type("text/css").header("Cache-Control", "public, max-age=3600").send(SHOP_CSS);
  });
  app.get("/assets/checkout.js", async (request, reply) => {
    tag(request, "site.asset");
    return reply.type("application/javascript").header("Cache-Control", "no-cache").send(CHECKOUT_JS);
  });
  app.get("/assets/stripe-checkout.js", async (request, reply) => {
    tag(request, "shop.asset");
    return reply.type("application/javascript").header("Cache-Control", "no-cache").send(STRIPE_CHECKOUT_JS);
  });
  app.get("/assets/img/favicon.svg", async (request, reply) => {
    tag(request, "site.asset");
    return reply.type("image/svg+xml").header("Cache-Control", "public, max-age=86400").send(FAVICON_SVG);
  });
  app.get("/favicon.ico", async (request, reply) => {
    tag(request, "site.asset");
    return reply.type("image/svg+xml").header("Cache-Control", "public, max-age=86400").send(FAVICON_SVG);
  });
  app.get<{ Params: { file: string } }>("/assets/img/:file", async (request, reply) => {
    tag(request, "site.asset");
    const p = findProduct(request.params.file.replace(/\.svg$/, ""));
    if (!p) return reply.status(404).send();
    return reply.type("image/svg+xml").header("Cache-Control", "public, max-age=86400").send(jarSvg(p));
  });

  // ---- browse
  app.get("/", async (request, reply) => {
    tag(request, "shop.home", ["SHOP_HOME_VIEW"], { offers: PRODUCTS.flatMap((p) => p.variants.map((v) => ({ sku: v.sku, priceCents: v.priceCents }))) });
    return send(reply, request, "Raw honey from our own hives", shopHomePage());
  });

  app.get<{ Params: { slug: string }; Querystring: { added?: string } }>("/products/:slug", async (request, reply) => {
    request.hp.pathTemplate = "/products/:slug";
    request.hp.pathParams = { slug: request.params.slug };
    const p = findProduct(request.params.slug);
    if (!p) {
      tag(request, "shop.product.not_found");
      return send(reply, request, "Not found", `<h1>We couldn't find that product</h1><a class="btn" href="/">Back to the shop</a>`, { status: 404 });
    }
    tag(request, "shop.product", ["SHOP_PRODUCT_VIEW"], { product: p.slug, offers: p.variants.map((v) => ({ sku: v.sku, priceCents: v.priceCents, stock: v.stock })) });
    const page = productPage(p, { added: request.query.added });
    return send(reply, request, p.name, page.body, { head: page.head });
  });

  for (const kind of ["about", "shipping", "terms"] as const) {
    app.get(`/${kind}`, async (request, reply) => {
      tag(request, `shop.${kind}`, ["SHOP_INFO_VIEW"], { page: kind });
      const page = infoPage(kind);
      return send(reply, request, page.title, page.body);
    });
  }

  // ---- basket
  app.post("/cart/add", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const sku = str(body.sku);
    const qty = Math.max(1, Math.min(10, Number.parseInt(str(body.qty) || "1", 10) || 1));
    const found = findVariant(sku);
    if (!found) {
      tag(request, "shop.cart.add", ["SHOP_CART_ERROR"], { error: "unknown_sku", sku: sku.slice(0, 40) });
      return reply.redirect("/", 303);
    }
    const lines = addToCart(readCart(request), sku, qty);
    writeCart(reply, lines);
    tag(request, "shop.cart.add", ["SHOP_ADD_TO_CART"], { sku, qty, unitCents: found.variant.priceCents, ...cartSnapshot(lines) });
    return reply.redirect(`/products/${found.product.slug}?added=1`, 303);
  });

  app.get("/cart", async (request, reply) => {
    const lines = readCart(request);
    tag(request, "shop.cart", ["SHOP_CART_VIEW"], cartSnapshot(lines));
    return send(reply, request, "Your basket", cartPage(lines, computeTotals(lines, undefined)));
  });

  app.post("/cart/update", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const sku = str(body.sku);
    const qty = Math.max(0, Math.min(10, Number.parseInt(str(body.qty) || "0", 10) || 0));
    const lines = setQty(readCart(request), sku, qty);
    writeCart(reply, lines);
    tag(request, "shop.cart.update", ["SHOP_CART_UPDATE"], { sku, qty, ...cartSnapshot(lines) });
    return reply.redirect("/cart", 303);
  });

  // ---- checkout
  app.get("/checkout", async (request, reply) => {
    const lines = readCart(request);
    if (lines.length === 0) {
      tag(request, "shop.checkout.empty");
      return reply.redirect("/cart", 303);
    }
    tag(request, "shop.checkout.details.view", ["SHOP_CHECKOUT_START"], cartSnapshot(lines));
    return send(reply, request, "Checkout", checkoutDetailsPage(lines, computeTotals(lines, undefined), readCheckout(request).details ?? {}));
  });

  app.post("/checkout/details", async (request, reply) => {
    const lines = readCart(request);
    if (lines.length === 0) return reply.redirect("/cart", 303);
    const b = (request.body ?? {}) as Body;
    const d: CheckoutDetails = {
      email: str(b.email).slice(0, 200), firstName: str(b.firstName).slice(0, 100), lastName: str(b.lastName).slice(0, 100),
      address: str(b.address).slice(0, 200), postcode: str(b.postcode).slice(0, 20), city: str(b.city).slice(0, 100),
      country: ["NL", "BE", "DE", "FR", "LU"].includes(str(b.country)) ? str(b.country) : "NL", phone: str(b.phone).slice(0, 40),
    };
    const shape = detailsShape(d);
    const missing = (["email", "firstName", "lastName", "address", "postcode", "city"] as const).filter((k) => !d[k]);
    if (missing.length || !shape.emailValid) {
      tag(request, "shop.checkout.details.submit", ["SHOP_CHECKOUT_DETAILS_INVALID"], { ...shape, missing });
      return send(reply, request, "Checkout", checkoutDetailsPage(lines, computeTotals(lines, undefined), d, missing.length ? "Please fill in all required fields." : "Please enter a valid email address."));
    }
    writeCheckout(reply, { ...readCheckout(request), details: d });
    tag(request, "shop.checkout.details.submit", ["SHOP_CHECKOUT_DETAILS"], shape);
    return reply.redirect("/checkout/shipping", 303);
  });

  app.get("/checkout/shipping", async (request, reply) => {
    const lines = readCart(request);
    const state = readCheckout(request);
    if (lines.length === 0) return reply.redirect("/cart", 303);
    if (!state.details) return reply.redirect("/checkout", 303);
    tag(request, "shop.checkout.shipping.view", ["SHOP_SHIPPING_VIEW"], cartSnapshot(lines, state.shipping));
    const t = computeTotals(lines, state.shipping);
    return send(reply, request, "Shipping", checkoutShippingPage(lines, t, state.details, state.shipping, t.subtotalCents));
  });

  app.post("/checkout/shipping", async (request, reply) => {
    const lines = readCart(request);
    const state = readCheckout(request);
    if (lines.length === 0) return reply.redirect("/cart", 303);
    if (!state.details) return reply.redirect("/checkout", 303);
    const choice = str(((request.body ?? {}) as Body).shipping);
    const shipping = (SHIPPING_METHODS.find((m) => m.id === choice)?.id ?? "standard") as ShippingMethodId;
    writeCheckout(reply, { ...state, shipping });
    tag(request, "shop.checkout.shipping.submit", ["SHOP_CHECKOUT_SHIPPING"], { shipping, ...cartSnapshot(lines, shipping) });
    return reply.redirect("/checkout/payment", 303);
  });

  const paymentView = (request: FastifyRequest, reply: FastifyReply, error?: string, selected?: string, status = 200) => {
    const lines = readCart(request);
    const state = readCheckout(request);
    const providers = enabledProviders();
    const t = computeTotals(lines, state.shipping);
    return send(reply, request, "Payment", checkoutPaymentPage(lines, t, state.details!, state.shipping ?? "standard", providers, error, selected), {
      scripts: [...new Set(providers.flatMap((p) => p.scripts))],
      status,
    });
  };

  app.get("/checkout/payment", async (request, reply) => {
    const lines = readCart(request);
    const state = readCheckout(request);
    if (lines.length === 0) return reply.redirect("/cart", 303);
    if (!state.details) return reply.redirect("/checkout", 303);
    if (!state.shipping) return reply.redirect("/checkout/shipping", 303);
    tag(request, "shop.checkout.payment.view", ["SHOP_PAYMENT_VIEW"], { methods: enabledProviders().map((p) => p.id), ...cartSnapshot(lines, state.shipping) });
    paymentView(request, reply);
  });

  // Stripe test mode: create the PaymentIntent for the current basket total (computed here, never
  // taken from the client) and remember its id in the signed checkout cookie, so /checkout/pay only
  // accepts the intent made for this checkout.
  app.post("/checkout/stripe/intent", async (request, reply) => {
    const cfg = stripeTestConfig();
    const lines = readCart(request);
    const state = readCheckout(request);
    if (!cfg || !providerById("stripe_test")) {
      tag(request, "shop.checkout.stripe.intent", [], { error: "not_configured" });
      return reply.status(404).send({ error: "not_available" });
    }
    if (lines.length === 0 || !state.details || !state.shipping) {
      tag(request, "shop.checkout.stripe.intent", [], { error: "checkout_incomplete" });
      return reply.status(409).send({ error: "checkout_incomplete" });
    }
    const snapshot = cartSnapshot(lines, state.shipping);
    try {
      const pi = await createTestPaymentIntent(cfg, snapshot.totals.totalCents, {
        source: "uhoney-honeypot",
        session: request.hp.sessionId ?? "",
        lab: request.hp.labLabel ?? "",
      });
      writeCheckout(reply, { ...state, stripePi: pi.id });
      tag(request, "shop.checkout.stripe.intent", [], { stripePaymentIntent: pi.id, ...snapshot });
      return reply.header("Cache-Control", "no-store").send({ clientSecret: pi.client_secret, publishableKey: cfg.publishableKey });
    } catch (err) {
      request.log.warn({ msg: "stripe test intent failed", err: err instanceof Error ? err.message : String(err) });
      tag(request, "shop.checkout.stripe.intent", [], { error: "stripe_error" });
      return reply.status(502).send({ error: "stripe_unavailable" });
    }
  });

  app.post("/checkout/pay", async (request, reply) => {
    const lines = readCart(request);
    const state = readCheckout(request);
    if (lines.length === 0) return reply.redirect("/cart", 303);
    if (!state.details || !state.shipping) return reply.redirect("/checkout", 303);
    const body = (request.body ?? {}) as Body;
    const snapshot = cartSnapshot(lines, state.shipping);
    const provider = providerById(str(body.method));
    if (!provider) {
      tag(request, "shop.checkout.pay", ["SHOP_PAYMENT_ERROR"], { error: "no_method", ...snapshot });
      return paymentView(request, reply, "Please choose a payment method.", undefined, 200);
    }
    if (str(body.terms) !== "yes") {
      tag(request, "shop.checkout.pay", ["SHOP_PAYMENT_ERROR"], { error: "terms_not_accepted", method: provider.id, ...snapshot });
      return paymentView(request, reply, "Please accept the terms & conditions.", provider.id, 200);
    }
    const outcome = await provider.handle(body, { totalCents: snapshot.totals.totalCents, stripePaymentIntent: state.stripePi });
    if (outcome.status === "declined" || outcome.status === "error") {
      tag(request, "shop.checkout.pay", ["SHOP_PAYMENT_ATTEMPT", "SHOP_PAYMENT_DECLINED"], { method: provider.id, status: outcome.status, payment: outcome.metadata, ...snapshot });
      return paymentView(request, reply, outcome.message, provider.id, 200);
    }
    const order: PlacedOrder = {
      id: `UH-${new Date().getFullYear()}-${randomBytes(3).toString("hex").toUpperCase()}`,
      placedAt: new Date().toISOString(),
      lines: lineDetails(lines).map((l) => ({ sku: l.sku, name: l.product.name, label: l.variant.label, qty: l.qty, unitCents: l.variant.priceCents })),
      totals: snapshot.totals,
      paymentMethod: provider.id,
      paymentStatus: outcome.status,
      shipping: state.shipping,
      email: state.details.email,
      city: state.details.city,
    };
    completeOrder(reply, order);
    tag(request, "shop.checkout.pay", ["SHOP_PAYMENT_ATTEMPT", "SHOP_ORDER_PLACED"], {
      orderId: order.id, method: provider.id, status: outcome.status, payment: outcome.metadata, ...snapshot,
    });
    return reply.redirect("/order/confirmation", 303);
  });

  app.get("/order/confirmation", async (request, reply) => {
    const order = readOrder(request);
    if (!order) {
      tag(request, "shop.order.none");
      return reply.redirect("/", 303);
    }
    tag(request, "shop.order.confirmation", ["SHOP_ORDER_CONFIRMATION_VIEW"], { orderId: order.id, totalCents: order.totals.totalCents });
    return send(reply, request, "Order confirmed", confirmationPage(order));
  });
}
