/**
 * uHoney storefront catalog — a deliberately small, realistic shop (two products, two sizes
 * each) so AI shopping agents have a real browse → basket → checkout flow to go through. See
 * docs/AGENT_SENSING.md. Prices are in euro cents, VAT-inclusive (NL food rate 9%).
 */

export interface Variant {
  sku: string;
  label: string;
  priceCents: number;
  stock: number;
}

export interface Product {
  slug: string;
  name: string;
  tagline: string;
  description: string[];
  origin: string;
  tastingNotes: string;
  details: Array<[string, string]>;
  image: string;
  colors: { honey: string; lid: string; label: string };
  variants: Variant[];
}

export const PRODUCTS: Product[] = [
  {
    slug: "wildflower-raw-honey",
    name: "Wildflower Raw Honey",
    tagline: "Cold-extracted, unfiltered spring honey",
    description: [
      "Gathered from hives on mixed meadows and orchard edges, this is our everyday honey: light, floral and gently sweet, with a soft finish of fruit blossom.",
      "We extract it cold and only strain it once, so the pollen and natural enzymes stay in. Like all raw honey it slowly crystallises — warm the jar in a bowl of lukewarm water to make it runny again.",
    ],
    origin: "Gelderland, the Netherlands",
    tastingNotes: "Apple blossom, clover, a hint of citrus",
    details: [
      ["Harvest", "Spring 2026"],
      ["Processing", "Cold-extracted, single strain"],
      ["Texture", "Runny, crystallises over time"],
      ["Storage", "Room temperature, out of direct sunlight"],
    ],
    image: "/assets/img/wildflower-raw-honey.svg",
    colors: { honey: "#f2b631", lid: "#2f5d3a", label: "#fffaf0" },
    variants: [
      { sku: "WRH-250", label: "250 g", priceCents: 890, stock: 42 },
      { sku: "WRH-500", label: "500 g", priceCents: 1490, stock: 27 },
    ],
  },
  {
    slug: "heather-honey",
    name: "Heather Honey",
    tagline: "Late-summer honey from the heathland, thick and aromatic",
    description: [
      "In August our bees move to the flowering heather. The result is a dark amber honey with a bold, slightly bitter, toffee-like flavour and a jelly-like texture that heather honey is known for.",
      "Small harvest, hand-pressed from the comb. Excellent with cheese, on porridge or simply by the spoon.",
    ],
    origin: "Veluwe heathland, the Netherlands",
    tastingNotes: "Toffee, roasted nuts, a gentle bitter edge",
    details: [
      ["Harvest", "August 2026"],
      ["Processing", "Pressed from the comb"],
      ["Texture", "Thick, jelly-like (thixotropic)"],
      ["Storage", "Room temperature, out of direct sunlight"],
    ],
    image: "/assets/img/heather-honey.svg",
    colors: { honey: "#a8551b", lid: "#5b2a4d", label: "#fdf6ff" },
    variants: [
      { sku: "HTH-250", label: "250 g", priceCents: 1150, stock: 18 },
      { sku: "HTH-500", label: "500 g", priceCents: 1990, stock: 4 },
    ],
  },
];

export const SHIPPING_METHODS = [
  { id: "standard", label: "Standard (PostNL, 2–3 working days)", priceCents: 495, freeOverCents: 4000 },
  { id: "express", label: "Express (next working day, order before 16:00)", priceCents: 995, freeOverCents: null },
] as const;
export type ShippingMethodId = (typeof SHIPPING_METHODS)[number]["id"];

export const VAT_RATE = 0.09;

export function findProduct(slug: string): Product | undefined {
  return PRODUCTS.find((p) => p.slug === slug);
}

export function findVariant(sku: string): { product: Product; variant: Variant } | undefined {
  for (const product of PRODUCTS) {
    const variant = product.variants.find((v) => v.sku === sku);
    if (variant) return { product, variant };
  }
  return undefined;
}

export function formatPrice(cents: number): string {
  return `€${(cents / 100).toFixed(2).replace(".", ",")}`;
}

export function fromPrice(product: Product): number {
  return Math.min(...product.variants.map((v) => v.priceCents));
}
