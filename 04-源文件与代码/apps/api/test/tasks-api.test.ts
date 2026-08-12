import { describe, expect, it } from "vitest";
import type { EditTraceEvent, TaskSnapshot } from "@photo-ai/contracts";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import type { TaskApiService } from "../src/routes/tasks.js";
import { StageADemoAssetReader } from "../src/application/task-service.js";

const portraitInput = {
  tool: "PORTRAIT_RETOUCH",
  inputAssetId: "demo-portrait-001",
  direction: "NATURAL_RESCUE",
  parameters: { naturalness: 85, detailLevel: 35 }
} as const;

function buildTaskApp(options: BuildAppOptions = {}) {
  const app = buildApp({
    ...options,
    portraitAssetReader: new StageADemoAssetReader(),
    sessionAuthenticator: {
      authenticate: async () => ({ userId: "task-api-user" })
    }
  });
  app.addHook("onRequest", async (request) => {
    request.headers.authorization ??= "Bearer fictional-task-api-token";
  });
  return app;
}

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
  it.each([
    ["missing", new Error("ASSET_NOT_APPROVED")],
    ["cross-user", new Error("ASSET_NOT_APPROVED")]
  ])("returns a stable client error for a %s approved asset lookup", async (_case, error) => {
    const app = buildTaskApp({ service: new ThrowingTaskService(error) });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        payload: portraitInput
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ code: "ASSET_NOT_APPROVED" });
    } finally {
      await app.close();
    }
  });

  it("creates a portrait preview task", async () => {
    const app = buildTaskApp();
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
        lastSequence: 8
      });
    } finally {
      await app.close();
    }
  });

  it("confirms, completes, and reads a portrait preview", async () => {
    const app = buildTaskApp();
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
        lastSequence: 14,
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
        lastSequence: 14
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a valid old-photo contract at the stage-A API boundary", async () => {
    const app = buildTaskApp();
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

  it.each([
    [
      "an unknown portrait asset",
      {
        ...portraitInput,
        inputAssetId: "completely-unknown-asset"
      }
    ],
    [
      "an unsupported portrait direction",
      {
        ...portraitInput,
        direction: "CLEAR_RESCUE"
      }
    ],
    [
      "unregistered demo parameters",
      {
        ...portraitInput,
        parameters: {
          ...portraitInput.parameters,
          detailLevel: 25
        }
      }
    ]
  ])("rejects %s at the stage-A API boundary", async (_name, payload) => {
    const app = buildTaskApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        payload
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        code: "STAGE_A_UNSUPPORTED_DEMO_INPUT"
      });
    } finally {
      await app.close();
    }
  });

  it("returns a validation error for an invalid create body", async () => {
    const app = buildTaskApp();
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
    const app = buildTaskApp();
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

  it("returns not found when confirming a missing task", async () => {
    const app = buildTaskApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tasks/missing-task/preview"
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ code: "TASK_NOT_FOUND" });
    } finally {
      await app.close();
    }
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", " "],
    ["scientific notation", "1e3"],
    ["hexadecimal", "0x10"],
    ["a decimal fraction", "1.5"],
    ["Infinity", "Infinity"],
    ["a negative integer", "-1"],
    ["an unsafe integer", "9007199254740992"],
    ["a leading-zero integer", "01"]
  ])("rejects afterSequence with %s", async (_name, afterSequence) => {
    const app = buildTaskApp();
    try {
      const task = await createPortraitTask(app);
      const response = await app.inject({
        method: "GET",
        url: `/v1/tasks/${task.taskId}/events?afterSequence=${encodeURIComponent(afterSequence)}`
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "INVALID_SEQUENCE" });
    } finally {
      await app.close();
    }
  });

  it.each([
    ["zero", "0", 8],
    ["an ordinary decimal integer", "2", 8]
  ])("accepts afterSequence %s", async (_name, afterSequence, nextSequence) => {
    const app = buildTaskApp();
    try {
      const task = await createPortraitTask(app);
      const response = await app.inject({
        method: "GET",
        url: `/v1/tasks/${task.taskId}/events?afterSequence=${afterSequence}`
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().nextSequence).toBe(nextSequence);
    } finally {
      await app.close();
    }
  });

  it("returns incremental events and preserves the cursor for an empty page", async () => {
    const app = buildTaskApp();
    try {
      const task = await createPortraitTask(app);
      const incremental = await app.inject({
        method: "GET",
        url: `/v1/tasks/${task.taskId}/events?afterSequence=1`
      });
      expect(incremental.statusCode).toBe(200);
      expect(incremental.json()).toMatchObject({
        items: [
          { sequence: 2, type: "DIAGNOSIS_STARTED" },
          { sequence: 3, type: "DIAGNOSIS_FINDING" },
          { sequence: 4, type: "DIAGNOSIS_FINDING" },
          { sequence: 5, type: "PROTECTION_RECORDED" },
          { sequence: 6, type: "PLAN_READY" },
          { sequence: 7, type: "PLAN_READY" },
          { sequence: 8, type: "PLAN_SELECTED" }
        ],
        nextSequence: 8
      });

      const empty = await app.inject({
        method: "GET",
        url: `/v1/tasks/${task.taskId}/events?afterSequence=8`
      });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({ items: [], nextSequence: 8 });
    } finally {
      await app.close();
    }
  });

  it("rejects concurrent confirmations without writing a second event batch", async () => {
    const app = buildTaskApp();
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
      expect(events.json().items.map((event: EditTraceEvent) => event.type)).toEqual([
        "ASSET_APPROVED",
        "DIAGNOSIS_STARTED",
        "DIAGNOSIS_FINDING",
        "DIAGNOSIS_FINDING",
        "PROTECTION_RECORDED",
        "PLAN_READY",
        "PLAN_READY",
        "PLAN_SELECTED",
        "STAGE_STARTED",
        "PARAM_DIRECTION_APPLIED",
        "STAGE_COMPLETED",
        "QUALITY_CHECK_STARTED",
        "QUALITY_CHECK_PASSED",
        "PREVIEW_READY"
      ]);
      expect(events.json().nextSequence).toBe(14);
    } finally {
      await app.close();
    }
  });

  it("does not leak an unexpected internal error", async () => {
    const app = buildTaskApp({
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
    const app = buildTaskApp({
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
