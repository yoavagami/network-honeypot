import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { BACKDOOR_PATHS } from "../backdoor/paths.js";
import { resolveFakeCommand } from "../backdoor/commands.js";
import { recordCommandAndCheckIteration } from "../backdoor/state.js";

/** Deliberately bare — no HTML wrapper, matching how real minimal webshells look: an
 * inconspicuous single-character param name, nothing that reads as a "feature" of the site. */
const BAIT_FORM = `<form method="post"><input type="text" name="0" /><input type="submit" /></form>`;

function extractCommand(query: Record<string, string>, body: unknown): string | undefined {
  if (query["0"]) return query["0"];
  if (body && typeof body === "object" && "0" in body) return String((body as Record<string, unknown>)["0"]);
  return undefined;
}

export function registerBackdoorRoutes(app: FastifyInstance) {
  if (!config.backdoorBaitEnabled) return; // unregistered entirely — hitting these paths falls
  // through to the normal 404 handler, identical to any other unknown path. See docs/VULNERABILITY.md.

  for (const path of BACKDOOR_PATHS) {
    app.route({
      method: ["GET", "POST"],
      url: path,
      handler: async (request, reply) => {
        request.hp.endpoint = "backdoor.bait";
        request.hp.applicationComponent = "backdoor";
        request.hp.routeMatched = true;

        const command = extractCommand(request.query as Record<string, string>, request.body);
        request.hp.canaryHaystacks.push(command);

        if (command === undefined) {
          request.hp.extraEventTypes.push("BACKDOOR_PATH_HIT");
          request.hp.extraRiskFlags.push("backdoorPathHit");
          reply.type("text/html").send(BAIT_FORM);
          return;
        }

        const resolved = resolveFakeCommand(command);
        if (!resolved) {
          request.hp.extraEventTypes.push("BACKDOOR_ENGAGED");
          request.hp.extraEventMetadata.submittedCommand = command;
          reply.type("text/plain").send("");
          return;
        }

        const isIteration = recordCommandAndCheckIteration(request.hp.actorId, path, resolved.family);
        request.hp.extraEventTypes.push(isIteration ? "BACKDOOR_COMMAND_ITERATION" : "BACKDOOR_COMMAND_RECOGNIZED");
        request.hp.extraRiskFlags.push(isIteration ? "backdoorCommandIteration" : "backdoorCommandRecognized");
        request.hp.extraEventMetadata.submittedCommand = command;
        request.hp.extraEventMetadata.commandFamily = resolved.family;
        reply.type("text/plain").send(resolved.output);
      },
    });
  }
}
