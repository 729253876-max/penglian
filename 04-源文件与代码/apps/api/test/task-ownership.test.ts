import { afterEach, describe, expect, it } from "vitest";
import type { CreateTaskInput, EditTraceEvent } from "@photo-ai/contracts";
import { buildApp } from "../src/app.js";
import {
  StageADemoAssetReader,
  TaskService,
  type ImageProvider,
  type ProviderRunResult,
  type StoredTask
} from "../src/application/task-service.js";
import { InMemoryTaskRepository } from "../src/infrastructure/in-memory-task-repository.js";

const userA = "user-a";
const userB = "user-b";
const tokenA = "fictional-token-a";
const tokenB = "fictional-token-b";

const portraitInput: CreateTaskInput = {
  tool: "PORTRAIT_RETOUCH",
  inputAssetId: "demo-portrait-001",
  direction: "NATURAL_RESCUE",
  parameters: { naturalness: 85, detailLevel: 35 }
};

class CountingImageProvider implements ImageProvider {
  public calls = 0;

  public async runPreview(): Promise<ProviderRunResult> {
    this.calls += 1;
    return {
      previewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg",
      events: [
        providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started", { stage: "LOCAL_LIGHT_AND_SKIN" }),
        providerEvent("PARAM_DIRECTION_APPLIED", "RETOUCH", "portrait.parameter.direction", {
          direction: "NATURAL_RESCUE",
          level: "MODERATE"
        }),
        providerEvent("STAGE_COMPLETED", "RETOUCH", "portrait.stage.retouch.completed", { stage: "LOCAL_LIGHT_AND_SKIN" }),
        providerEvent("QUALITY_CHECK_STARTED", "QUALITY", "quality.started"),
        providerEvent("QUALITY_CHECK_PASSED", "QUALITY", "quality.fidelity.passed", {
          checks: ["FACE_COUNT", "IDENTITY", "STRUCTURE", "NON_TARGET_REGION", "ARTIFACTS"]
        }),
        providerEvent("PREVIEW_READY", "DELIVERY", "preview.ready", {
          watermarked: true,
          downloadable: false
        })
      ]
    };
  }
}

function providerEvent(
  type: Parameters<typeof createProviderEvent>[0],
  phase: Parameters<typeof createProviderEvent>[1],
  copyKey: Parameters<typeof createProviderEvent>[2],
  payload: EditTraceEvent["payload"] = {}
) {
  return createProviderEvent(type, phase, copyKey, payload);
}

function createProviderEvent(
  type: "STAGE_STARTED" | "PARAM_DIRECTION_APPLIED" | "STAGE_COMPLETED" | "QUALITY_CHECK_STARTED" | "QUALITY_CHECK_PASSED" | "PREVIEW_READY",
  phase: "RETOUCH" | "QUALITY" | "DELIVERY",
  copyKey: "portrait.stage.retouch.started" | "portrait.parameter.direction" | "portrait.stage.retouch.completed" | "quality.started" | "quality.fidelity.passed" | "preview.ready",
  payload: EditTraceEvent["payload"]
) {
  return {
    type,
    phase,
    occurredAt: "2030-01-02T03:04:05.000Z",
    visibility: "PREVIEW" as const,
    evidenceSource: type.startsWith("QUALITY_") || type === "PREVIEW_READY"
      ? "QUALITY_GATE" as const
      : "PROVIDER_RECEIPT" as const,
    copyKey,
    payload
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function buildOwnedApp(provider = new CountingImageProvider()) {
  const repository = new InMemoryTaskRepository();
  const service = new TaskService(repository, provider, new StageADemoAssetReader());
  return {
    app: buildApp({
      service,
      sessionAuthenticator: {
        authenticate: async (accessToken) => {
          if (accessToken === tokenA) return { userId: userA };
          if (accessToken === tokenB) return { userId: userB };
          throw new Error("UNAUTHORIZED");
        }
      }
    }),
    provider,
    repository,
    service
  };
}

describe("task ownership", () => {
  it("stores an owner and hides a task and its events from another user", async () => {
    const repository = new InMemoryTaskRepository();
    const service = new TaskService(
      repository,
      new CountingImageProvider(),
      new StageADemoAssetReader()
    );

    const task = await service.create(userA, portraitInput);

    await expect(service.get(userB, task.taskId)).rejects.toThrow("TASK_NOT_FOUND");
    await expect(service.getEvents(userB, task.taskId, 0)).rejects.toThrow("TASK_NOT_FOUND");
    await expect(repository.findForUser(userB, task.taskId)).resolves.toBeUndefined();
    await expect(repository.eventsAfter(userB, task.taskId, 0)).resolves.toEqual([]);
  });

  it("claims a confirmation only for its owner and never starts another user's provider run", async () => {
    const provider = new CountingImageProvider();
    const service = new TaskService(
      new InMemoryTaskRepository(),
      provider,
      new StageADemoAssetReader()
    );
    const task = await service.create(userA, portraitInput);

    await expect(service.confirmAndRunPreview(userB, task.taskId))
      .rejects.toThrow("TASK_NOT_FOUND");
    expect(provider.calls).toBe(0);

    await expect(service.confirmAndRunPreview(userA, task.taskId))
      .resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(provider.calls).toBe(1);
  });

  it("filters direct repository find, claim, and events by owner", async () => {
    const repository = new InMemoryTaskRepository();
    const storedTask: StoredTask = {
      taskId: "task-owned-by-a",
      userId: userA,
      status: "AWAITING_CONFIRMATION",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 0,
      input: structuredClone(portraitInput)
    };
    await repository.save(storedTask);

    await expect(repository.findForUser(userB, storedTask.taskId)).resolves.toBeUndefined();
    await expect(repository.claimAwaitingConfirmation(userB, storedTask.taskId))
      .resolves.toBeUndefined();
    await expect(repository.eventsAfter(userB, storedTask.taskId, 0)).resolves.toEqual([]);
    await expect(repository.claimAwaitingConfirmation(userA, storedTask.taskId))
      .resolves.toMatchObject({ userId: userA, status: "QUEUED" });
  });

  it("requires a bearer token on every task route before reading or validating task data", async () => {
    const { app } = buildOwnedApp();
    try {
      const responses = await Promise.all([
        app.inject({ method: "POST", url: "/v1/tasks", payload: portraitInput }),
        app.inject({ method: "GET", url: "/v1/tasks/task-id" }),
        app.inject({ method: "POST", url: "/v1/tasks/task-id/preview" }),
        app.inject({ method: "GET", url: "/v1/tasks/task-id/events?afterSequence=0" })
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ code: "UNAUTHORIZED" });
      }
    } finally {
      await app.close();
    }
  });

  it("uses the authenticated user as the created task owner and returns identical not-found responses to another user", async () => {
    const { app, provider } = buildOwnedApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        headers: bearer(tokenA),
        payload: portraitInput
      });
      expect(created.statusCode).toBe(201);
      const taskId = String(created.json().taskId);

      const responses = await Promise.all([
        app.inject({ method: "GET", url: `/v1/tasks/${taskId}`, headers: bearer(tokenB) }),
        app.inject({ method: "GET", url: `/v1/tasks/${taskId}/events?afterSequence=0`, headers: bearer(tokenB) }),
        app.inject({ method: "POST", url: `/v1/tasks/${taskId}/preview`, headers: bearer(tokenB) })
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ code: "TASK_NOT_FOUND" });
      }
      expect(provider.calls).toBe(0);
    } finally {
      await app.close();
    }
  });
});
