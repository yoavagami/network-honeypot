/**
 * The merchant API contract (docs/merchant/CONTRACT.md, packages/merchant-contract/openapi.json)
 * as runtime schemas. apps/merchant-api validates every request with these, and the contract test
 * checks that they accept exactly the examples in openapi.json — so the spec, the docs and the
 * server can't drift apart silently.
 *
 * Compatibility rule for v1: fields and enum values may be ADDED; nothing is renamed or removed.
 * Clients must ignore unknown fields and treat an unknown enum value like `unknown`.
 */
import { z } from "zod";

// ---------------------------------------------------------------- identifiers

/** Crockford base32 (no I, L, O, U) — readable over the phone, no look-alike characters. */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ID_PATTERNS = {
  merchant: /^mer_[0-9A-HJKMNP-TV-Z]{8}$/,
  siteKey: /^pk_(test|live)_[A-Za-z0-9]{24}$/,
  secretKey: /^sk_(test|live)_[A-Za-z0-9]{32}$/,
  webhookSecret: /^whsec_[A-Za-z0-9]{32}$/,
  sessionToken: /^st_[A-Za-z0-9_-]{16,512}\.[A-Za-z0-9_-]{16,128}$/,
  assessment: /^as_[A-Za-z0-9]{20}$/,
  event: /^evt_[A-Za-z0-9]{20}$/,
  visit: /^vis_[A-Za-z0-9]{20}$/,
} as const;

export const merchantId = z.string().regex(ID_PATTERNS.merchant);
export const sessionToken = z.string().regex(ID_PATTERNS.sessionToken);

// ---------------------------------------------------------------- enums

export const DRIVERS = ["human", "agent", "agent_then_human", "human_then_agent", "mixed", "unknown"] as const;
export type Driver = (typeof DRIVERS)[number];

export const SUGGESTED_ACTIONS = ["allow", "review", "challenge"] as const;
export type SuggestedAction = (typeof SUGGESTED_ACTIONS)[number];

/**
 * What to do with the order: let it through, confirm with the human first, or stop it. `confirm`
 * is the most the default policy returns; `block` only where the merchant's policy opts in.
 */
export const DECISIONS = ["allow", "confirm", "block"] as const;
export type Decision = (typeof DECISIONS)[number];

/** Where a policy may escalate the decision to `block` (opt-in, see policySchema.block_when). */
export const BLOCK_CATEGORIES = ["spoofed_agent", "unverified_agent"] as const;
export type BlockCategory = (typeof BLOCK_CATEGORIES)[number];

/** not_provided: no intent named at assess. not_evaluated: named, but not checked yet. */
export const INTENT_STATUSES = ["not_provided", "not_evaluated", "match", "mismatch"] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export const PAYMENT_METHODS = ["card", "wallet", "bank_transfer", "bnpl", "gift_card", "crypto", "other"] as const;

export const CONFIDENCE = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const VERIFICATION_METHODS = ["web_bot_auth", "published_ip_range", "reverse_dns"] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/** packages/detection AgentType, plus "unknown" when nothing automated was seen. */
export const AUTOMATION_TYPES = [
  "cloud_browser_agent", "in_browser_agent", "user_triggered_fetcher", "ai_crawler", "search_crawler",
  "ai_app", "browser_automation", "script", "scanner", "human", "unknown",
] as const;

export const ASSESS_STAGES = ["pay", "checkout"] as const;

export const FEEDBACK_OUTCOMES = ["confirmed_agent", "confirmed_human", "chargeback", "fraud", "legitimate"] as const;

export const STATUS_CHECKS = [
  "key_valid", "tag_seen", "token_issued", "pay_event_seen", "assess_called", "assess_headers",
  "assess_latency", "webhook_delivered", "domain_verified",
] as const;
export type StatusCheckId = (typeof STATUS_CHECKS)[number];
export const CHECK_STATES = ["pass", "fail", "pending", "not_applicable"] as const;

