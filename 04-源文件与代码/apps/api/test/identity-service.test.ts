import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  RefreshInput
} from "@photo-ai/contracts";
import {
  IdentityService,
  type IdentityRepository,
  type IdentityTransaction,
  type IdentityUser,
  type NewIdentityBinding,
  type StoredConsent,
  type StoredSession
} from "../src/application/identity-service.js";

const userId = "11111111-1111-4111-8111-111111111111";
const identityConfig = {
  wechatAppId: "wx4f7678cc595d276b",
  identityLookupKey: Buffer.alloc(32, 0x51),
  identityEncryptionKey: Buffer.alloc(32, 0x52),
  accessTokenLifetimeMilliseconds: 2 * 60 * 60 * 1000
};
const consent = {
  policyVersion: "2026-08-02",
  metadataRemoval: true
} as const;

class MutableClock {
  public constructor(private current: Date) {}

  public now(): Date {
    return new Date(this.current);
  }

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

interface FakeState {
  users: IdentityUser[];
  identities: Array<NewIdentityBinding & { userId: string }>;
  consents: StoredConsent[];
  sessions: StoredSession[];
}

function cloneState(state: FakeState): FakeState {
  return {
    users: structuredClone(state.users),
    identities: state.identities.map((identity) => ({
      ...identity,
      lookupHash: Buffer.from(identity.lookupHash),
      ciphertext: Buffer.from(identity.ciphertext)
    })),
    consents: structuredClone(state.consents),
    sessions: state.sessions.map((session) => ({
      ...structuredClone(session),
      deviceIdHash: Buffer.from(session.deviceIdHash),
      accessTokenHash: Buffer.from(session.accessTokenHash),
      refreshTokenHash: Buffer.from(session.refreshTokenHash)
    }))
  };
}

class FakeIdentityRepository implements IdentityRepository, IdentityTransaction {
  public state: FakeState = {
    users: [],
    identities: [],
    consents: [],
    sessions: []
  };
  public failNextInsert = false;
  public injectConcurrentSessionAfterNextRevokeAll = false;
  private transactionTail: Promise<void> = Promise.resolve();

  public async transaction<T>(work: (tx: IdentityTransaction) => Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    const before = cloneState(this.state);
    try {
      return await work(this);
    } catch (error) {
      this.state = before;
      throw error;
    } finally {
      release();
    }
  }

  public async findOrCreateUser(identity: NewIdentityBinding): Promise<IdentityUser> {
    const existingIdentity = this.state.identities.find((candidate) =>
      candidate.appId === identity.appId &&
      candidate.lookupHash.equals(identity.lookupHash)
    );
    if (existingIdentity) {
      const existingUser = this.state.users.find((user) => user.id === existingIdentity.userId);
      if (!existingUser) {
        throw new Error("TEST_CORRUPT_IDENTITY");
      }
      return structuredClone(existingUser);
    }

    const created: IdentityUser = {
      id: userId,
      status: "ACTIVE",
      createdAt: new Date(identity.createdAt),
      deletionRequestedAt: null
    };
    this.state.users.push(created);
    this.state.identities.push({
      ...identity,
      lookupHash: Buffer.from(identity.lookupHash),
      ciphertext: Buffer.from(identity.ciphertext),
      userId: created.id
    });
    return structuredClone(created);
  }

  public async recordConsent(record: StoredConsent): Promise<void> {
    this.state.consents.push(structuredClone(record));
  }

  public async revokeSessionsForDevice(
    targetUserId: string,
    deviceIdHash: Buffer,
    revokedAt: Date
  ): Promise<void> {
    for (const session of this.state.sessions) {
      if (
        session.userId === targetUserId &&
        session.revokedAt === null &&
        session.deviceIdHash.equals(deviceIdHash)
      ) {
        session.revokedAt = new Date(revokedAt);
      }
    }
  }

  public async revokeSessionsBeyondLimit(
    targetUserId: string,
    activeLimit: number,
    revokedAt: Date
  ): Promise<void> {
    const active = this.state.sessions
      .filter((session) => session.userId === targetUserId && session.revokedAt === null)
      .sort((left, right) =>
        left.lastUsedAt.getTime() - right.lastUsedAt.getTime() ||
        left.id.localeCompare(right.id)
      );
    for (const session of active.slice(0, Math.max(0, active.length - activeLimit))) {
      session.revokedAt = new Date(revokedAt);
    }
  }

