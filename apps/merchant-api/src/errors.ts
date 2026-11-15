import type { FastifyReply, FastifyRequest } from "fastify";
import { ERROR_STATUS, type ErrorCode } from "@honeypot/merchant-contract";

/** Sends a contract error ({ error: { code, message, request_id } }) with the contract's HTTP status. */
export function sendError(request: FastifyRequest, reply: FastifyReply, code: ErrorCode, message: string) {
  return reply.status(ERROR_STATUS[code]).send({ error: { code, message, request_id: String(request.id) } });
}

export class ApiFailure extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}
