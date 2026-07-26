import { describe, expect, it } from "vitest";
import type { EditTraceEvent, TaskSnapshot } from "@photo-ai/contracts";
import { buildApp } from "../src/app.js";
import type { TaskApiService } from "../src/routes/tasks.js";

const portraitInput = {
  tool: "PORTRAIT_RETOUCH",
  inputAssetId: "demo-portrait-001",
  direction: "NATURAL",
  parameters: { brightness: 0, warmth: 0, naturalness: 80 }
} as const;

async function createPortraitTask(app: ReturnType<typeof buildApp>) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: portraitInput
  });
  expect(response.statusCode).toBe(201);
  return response.json() as TaskSnapshot;
}

class ThrowingTaskService implements TaskApiService {
  public constructor(private readonly error: Error) {}

  public async create(): Promise<TaskSnapshot> {
    throw this.error;
  }

  public async confirmAndRunPreview(): Promise<TaskSnapshot> {
    throw this.error;
  }

  public async get(): Promise<TaskSnapshot> {
    throw this.error;
  }

  public async getEvents(): Promise<EditTraceEvent[]> {
    throw this.error;
  }
}

describe("tasks API", () => {
  it("creates a portrait preview task", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        payload: {
          ...portraitInput
        }
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        status: "AWAITING_CONFIRMATION",
        tool: "PORTRAIT_RETOUCH",
        lastSequence: 3
      });
    } finally {
      await app.close();
    }
  });

  it("confirms, completes, and reads a portrait preview", async () => {
    const app = buildApp();
    try {
      const task = await createPortraitTask(app);

      const preview = await app.inject({
        method: "POST",
        url: `/v1/tasks/${task.taskId}/preview`
      });
      expect(preview.statusCode).toBe(202);
      expect(preview.json()).toMatchObject({
        taskId: task.taskId,
        status: "SUCCEEDED",
        lastSequence: 9,
        previewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg"
      });

      const read = await app.inject({
        method: "GET",
        url: `/v1/tasks/${task.taskId}`
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        taskId: task.taskId,
        status: "SUCCEEDED",
        lastSequence: 9
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a valid old-photo contract at the stage-A API boundary", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        payload: {
          tool: "OLD_PHOTO_RESTORE",
          inputAssetId: "demo-old-photo-001",
          direction: "FAITHFUL_RESTORE",
          parameters: { colorizationRequested: true, colorizationConfirmed: true }
        }
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ code: "STAGE_A_UNSUPPORTED_TOOL" });
    } finally {
      await app.close();
    }
  });

  it("returns a validation error for an invalid create body", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        payload: { tool: "PORTRAIT_RETOUCH" }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_TASK_INPUT" });
    } finally {
      await app.close();
    }
  });

  it("returns not found for a missing task", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/tasks/missing-task"
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ code: "TASK_NOT_FOUND" });
    } finally {
      await app.close();
    }
  });

  it.each(["1.5", "-1"])("rejects invalid afterSequence %s", async (afterSequence) => {
    const app = buildApp();
    try {
      const task = await createPortraitTask(app);
      const response = await app.inject({
        method: "GET",
        url: `/v1/tasks/${task.taskId}/events?afterSequence=${afterSequence}`
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "INVALID_SEQUENCE" });
    } finally {
      await app.close();
    }
  });

  it("returns incremental events and preserves the cursor for an empty page", async () => {
    const app = buildApp();
    try {
      const task = await createPortraitTask(app);
      const incremental = await app.inject({
        method: "GET",
        url: `/v1/tasks/${task.taskId}/events?afterSequence=1`
      });
      expect(incremental.statusCode).toBe(200);
      expect(incremental.json()).toMatchObject({
        items: [
          { sequence: 2, type: "DIAGNOSIS_FINDING" },
          { sequence: 3, type: "PLAN_READY" }
        ],
        nextSequence: 3
      });

      const empty = await app.inject({
        method: "GET",
        url: `/v1/tasks/${task.taskId}/events?afterSequence=3`
      });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({ items: [], nextSequence: 3 });
    } finally {
      await app.close();
    }
  });

  it("rejects concurrent confirmations without writing a second event batch", async () => {
    const app = buildApp();
    try {
      const task = await createPortraitTask(app);
      const [first, second] = await Promise.all([
        app.inject({ method: "POST", url: `/v1/tasks/${task.taskId}/preview` }),
        app.inject({ method: "POST", url: `/v1/tasks/${task.taskId}/preview` })
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);
      expect([first.json().code, second.json().code]).toContain(
        "TASK_CONFIRMATION_CONFLICT"
      );
      const events = await app.inject({
        method: "GET",
        url: `/v1/tasks/${task.taskId}/events?afterSequence=0`
      });
      expect(events.statusCode).toBe(200);
      expect(events.json().items).toHaveLength(9);
      expect(events.json().nextSequence).toBe(9);
    } finally {
      await app.close();
    }
  });

  it("does not leak an unexpected internal error", async () => {
    const app = buildApp({
      service: new ThrowingTaskService(
        new Error("provider credential: never disclose this detail")
      )
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        payload: portraitInput
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ code: "INTERNAL_ERROR" });
      expect(response.body).not.toContain("provider credential");
    } finally {
      await app.close();
    }
  });

  it("maps an illegal task transition to a conflict", async () => {
    const app = buildApp({
      service: new ThrowingTaskService(
        new Error("Illegal task transition: REVIEWING -> PROCESSING")
      )
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        payload: portraitInput
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ code: "ILLEGAL_TASK_STATE" });
    } finally {
      await app.close();
    }
  });
});