  public async insertSession(session: StoredSession): Promise<void> {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      throw new Error("TEST_INSERT_FAILED");
    }
    this.state.sessions.push({
      ...structuredClone(session),
      deviceIdHash: Buffer.from(session.deviceIdHash),
      accessTokenHash: Buffer.from(session.accessTokenHash),
      refreshTokenHash: Buffer.from(session.refreshTokenHash)
    });
  }

  public async findSessionByRefreshHashForUpdate(
    refreshTokenHash: Buffer
  ): Promise<StoredSession | undefined> {
    return this.cloneSession(this.state.sessions.find((session) =>
      session.refreshTokenHash.equals(refreshTokenHash)
    ));
  }

  public async findSessionByAccessHashForUpdate(
    accessTokenHash: Buffer
  ): Promise<StoredSession | undefined> {
    return this.cloneSession(this.state.sessions.find((session) =>
      session.accessTokenHash.equals(accessTokenHash)
    ));
  }

  public async revokeSession(sessionId: string, revokedAt: Date): Promise<void> {
    const session = this.state.sessions.find((candidate) => candidate.id === sessionId);
    if (session && session.revokedAt === null) {
      session.revokedAt = new Date(revokedAt);
    }
  }

  public async revokeAllSessions(targetUserId: string, revokedAt: Date): Promise<void> {
    for (const session of this.state.sessions) {
      if (session.userId === targetUserId && session.revokedAt === null) {
        session.revokedAt = new Date(revokedAt);
      }
    }

    if (this.injectConcurrentSessionAfterNextRevokeAll) {
      this.injectConcurrentSessionAfterNextRevokeAll = false;
      const user = this.state.users.find((candidate) => candidate.id === targetUserId);
      if (user?.status === "ACTIVE") {
        this.state.sessions.push({
          id: "concurrent-login-session",
          userId: targetUserId,
          deviceIdHash: createHash("sha256").update("racing-device").digest(),
          accessTokenHash: Buffer.alloc(32, 0xa1),
          accessExpiresAt: new Date(revokedAt.getTime() + 2 * 60 * 60 * 1_000),
          refreshTokenHash: Buffer.alloc(32, 0xb1),
          refreshExpiresAt: new Date(revokedAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
          lastUsedAt: new Date(revokedAt),
          revokedAt: null
        });
      }
    }
  }

  public async markUserDeleting(targetUserId: string, requestedAt: Date): Promise<void> {
    const user = this.state.users.find((candidate) => candidate.id === targetUserId);
    if (!user) {
      throw new Error("USER_NOT_FOUND");
    }
    user.status = "DELETING";
    user.deletionRequestedAt = new Date(requestedAt);
  }

  public activeSessions(targetUserId = userId): StoredSession[] {
    return this.state.sessions.filter(
      (session) => session.userId === targetUserId && session.revokedAt === null
    );
  }

  public revokedDeviceHashes(): string[] {
    return this.state.sessions
      .filter((session) => session.revokedAt !== null)
      .map((session) => session.deviceIdHash.toString("hex"));
  }

  private cloneSession(session: StoredSession | undefined): StoredSession | undefined {
    if (!session) {
      return undefined;
    }
    return {
      ...structuredClone(session),
      deviceIdHash: Buffer.from(session.deviceIdHash),
      accessTokenHash: Buffer.from(session.accessTokenHash),
      refreshTokenHash: Buffer.from(session.refreshTokenHash)
    };
  }
}

function createFixture() {
  const repository = new FakeIdentityRepository();
  const clock = new MutableClock(new Date("2030-01-02T03:04:05.000Z"));
  const service = new IdentityService(repository, identityConfig, clock);
  return { repository, clock, service };
}

async function login(
  service: IdentityService,
  deviceId = "device-1",
  openId = "openid-1"
) {
  return service.login({ openId, deviceId, consent });
}

async function refresh(
  service: IdentityService,
  refreshToken: string,
  deviceId = "device-1"
) {
  return service.refresh({ refreshToken, deviceId });
}

describe("IdentityService", () => {
  it("refuses login without metadata-removal consent before opening a transaction", async () => {
    const { repository, service } = createFixture();

    await expect(service.login({
      openId: "openid-without-consent",
      deviceId: "device-without-consent",
      consent: {
        policyVersion: "2026-08-02",
        metadataRemoval: false
      }
    } as unknown as Parameters<IdentityService["login"]>[0]))
      .rejects.toThrow("CONSENT_REQUIRED");

    expect(repository.state).toEqual({
      users: [],
      identities: [],
      consents: [],
      sessions: []
    });
  });

  it("refuses login for an unapproved policy version before opening a transaction", async () => {
    const { repository, service } = createFixture();

    await expect(service.login({
      openId: "openid-with-outdated-policy",
      deviceId: "device-with-outdated-policy",
      consent: {
        policyVersion: "outdated-policy",
        metadataRemoval: true
      }
    } as unknown as Parameters<IdentityService["login"]>[0]))
      .rejects.toThrow("CONSENT_REQUIRED");

    expect(repository.state).toEqual({
      users: [],
      identities: [],
      consents: [],
      sessions: []
    });
  });

  it("logs in transactionally with consent and exact 2-hour/30-day opaque expiries", async () => {
    const { repository, clock, service } = createFixture();
    const now = clock.now();

    const pair = await login(service);

    expect(pair.accessExpiresAt.getTime() - now.getTime()).toBe(2 * 60 * 60 * 1000);
    expect(pair.refreshExpiresAt.getTime() - now.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(repository.state.users).toMatchObject([{ id: userId, status: "ACTIVE" }]);
    expect(repository.state.consents).toMatchObject([{
      userId,
      consentType: "METADATA_REMOVAL",
      policyVersion: "2026-08-02",
      granted: true,
      revokedAt: null
    }]);
    expect(repository.activeSessions()).toHaveLength(1);

    const stored = repository.activeSessions()[0]!;
    expect(stored.accessTokenHash).toEqual(
      createHash("sha256").update(pair.accessToken).digest()
    );
    expect(stored.refreshTokenHash).toEqual(
      createHash("sha256").update(pair.refreshToken).digest()
    );
    expect(JSON.stringify(repository.state)).not.toContain(pair.accessToken);
    expect(JSON.stringify(repository.state)).not.toContain(pair.refreshToken);
  });

  it("uses the injected acceptance access lifetime without extending refresh lifetime", async () => {
    const repository = new FakeIdentityRepository();
    const clock = new MutableClock(new Date("2030-01-02T03:04:05.000Z"));
    const service = new IdentityService(repository, {
      ...identityConfig,
      accessTokenLifetimeMilliseconds: 60_000
    }, clock);
    const now = clock.now();

    const pair = await login(service);

    expect(pair.accessExpiresAt.getTime() - now.getTime()).toBe(60_000);
    expect(pair.refreshExpiresAt.getTime() - now.getTime())
      .toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("keeps at most five active devices and revokes the least recently used device", async () => {
    const { repository, clock, service } = createFixture();

    for (let index = 1; index <= 6; index += 1) {
      await login(service, `device-${index}`);
      clock.advance(1_000);
    }

    expect(repository.activeSessions()).toHaveLength(5);
    expect(repository.revokedDeviceHashes()).toContain(
      createHash("sha256").update("device-1").digest("hex")
    );
  });

  it("replaces an existing session when the same device logs in again", async () => {
    const { repository, service } = createFixture();

    await login(service, "same-device");
    const replacement = await login(service, "same-device");

    expect(repository.activeSessions()).toHaveLength(1);
    expect(repository.activeSessions()[0]!.accessTokenHash).toEqual(
      createHash("sha256").update(replacement.accessToken).digest()
    );
  });

  it("atomically revokes the old pair and inserts a fresh pair on refresh", async () => {
    const { repository, clock, service } = createFixture();
    const oldPair = await login(service);
    clock.advance(60_000);
    const refreshNow = clock.now();

    const newPair = await service.refresh({
      refreshToken: oldPair.refreshToken,
      deviceId: "device-1"
    });

    expect(newPair.accessToken).not.toBe(oldPair.accessToken);
    expect(newPair.refreshToken).not.toBe(oldPair.refreshToken);
    expect(newPair.accessExpiresAt.getTime() - refreshNow.getTime()).toBe(2 * 60 * 60 * 1000);
    expect(newPair.refreshExpiresAt).toEqual(oldPair.refreshExpiresAt);
    expect(repository.activeSessions()).toHaveLength(1);
    expect(repository.state.sessions).toHaveLength(2);
    await expect(refresh(service, oldPair.refreshToken)).rejects.toThrow("SESSION_REVOKED");
  });

  it("rejects a runtime refresh call that omits the contract-required device id", async () => {
    const { repository, service } = createFixture();
    const oldPair = await login(service);

    await expect(
      service.refresh(oldPair.refreshToken as unknown as RefreshInput)
    ).rejects.toThrow("INVALID_REFRESH_INPUT");

    expect(repository.activeSessions()).toHaveLength(1);
    expect(repository.state.sessions).toHaveLength(1);
  });

  it("never extends the original 30-day refresh deadline across repeated rotations", async () => {
    const { clock, service } = createFixture();
    let pair = await login(service);
    const absoluteDeadline = pair.refreshExpiresAt;

    for (const elapsedDays of [10, 10, 9]) {
      clock.advance(elapsedDays * 24 * 60 * 60 * 1_000);
      pair = await refresh(service, pair.refreshToken);
      expect(pair.refreshExpiresAt).toEqual(absoluteDeadline);
    }

    clock.advance(24 * 60 * 60 * 1_000);
    await expect(refresh(service, pair.refreshToken)).rejects.toThrow("SESSION_EXPIRED");
  });

  it("rejects expired, revoked, and wrong-device refresh attempts", async () => {
    const expiredFixture = createFixture();
    const expired = await login(expiredFixture.service);
    expiredFixture.clock.advance(30 * 24 * 60 * 60 * 1000 + 1);
    await expect(refresh(expiredFixture.service, expired.refreshToken))
      .rejects.toThrow("SESSION_EXPIRED");

    const revokedFixture = createFixture();
    const revoked = await login(revokedFixture.service);
    await revokedFixture.service.logoutCurrent(revoked.accessToken);
    await expect(refresh(revokedFixture.service, revoked.refreshToken))
      .rejects.toThrow("SESSION_REVOKED");

    const deviceFixture = createFixture();
    const devicePair = await login(deviceFixture.service);
    await expect(deviceFixture.service.refresh({
      refreshToken: devicePair.refreshToken,
      deviceId: "other-device"
    })).rejects.toThrow("SESSION_REVOKED");
  });

  it("allows exactly one winner when the same refresh token is used concurrently", async () => {
    const { repository, service } = createFixture();
    const oldPair = await login(service);

    const results = await Promise.allSettled([
      refresh(service, oldPair.refreshToken),
      refresh(service, oldPair.refreshToken)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: new Error("SESSION_REVOKED") }
    ]);
    expect(repository.activeSessions()).toHaveLength(1);
  });

  it("rolls back old-session revocation when refresh insertion fails", async () => {
    const { repository, service } = createFixture();
    const oldPair = await login(service);
    repository.failNextInsert = true;

    await expect(refresh(service, oldPair.refreshToken)).rejects.toThrow("TEST_INSERT_FAILED");

    expect(repository.activeSessions()).toHaveLength(1);
    await expect(refresh(service, oldPair.refreshToken)).resolves.toBeDefined();
  });

  it("logs out the current session without revoking other devices", async () => {
    const { repository, service } = createFixture();
    const first = await login(service, "device-1");
    await login(service, "device-2");

    await service.logoutCurrent(first.accessToken);

    expect(repository.activeSessions()).toHaveLength(1);
    expect(repository.activeSessions()[0]!.deviceIdHash).toEqual(
      createHash("sha256").update("device-2").digest()
    );
  });

  it("logs out all sessions for the authenticated user", async () => {
    const { repository, service } = createFixture();
    const first = await login(service, "device-1");
    await login(service, "device-2");

    await service.logoutAll(first.accessToken);

    expect(repository.activeSessions()).toHaveLength(0);
  });

  it("marks a user deleting and revokes every session in one transaction", async () => {
    const { repository, clock, service } = createFixture();
    const first = await login(service, "device-1");
    await login(service, "device-2");
    const requestedAt = clock.now();
    repository.injectConcurrentSessionAfterNextRevokeAll = true;

    await service.requestDeletion(first.accessToken);

    expect(repository.state.users[0]).toMatchObject({
      status: "DELETING",
      deletionRequestedAt: requestedAt
    });
    expect(repository.activeSessions()).toHaveLength(0);
    await expect(login(service, "device-3")).rejects.toThrow("USER_DELETING");
  });
});
