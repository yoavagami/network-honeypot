import type { FastifyReply, FastifyRequest } from "fastify";
import { findVariant, SHIPPING_METHODS, VAT_RATE, type ShippingMethodId } from "./catalog.js";

/**
 * Basket and checkout state live in signed cookies (the app already has a cookie secret), so the
 * shop needs no new tables and survives restarts. Checkout contact/address details stay in the
 * visitor's own browser cookie only — the server never stores them (see routes/shop.ts, which
 * excludes checkout bodies from request capture and records only which fields were filled).
 */

const CART_COOKIE = "hp_cart";
const CHECKOUT_COOKIE = "hp_checkout";
const ORDER_COOKIE = "hp_order";
const MAX_QTY = 10;

export interface CartLine { sku: string; qty: number }
export interface CheckoutDetails {
  email: string;
  firstName: string;
  lastName: string;
  address: string;
  postcode: string;
  city: string;
  country: string;
  phone: string;
}
export interface CheckoutState { details?: CheckoutDetails; shipping?: ShippingMethodId; /** Stripe test PaymentIntent id for this checkout. */ stripePi?: string }
export interface PlacedOrder {
  id: string;
  placedAt: string;
  lines: Array<{ sku: string; name: string; label: string; qty: number; unitCents: number }>;
  totals: Totals;
  paymentMethod: string;
  paymentStatus: string;
  shipping: ShippingMethodId;
  email: string;
  city: string;
}

const cookieOpts = { httpOnly: true, sameSite: "lax" as const, path: "/", signed: true };

function readSigned<T>(request: FastifyRequest, name: string): T | null {
  const raw = request.cookies[name];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  try {
    return JSON.parse(unsigned.value) as T;
  } catch {
    return null;
  }
}

export function readCart(request: FastifyRequest): CartLine[] {
  const lines = readSigned<CartLine[]>(request, CART_COOKIE) ?? [];
  return lines.filter((l) => findVariant(l.sku) && Number.isInteger(l.qty) && l.qty > 0).map((l) => ({ sku: l.sku, qty: Math.min(l.qty, MAX_QTY) }));
}

export function writeCart(reply: FastifyReply, lines: CartLine[]) {
  reply.setCookie(CART_COOKIE, JSON.stringify(lines), { ...cookieOpts, maxAge: 60 * 60 * 24 * 14 });
}

export function addToCart(lines: CartLine[], sku: string, qty: number): CartLine[] {
  const next = lines.map((l) => ({ ...l }));
  const existing = next.find((l) => l.sku === sku);
  if (existing) existing.qty = Math.min(existing.qty + qty, MAX_QTY);
  else next.push({ sku, qty: Math.min(qty, MAX_QTY) });
  return next;
}

export function setQty(lines: CartLine[], sku: string, qty: number): CartLine[] {
  if (qty <= 0) return lines.filter((l) => l.sku !== sku);
  return lines.map((l) => (l.sku === sku ? { ...l, qty: Math.min(qty, MAX_QTY) } : l));
}

export function readCheckout(request: FastifyRequest): CheckoutState {
  return readSigned<CheckoutState>(request, CHECKOUT_COOKIE) ?? {};
}

export function writeCheckout(reply: FastifyReply, state: CheckoutState) {
  reply.setCookie(CHECKOUT_COOKIE, JSON.stringify(state), { ...cookieOpts, maxAge: 60 * 60 * 24 });
}

export function readOrder(request: FastifyRequest): PlacedOrder | null {
  return readSigned<PlacedOrder>(request, ORDER_COOKIE);
}

export function completeOrder(reply: FastifyReply, order: PlacedOrder) {
  reply.setCookie(ORDER_COOKIE, JSON.stringify(order), { ...cookieOpts, maxAge: 60 * 60 * 24 * 7 });
  reply.clearCookie(CART_COOKIE, { path: "/" });
  reply.clearCookie(CHECKOUT_COOKIE, { path: "/" });
}

export interface Totals {
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  vatCents: number;
  itemCount: number;
}

export function lineDetails(lines: CartLine[]) {
  return lines.map((l) => {
    const { product, variant } = findVariant(l.sku)!;
    return { sku: l.sku, qty: l.qty, product, variant, lineCents: variant.priceCents * l.qty };
  });
}

export function computeTotals(lines: CartLine[], shipping: ShippingMethodId | undefined): Totals {
  const subtotalCents = lineDetails(lines).reduce((s, l) => s + l.lineCents, 0);
  const method = SHIPPING_METHODS.find((m) => m.id === (shipping ?? "standard"))!;
  const shippingCents = lines.length === 0 ? 0 : method.freeOverCents !== null && subtotalCents >= method.freeOverCents ? 0 : method.priceCents;
  const totalCents = subtotalCents + shippingCents;
  return {
    subtotalCents,
    shippingCents,
    totalCents,
    vatCents: Math.round(totalCents - totalCents / (1 + VAT_RATE)),
    itemCount: lines.reduce((s, l) => s + l.qty, 0),
  };
}
