import { and, or, not, eq, ilike, type SQL } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { hashIp } from "@honeypot/detection";

/**
 * Simplified search grammar: `field:value` tokens combined with AND/OR/NOT, left-to-right (no
 * parentheses yet — see docs/API.md "Search" for the target grammar; this is the Phase 1
 * subset). Supported fields operate on the `requests` table only in Phase 1: event/detection/
 * canary search is a Phase 2 extension once the query spans a join, not a single table.
 */
export function parseSearch(query: string, ipHashSecret: string): SQL | undefined {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;

  let result: SQL | undefined;
  let connector: "AND" | "OR" = "AND";
  let negateNext = false;

  for (const token of tokens) {
    if (token.toUpperCase() === "AND") {
      connector = "AND";
      continue;
    }
    if (token.toUpperCase() === "OR") {
      connector = "OR";
      continue;
    }
    if (token.toUpperCase() === "NOT") {
      negateNext = true;
      continue;
    }

    let condition = toCondition(token, ipHashSecret);
    if (!condition) continue;
    if (negateNext) {
      condition = not(condition);
      negateNext = false;
    }

    if (!result) {
      result = condition;
    } else if (connector === "AND") {
      result = and(result, condition);
    } else {
      result = or(result, condition);
    }
    connector = "AND";
  }

  return result;
}

function toCondition(token: string, ipHashSecret: string): SQL | undefined {
  const [field, ...rest] = token.split(":");
  const value = rest.join(":");

  if (!value) {
    return or(ilike(schema.requests.path, `%${token}%`), ilike(schema.requests.userAgentRaw, `%${token}%`));
  }

  switch (field) {
    case "ip":
      return eq(schema.requests.ipHash, hashIp(value, ipHashSecret));
    case "actor":
      return eq(schema.requests.actorId, value);
    case "path":
      return ilike(schema.requests.path, `%${value}%`);
    case "method":
      return eq(schema.requests.method, value.toUpperCase());
    case "status_code":
      return eq(schema.requests.statusCode, Number(value));
    case "session":
      return eq(schema.requests.sessionId, value);
    case "request_id":
      return eq(schema.requests.requestId, value);
    default:
      return ilike(schema.requests.path, `%${token}%`);
  }
}