export const WEBHOOK_EVENTS = ["assessment.updated", "checkout.agent_started"] as const;

export const ERROR_CODES = [
  "invalid_request", "invalid_key", "wrong_key_type", "key_revoked", "merchant_mismatch", "origin_not_allowed",
  "not_found", "idempotency_conflict", "rate_limited", "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status per error code (the server must use exactly these). */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  invalid_key: 401,
  key_revoked: 401,
  wrong_key_type: 403,
  merchant_mismatch: 403,
  origin_not_allowed: 403,
  not_found: 404,
  idempotency_conflict: 409,
  rate_limited: 429,
  internal_error: 500,
};

/**
 * Reason codes the assess API adds itself, on top of the scorer's signal ids
 * (packages/detection/src/signals.ts — every SIGNALS key is also a valid reason code).
 */
export const SERVER_REASON_CODES = {
  no_client_signals: "The page script never reported for this checkout, so the verdict rests on server-side signals only",
  session_token_invalid: "The session token was missing a valid signature, expired, or belonged to another site",
  web_bot_auth_unverified: "The request carried a Web Bot Auth signature that could not be verified",
} as const;

// ---------------------------------------------------------------- request bodies

const headerName = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "header names must be lower-case");
const ipString = z.string().ip();

/** POST /v1/collect — sent by the tag (text/plain JSON, so no CORS preflight). */
export const collectRequest = z.object({
  site_key: z.string().regex(ID_PATTERNS.siteKey),
  session_token: sessionToken.optional(),
  /** page | event come from the loader; fp | behavior | probe are the page script's own beacons. */
  kind: z.enum(["page", "event", "fp", "behavior", "probe"]),
  /** Tag-minted page-view id, shared by every beacon from one page view. */
  pl: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/).nullable().optional(),
  path: z.string().max(512).optional(),
  t: z.number().int().min(0).max(86_400_000).optional(),
  v: z.number().int().min(1).max(99).optional(),
  sdk: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/).optional(),
  data: z.record(z.unknown()).default({}),
  /** A signed lab-run token from a ?lab= link the visit landed on (internal accuracy testing). */
  lab: z.string().max(120).optional(),
});
export type CollectRequest = z.infer<typeof collectRequest>;

/** Events the loader may send as kind "event" (data.name). */
export const TAG_EVENTS = ["pay_clicked", "checkout_started", "add_to_cart", "product_viewed"] as const;

const minorUnits = z.number().int().min(0).max(10_000_000_000);

/** One cart line, as the shopper sees it. */
export const lineItemSchema = z.object({
  sku: z.string().min(1).max(128),
  title: z.string().min(1).max(200).optional(),
  /** Your own category slug, e.g. "chocolate", "gift_card". */
  category: z.string().regex(/^[a-z0-9_-]{1,64}$/).optional(),
  quantity: z.number().int().min(1).max(100_000),
  /** Price of one unit, minor units. */
  unit_amount: minorUnits,
});

export const orderSchema = z.object({
  id: z.string().min(1).max(128),
  /** Minor units (cents). */
  amount: minorUnits,
  currency: z.string().regex(/^[A-Z]{3}$/),
  // Optional cart detail, used by the intent and legitimacy checks. No personal data: the address
  // travels only as a hash you compute, never in clear.
  items: z.array(lineItemSchema).max(100).optional(),
  shipping: z.object({
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    /** Your hash of the normalized shipping address (any stable hash, e.g. SHA-256 hex). */
    address_hash: z.string().regex(/^[A-Za-z0-9_+/=:-]{8,128}$/).optional(),
    /** True when this customer has never shipped to this address before. */
    new_address: z.boolean().optional(),
  }).optional(),
  payment: z.object({ method: z.enum(PAYMENT_METHODS) }).optional(),
});
export type Order = z.infer<typeof orderSchema>;

