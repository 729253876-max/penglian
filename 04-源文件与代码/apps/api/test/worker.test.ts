import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadWorker, createUploadJobHandlers } from "../src/worker.js";

describe("upload worker", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("renews the lease while a long-running handler is active", async () => {
    vi.useFakeTimers();
    const renewals: unknown[] = [];
    let finish!: () => void;
    const handlerFinished = new Promise<void>((resolve) => { finish = resolve; });
    const worker = new UploadWorker({
      leaseNext: async () => ({ jobId: "job-1", type: "NORMALIZE_UPLOAD", payload: {}, attempt: 1, maxAttempts: 2, leaseToken: "lease-1", leaseExpiresAt: new Date("2030-01-02T03:04:35.000Z") }),
      renew: async (...args) => { renewals.push(args); },
      complete: async () => {}, retry: async () => {}, enqueue: async () => ({ jobId: "unused" }), fail: async () => {}
    }, { NORMALIZE_UPLOAD: async () => handlerFinished }, { now: () => new Date("2030-01-02T03:04:15.000Z") });

    const running = worker.runOneJob("worker-1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renewals).toEqual([["job-1", "lease-1", new Date("2030-01-02T03:04:45.000Z")]]);
    finish();
    await running;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(renewals).toHaveLength(1);
  });

  it("does not reschedule a lease-renewal failure while the handler is still running", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const handlerFinished = new Promise<void>((resolve) => { finish = resolve; });
    let retries = 0;
    const worker = new UploadWorker({
      leaseNext: async () => ({ jobId: "job-1", type: "NORMALIZE_UPLOAD", payload: {}, attempt: 1, maxAttempts: 2, leaseToken: "lease-1", leaseExpiresAt: new Date() }),
      renew: async () => { throw new Error("JOB_LEASE_LOST"); },
      complete: async () => {}, retry: async () => { retries += 1; }, enqueue: async () => ({ jobId: "unused" }), fail: async () => {}
    }, { NORMALIZE_UPLOAD: async () => handlerFinished }, { now: () => new Date("2030-01-02T03:04:15.000Z") });

    const running = worker.runOneJob("worker-1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retries).toBe(0);
    finish();
    await running;
    expect(retries).toBe(1);
  });

  it("stops after the current job when aborted and does not lease another job", async () => {
    const controller = new AbortController();
    let leases = 0;
    let waits = 0;
    const worker = new UploadWorker({
      leaseNext: async () => {
        leases += 1;
        return { jobId: "job-1", type: "NORMALIZE_UPLOAD", payload: {}, attempt: 1, maxAttempts: 2, leaseToken: "lease-1", leaseExpiresAt: new Date() };
      },
      renew: async () => {}, complete: async () => {}, retry: async () => {}, enqueue: async () => ({ jobId: "unused" }), fail: async () => {}
    }, {
      NORMALIZE_UPLOAD: async () => { controller.abort(); }
    });

    await worker.run("worker-1", controller.signal, async () => { waits += 1; });

    expect(leases).toBe(1);
    expect(waits).toBe(0);
  });

  it("uses an injected non-blocking wait when no work is available", async () => {
    const controller = new AbortController();
    let leases = 0;
    const worker = new UploadWorker({
      leaseNext: async () => { leases += 1; return undefined; },
      renew: async () => {}, complete: async () => {}, retry: async () => {}, enqueue: async () => ({ jobId: "unused" }), fail: async () => {}
    }, {});

    await worker.run("worker-1", controller.signal, async () => { controller.abort(); });

    expect(leases).toBe(1);
  });

  it("leases, dispatches, and completes exactly one job", async () => {
    const events: string[] = [];
    const worker = new UploadWorker({
      leaseNext: async () => ({ jobId: "job-1", type: "NORMALIZE_UPLOAD", payload: { sessionId: "s1" }, attempt: 1, maxAttempts: 2, leaseToken: "lease-1", leaseExpiresAt: new Date() }),
      renew: async () => {}, complete: async () => { events.push("complete"); }, retry: async () => { events.push("retry"); }, enqueue: async () => ({ jobId: "unused" })
      , fail: async () => { events.push("fail"); }
    }, { NORMALIZE_UPLOAD: async () => { events.push("handle"); } }, { now: () => new Date("2030-01-02T03:04:05.000Z") });

    await expect(worker.runOneJob("worker-1")).resolves.toBe(true);
    expect(events).toEqual(["handle", "complete"]);
  });

  it("reschedules retryable failures and reports no work without a lease", async () => {
    const retries: unknown[] = [];
    let hasJob = true;
    const worker = new UploadWorker({
      leaseNext: async () => hasJob ? (hasJob = false, { jobId: "job-1", type: "MODERATE_UPLOAD", payload: {}, attempt: 1, maxAttempts: 3, leaseToken: "lease-1", leaseExpiresAt: new Date() }) : undefined,
      renew: async () => {}, complete: async () => {}, retry: async (...args) => { retries.push(args); }, enqueue: async () => ({ jobId: "unused" })
      , fail: async () => {}
    }, { MODERATE_UPLOAD: async () => { throw new Error("MODERATION_SERVICE_ERROR"); } }, { now: () => new Date("2030-01-02T03:04:05.000Z") });

    await expect(worker.runOneJob("worker-1")).resolves.toBe(true);
    expect(retries).toEqual([["job-1", "lease-1", new Date("2030-01-02T03:04:35.000Z"), "MODERATION_SERVICE_ERROR"]]);
    await expect(worker.runOneJob("worker-1")).resolves.toBe(false);
  });

  it("marks the final failed attempt terminal instead of leaving a leased zombie", async () => {
    const failures: unknown[] = [];
    const worker = new UploadWorker({
      leaseNext: async () => ({ jobId: "job-1", type: "NORMALIZE_UPLOAD", payload: {}, attempt: 2, maxAttempts: 2, leaseToken: "lease-1", leaseExpiresAt: new Date() }),
      renew: async () => {}, complete: async () => {}, retry: async () => {}, enqueue: async () => ({ jobId: "unused" }),
      fail: async (jobId, leaseToken, errorCode) => { failures.push([jobId, leaseToken, errorCode]); }
    }, { NORMALIZE_UPLOAD: async () => { throw new Error("TENCENT_CI_TIMEOUT"); } }, { now: () => new Date("2030-01-02T03:04:05.000Z") });

    await expect(worker.runOneJob("worker-1")).resolves.toBe(true);
    expect(failures).toEqual([["job-1", "lease-1", "TENCENT_CI_TIMEOUT"]]);
  });

  it.each([
    ["missing handler", {}, "JOB_HANDLER_NOT_CONFIGURED"],
    ["invalid persisted payload", { NORMALIZE_UPLOAD: async () => { throw new Error("INVALID_JOB_PAYLOAD"); } }, "INVALID_JOB_PAYLOAD"]
  ] as const)("marks %s terminal on the first attempt", async (_name, handlers, expectedCode) => {
    const failures: unknown[] = [];
    const worker = new UploadWorker({
      leaseNext: async () => ({ jobId: "job-1", type: "NORMALIZE_UPLOAD", payload: {}, attempt: 1, maxAttempts: 3, leaseToken: "lease-1", leaseExpiresAt: new Date() }),
      renew: async () => {}, complete: async () => {}, retry: async () => {}, enqueue: async () => ({ jobId: "unused" }),
      fail: async (...args) => { failures.push(args); }
    }, handlers);

    await expect(worker.runOneJob("worker-1")).resolves.toBe(true);
    expect(failures).toEqual([["job-1", "lease-1", expectedCode]]);
  });
});

