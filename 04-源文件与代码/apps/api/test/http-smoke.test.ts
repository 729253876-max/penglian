import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const portraitInput = {
  tool: "PORTRAIT_RETOUCH",
  inputAssetId: "demo-portrait-001",
  direction: "NATURAL_RESCUE",
  parameters: { naturalness: 85, detailLevel: 35 }
} as const;
const headers = {
  authorization: "Bearer fictional-http-smoke-token"
};

describe("real HTTP smoke on port 3100", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("serves the stage-A task lifecycle over a real TCP listener", async () => {
    app = buildApp({
      sessionAuthenticator: {
        authenticate: async () => ({ userId: "http-smoke-user" })
      }
    });
    await app.listen({ host: "127.0.0.1", port: 3100 });

    const createResponse = await fetch("http://127.0.0.1:3100/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(portraitInput)
    });
    const created = await createResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      status: "AWAITING_CONFIRMATION",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 3
    });

    const taskId = String(created.taskId);
    const previewResponse = await fetch(
      `http://127.0.0.1:3100/v1/tasks/${taskId}/preview`,
      { method: "POST", headers }
    );
    const preview = await previewResponse.json();

    expect(previewResponse.status).toBe(202);
    expect(preview).toMatchObject({
      taskId,
      status: "SUCCEEDED",
      lastSequence: 9,
      previewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg"
    });

    const readResponse = await fetch(
      `http://127.0.0.1:3100/v1/tasks/${taskId}`,
      { headers }
    );
    const read = await readResponse.json();

    expect(readResponse.status).toBe(200);
    expect(read).toMatchObject({
      taskId,
      status: "SUCCEEDED",
      lastSequence: 9
    });

    const eventsResponse = await fetch(
      `http://127.0.0.1:3100/v1/tasks/${taskId}/events?afterSequence=0`,
      { headers }
    );
    const events = await eventsResponse.json();

    expect(eventsResponse.status).toBe(200);
    expect(events.items).toHaveLength(9);
    expect(events.items.at(-1)).toMatchObject({
      sequence: 9,
      type: "PREVIEW_READY"
    });
    expect(events.nextSequence).toBe(9);

    const oldPhotoResponse = await fetch("http://127.0.0.1:3100/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        tool: "OLD_PHOTO_RESTORE",
        inputAssetId: "demo-old-photo-001",
        direction: "FAITHFUL_RESTORE",
        parameters: {
          colorizationRequested: true,
          colorizationConfirmed: true
        }
      })
    });

    expect(oldPhotoResponse.status).toBe(422);
    await expect(oldPhotoResponse.json()).resolves.toEqual({
      code: "STAGE_A_UNSUPPORTED_TOOL"
    });
  });
});
