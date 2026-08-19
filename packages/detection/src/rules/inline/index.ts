import type { EventType } from "@honeypot/types";
import { matchesReconSignature } from "./reconSignatures.js";
import { matchesScannerUa } from "./scannerUa.js";
import { findCanaryMatches } from "./canary.js";
import type { RiskFlag } from "../../scoring.js";

export interface InlineEvaluationInput {
  path: string;
  method: string;
  routeMatched: boolean;
  methodAllowed: boolean;
  paramValidationFailed: boolean;
  userAgent: string | null;
  isAdminArea: boolean;
  hasRefererFromSite: boolean;
  candidateCanaryHaystacks: Array<string | null | undefined>;
  activeCanaryValues: string[];
}

export interface InlineEvaluationResult {
  additionalEventTypes: EventType[];
  riskFlags: RiskFlag[];
  canaryMatches: string[];
  signals: string[];
}

export function evaluateInline(input: InlineEvaluationInput): InlineEvaluationResult {
  const additionalEventTypes: EventType[] = [];
  const riskFlags: RiskFlag[] = [];
  const signals: string[] = [];

  if (!input.routeMatched) {
    additionalEventTypes.push("INVALID_ROUTE");
    riskFlags.push("invalidRouteOrMethodOrParam");
  } else if (!input.methodAllowed) {
    additionalEventTypes.push("INVALID_METHOD");
    riskFlags.push("invalidRouteOrMethodOrParam");
  } else if (input.paramValidationFailed) {
    additionalEventTypes.push("INVALID_PARAMETER");
    riskFlags.push("invalidRouteOrMethodOrParam");
  }

  if (matchesReconSignature(input.path)) {
    additionalEventTypes.push("HONEYPOT_TRIGGER", "TECHNOLOGY_ENUMERATION");
    riskFlags.push("reconSignaturePath");
    signals.push("recon-signature-path");
  }

  if (matchesScannerUa(input.userAgent)) {
    riskFlags.push("scannerOrLibraryUa");
    signals.push("scanner-or-library-user-agent");
  }

  if (input.isAdminArea) {
    additionalEventTypes.push("ADMIN_PAGE_ACCESS");
    if (!input.hasRefererFromSite) {
      riskFlags.push("adminPageDirectAccess");
      signals.push("direct-admin-access-no-referer");
    }
  }

  const canaryMatches = findCanaryMatches(input.candidateCanaryHaystacks, input.activeCanaryValues);
  if (canaryMatches.length > 0) {
    additionalEventTypes.push("CANARY_TRIGGERED");
    riskFlags.push("canaryTriggered");
    signals.push(`canary-match:${canaryMatches.length}`);
  }

  return { additionalEventTypes, riskFlags, canaryMatches, signals };
}
