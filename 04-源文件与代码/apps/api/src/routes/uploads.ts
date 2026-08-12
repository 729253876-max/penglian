import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from "fastify";
import { CompleteUploadInputSchema, CreateUploadSessionInputSchema } from "@photo-ai/contracts";
import type { CreateUploadSessionRequest } from "../application/upload-session-service.js";

export interface UploadApiService {
  createSession(userId: string, input: CreateUploadSessionRequest): Promise<unknown>;
  reissueCredentials(userId: string, sessionId: string): Promise<unknown>;
  completeUpload(userId: string, sessionId: string, etag: string): Promise<unknown>;
  getStatus(userId: string, sessionId: string): Promise<unknown>;
  cancel(userId: string, sessionId: string): Promise<void>;
}

export interface UploadRouteDependencies {
  service: UploadApiService;
  authenticate: preHandlerHookHandler;
}

export async function registerUploadRoutes(
  app: FastifyInstance,
  { service, authenticate }: UploadRouteDependencies
): Promise<void> {
  app.post("/v1/uploads", { preHandler: authenticate }, async (request, reply) => {
    const parsed = CreateUploadSessionInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_UPLOAD_INPUT" });
    try {
      const result = await service.createSession(request.auth.userId, parsed.data);
      return reply.code(201).send(result);
    } catch (error) { return sendUploadError(reply, error); }
  });

  app.post<{ Params: { id: string } }>(
    "/v1/uploads/:id/credentials", { preHandler: authenticate }, async (request, reply) => {
      try { return reply.send(await service.reissueCredentials(request.auth.userId, request.params.id)); }
      catch (error) { return sendUploadError(reply, error); }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/v1/uploads/:id/complete", { preHandler: authenticate }, async (request, reply) => {
      const parsed = CompleteUploadInputSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ code: "INVALID_UPLOAD_COMPLETION" });
      try {
        return reply.code(202).send(
          await service.completeUpload(request.auth.userId, request.params.id, parsed.data.etag)
        );
      } catch (error) { return sendUploadError(reply, error); }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/v1/uploads/:id", { preHandler: authenticate }, async (request, reply) => {
      try { return reply.send(await service.getStatus(request.auth.userId, request.params.id)); }
      catch (error) { return sendUploadError(reply, error); }
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/v1/uploads/:id", { preHandler: authenticate }, async (request, reply) => {
      try { await service.cancel(request.auth.userId, request.params.id); return reply.code(204).send(); }
      catch (error) { return sendUploadError(reply, error); }
    }
  );
}

function sendUploadError(reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
  if (code === "UPLOAD_SESSION_NOT_FOUND") return reply.code(404).send({ code });
  if ([
    "UPLOAD_SESSION_EXPIRED",
    "CREDENTIAL_REISSUE_LIMIT",
    "UPLOAD_STATE_CONFLICT",
    "UPLOAD_ETAG_MISMATCH"
  ].includes(code)) {
    return reply.code(409).send({ code });
  }
  if (["CONSENT_REQUIRED", "INVALID_UPLOAD_INPUT", "IMAGE_TOO_LARGE", "IMAGE_FORMAT_UNSUPPORTED"].includes(code)) {
    return reply.code(422).send({ code });
  }
  return reply.code(500).send({ code: "INTERNAL_ERROR" });
}