describe("upload job handlers", () => {
  it("dispatches normalization with server-derived output keys", async () => {
    const calls: unknown[] = [];
    const handlers = createUploadJobHandlers({
      normalization: { normalizeAcceptedUpload: async (input) => { calls.push(input); } },
      moderation: { process: async () => ({ terminal: true as const, state: "APPROVED" as const }) },
      storage: { deleteObject: async () => {} },
      clock: { now: () => new Date("2030-01-02T03:04:05.000Z") }
    });
    await handlers.NORMALIZE_UPLOAD!({
      jobId: "j1", type: "NORMALIZE_UPLOAD", attempt: 1, maxAttempts: 2,
      leaseToken: "l1", leaseExpiresAt: new Date(),
      payload: { sessionId: "session-1", userId: "user-1", sourceObjectKey: "users/user-1/uploads/session-1/original" }
    });
    expect(calls).toEqual([{
      sessionId: "session-1", userId: "user-1",
      sourceObjectKey: "users/user-1/uploads/session-1/original",
      normalizedObjectKey: "users/user-1/uploads/session-1/normalized",
      auditObjectKey: "users/user-1/uploads/session-1/audit",
      now: new Date("2030-01-02T03:04:05.000Z")
    }]);
  });

  it("dispatches moderation attempt metadata and deletes only payload object keys", async () => {
    const moderationCalls: unknown[] = [];
    const deleted: string[] = [];
    const handlers = createUploadJobHandlers({
      normalization: { normalizeAcceptedUpload: async () => {} },
      moderation: { process: async (input) => { moderationCalls.push(input); return { terminal: true as const, state: "APPROVED" as const }; } },
      storage: { deleteObject: async (key) => { deleted.push(key); } },
      clock: { now: () => new Date("2030-01-02T03:05:05.000Z") }
    });
    await handlers.MODERATE_UPLOAD!({
      jobId: "j2", type: "MODERATE_UPLOAD", attempt: 1, maxAttempts: 3,
      leaseToken: "l2", leaseExpiresAt: new Date(),
      payload: { sessionId: "session-1", auditObjectKey: "users/user-1/uploads/session-1/audit", startedAt: "2030-01-02T03:04:05.000Z", attempt: 2 }
    });
    await handlers.CLEANUP_UPLOAD!({
      jobId: "j3", type: "CLEANUP_UPLOAD", attempt: 1, maxAttempts: 3,
      leaseToken: "l3", leaseExpiresAt: new Date(),
      payload: { objectKeys: ["users/user-1/uploads/session-1/original", "users/user-1/uploads/session-1/audit"] }
    });
    expect(moderationCalls).toEqual([{
      sessionId: "session-1", auditObjectKey: "users/user-1/uploads/session-1/audit",
      attempt: 2, startedAt: new Date("2030-01-02T03:04:05.000Z"),
      now: new Date("2030-01-02T03:05:05.000Z")
    }]);
    expect(deleted).toEqual([
      "users/user-1/uploads/session-1/original",
      "users/user-1/uploads/session-1/audit"
    ]);
  });

  it("rejects malformed payloads before invoking a dependency", async () => {
    let calls = 0;
    const handlers = createUploadJobHandlers({
      normalization: { normalizeAcceptedUpload: async () => { calls += 1; } },
      moderation: { process: async () => { calls += 1; return { terminal: true as const, state: "FAILED" as const }; } },
      storage: { deleteObject: async () => { calls += 1; } }
    });
    await expect(handlers.NORMALIZE_UPLOAD!({
      jobId: "j", type: "NORMALIZE_UPLOAD", attempt: 1, maxAttempts: 2,
      leaseToken: "l", leaseExpiresAt: new Date(), payload: { sessionId: "../bad" }
    })).rejects.toThrow("INVALID_JOB_PAYLOAD");
    expect(calls).toBe(0);
  });
});