export const assessRequest = z.object({
  session_token: sessionToken.optional(),
  stage: z.enum(ASSESS_STAGES).default("pay"),
  order: orderSchema,
  /** The intent this order should fulfil (an intent id, or your own reference). Optional. */
  intent_ref: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).optional(),
  request: z.object({
    ip: ipString,
    user_agent: z.string().max(1024).nullable(),
    /** The visitor's request to the merchant: method, path and host let us verify Web Bot Auth signatures. */
    method: z.string().regex(/^[A-Z]{3,7}$/).optional(),
    path: z.string().max(2048).optional(),
    host: z.string().max(255).optional(),
    headers: z.record(headerName, z.string().max(4096)).refine((h) => Object.keys(h).length <= 50, "at most 50 headers").default({}),
  }),
});
export type AssessRequest = z.infer<typeof assessRequest>;

export const feedbackRequest = z
  .object({
    order_id: z.string().min(1).max(128).optional(),
    assessment_id: z.string().regex(ID_PATTERNS.assessment).optional(),
    outcome: z.enum(FEEDBACK_OUTCOMES),
    /** Free text for the merchant's own notes. Must not contain personal data. */
    note: z.string().max(500).optional(),
  })
  .refine((f) => Boolean(f.order_id) !== Boolean(f.assessment_id), "send exactly one of order_id or assessment_id");
export type FeedbackRequest = z.infer<typeof feedbackRequest>;

// ---------------------------------------------------------------- responses (server-side typing)

export interface Reason { code: string; text: string }

export interface AgentInfo {
  id: string;
  operator: string | null;
  verified: boolean;
  verification: VerificationMethod | null;
}

export interface Assessment {
  assessment_id: string;
  merchant_id: string;
  livemode: boolean;
  final: boolean;
  created_at: string;
  updated_at: string;
  order: { id: string; amount: number; currency: string };
  driver: Driver;
  handover: { page: string | null; at: string | null } | null;
  automation_type: (typeof AUTOMATION_TYPES)[number];
  agent: AgentInfo | null;
  score: number;
  confidence: Confidence;
  reasons: Reason[];
  signals_used: { client: boolean; server: boolean };
  suggested_action: SuggestedAction;
  scorer_version: string;
  decision: Decision;
  /** Is the agent acting for a real, authorized shopper? Higher score = more legitimate. */
  legitimacy: { evaluated: boolean; score: number | null; reasons: Reason[] };
  /** Does the cart match what the shopper asked for? */
  intent: { status: IntentStatus; score: number | null; violations: Reason[] };
  /** The order's evidence record, once evidence is kept. */
  evidence_id: string | null;
}

export interface CollectResponse { session_token: string; expires_at: string }

export interface StatusCheck { id: StatusCheckId; status: (typeof CHECK_STATES)[number]; detail: string; checked_at: string }
export interface IntegrationStatus {
  merchant_id: string;
  livemode: boolean;
  all_passed: boolean;
  checks: StatusCheck[];
  recent_events: Array<{ type: string; at: string; origin: string | null }>;
}

export interface ApiError { error: { code: ErrorCode; message: string; request_id: string } }

/** Merchant policy: what to suggest per category. The default never suggests more than review. */
export const policySchema = z.object({
  verified_agent: z.enum(SUGGESTED_ACTIONS).default("allow"),
  unverified_agent: z.enum(SUGGESTED_ACTIONS).default("review"),
  agent_then_human: z.enum(SUGGESTED_ACTIONS).default("allow"),
  uncertain: z.enum(SUGGESTED_ACTIONS).default("allow"),
  /** Where the decision becomes `block` instead of `confirm`. Empty by default: nothing is blocked. */
  block_when: z.array(z.enum(BLOCK_CATEGORIES)).max(BLOCK_CATEGORIES.length).default([]),
});
export type Policy = z.infer<typeof policySchema>;
export const DEFAULT_POLICY: Policy = policySchema.parse({});
