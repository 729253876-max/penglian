import type { FastifyInstance, FastifyReply } from "fastify";
import { CreateTaskInputSchema } from "@photo-ai/contracts";
import type { TaskService } from "../application/task-service.js";

export type TaskApiService = Pick<
  TaskService,
  "create" | "confirmAndRunPreview" | "get" | "getEvents"
>;

function sendDomainError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  if (message === "TASK_NOT_FOUND") {
    return reply.code(404).send({ code: "TASK_NOT_FOUND" });
  }
  if (message === "TASK_CONFIRMATION_CONFLICT") {
    return reply.code(409).send({ code: "TASK_CONFIRMATION_CONFLICT" });
  }
  if (message.startsWith("Illegal task transition:")) {
    return reply.code(409).send({ code: "ILLEGAL_TASK_STATE" });
  }
  if (message === "STAGE_A_UNSUPPORTED_TOOL") {
    return reply.code(422).send({ code: "STAGE_A_UNSUPPORTED_TOOL" });
  }
  return reply.code(500).send({ code: "INTERNAL_ERROR" });
}

export async function registerTaskRoutes(
  app: FastifyInstance,
  service: TaskApiService
): Promise<void> {
  app.post("/v1/tasks", async (request, reply) => {
    const parsed = CreateTaskInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_TASK_INPUT",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
    }

    try {
      return reply.code(201).send(await service.create(parsed.data));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post<{
    Params: { taskId: string };
  }>("/v1/tasks/:taskId/preview", async (request, reply) => {
    try {
      await service.get(request.params.taskId);
      return reply.code(202).send(
        await service.confirmAndRunPreview(request.params.taskId)
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get<{
    Params: { taskId: string };
  }>("/v1/tasks/:taskId", async (request, reply) => {
    try {
      return reply.send(await service.get(request.params.taskId));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get<{
    Params: { taskId: string };
    Querystring: { afterSequence?: string };
  }>("/v1/tasks/:taskId/events", async (request, reply) => {
    const raw = request.query.afterSequence ?? "0";
    if (typeof raw !== "string" || !/^(0|[1-9]\d*)$/.test(raw)) {
      return reply.code(400).send({ code: "INVALID_SEQUENCE" });
    }
    const afterSequence = Number(raw);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return reply.code(400).send({ code: "INVALID_SEQUENCE" });
    }

    try {
      const items = await service.getEvents(request.params.taskId, afterSequence);
      return reply.send({
        items,
        nextSequence: items.at(-1)?.sequence ?? afterSequence
      });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });
}
