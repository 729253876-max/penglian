import {
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  RefreshInputSchema,
  type RefreshInput,
  type WechatLoginInput
} from "@photo-ai/contracts";
import type { ApiConfig } from "../config.js";
import {
  systemClock,
  type Clock
} from "../domain/clock.js";
import { protectOpenId } from "../domain/identity-protection.js";
import {
  digestToken,
  issueToken,
  type IssuedToken
} from "../domain/session-token.js";

const refreshLifetimeMilliseconds = 30 * 24 * 60 * 60 * 1_000;

export interface IdentityUser {
  id: string;
  status: "ACTIVE" | "DELETING" | "DELETED";
  createdAt: Date;
  deletionRequestedAt: Date | null;
}

export interface NewIdentityBinding {
  appId: string;
  lookupHash: Buffer;
  ciphertext: Buffer;
  createdAt: Date;
}

export interface StoredConsent {
  id: string;
  userId: string;
  consentType: "METADATA_REMOVAL";
  policyVersion: string;
  granted: boolean;
  grantedAt: Date;
  revokedAt: Date | null;
}

export interface StoredSession {
  id: string;
  userId: string;
  deviceIdHash: Buffer;
  accessTokenHash: Buffer;
  accessExpiresAt: Date;
  refreshTokenHash: Buffer;
  refreshExpiresAt: Date;
  lastUsedAt: Date;
  revokedAt: Date | null;
}

export interface IdentityTransaction {
  findOrCreateUser(identity: NewIdentityBinding): Promise<IdentityUser>;
  recordConsent(consent: StoredConsent): Promise<void>;
  revokeSessionsForDevice(
    userId: string,
    deviceIdHash: Buffer,
    revokedAt: Date
  ): Promise<void>;
  revokeSessionsBeyondLimit(
    userId: string,
    activeLimit: number,
    revokedAt: Date
  ): Promise<void>;
  insertSession(session: StoredSession): Promise<void>;
  findSessionByRefreshHashForUpdate(
    refreshTokenHash: Buffer
  ): Promise<StoredSession | undefined>;
  findSessionByAccessHashForUpdate(
    accessTokenHash: Buffer
  ): Promise<StoredSession | undefined>;
  revokeSession(sessionId: string, revokedAt: Date): Promise<void>;
  revokeAllSessions(userId: string, revokedAt: Date): Promise<void>;
  markUserDeleting(userId: string, requestedAt: Date): Promise<void>;
}

export interface IdentityRepository {
  transaction<T>(work: (tx: IdentityTransaction) => Promise<T>): Promise<T>;
}

export interface VerifiedWechatLoginInput
  extends Omit<WechatLoginInput, "code"> {
  openId: string;
}

export interface ApplicationSessionPair {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

type IdentityConfig = Pick<
  ApiConfig,
  | "wechatAppId"
  | "identityLookupKey"
  | "identityEncryptionKey"
  | "accessTokenLifetimeMilliseconds"
>;

type TokenIssuer = () => IssuedToken;
type IdGenerator = () => string;

export class IdentityService {
  public constructor(
    private readonly repository: IdentityRepository,
    private readonly config: IdentityConfig,
    private readonly clock: Clock = systemClock,
    private readonly tokenIssuer: TokenIssuer = issueToken,
    private readonly idGenerator: IdGenerator = randomUUID
  ) {}

  public async login(input: VerifiedWechatLoginInput): Promise<ApplicationSessionPair> {
    const now = this.clock.now();
    const identity = protectOpenId(
      input.openId,
      this.config.identityLookupKey,
      this.config.identityEncryptionKey
    );
    const pair = this.buildSessionPair(now);
    const deviceIdHash = digestToken(input.deviceId);

    await this.repository.transaction(async (tx) => {
      const user = await tx.findOrCreateUser({
        appId: this.config.wechatAppId,
        lookupHash: identity.lookupHash,
        ciphertext: identity.ciphertext,
        createdAt: now
      });
      if (user.status !== "ACTIVE") {
        throw new Error("USER_DELETING");
      }

      await tx.recordConsent({
        id: this.idGenerator(),
        userId: user.id,
        consentType: "METADATA_REMOVAL",
        policyVersion: input.consent.policyVersion,
        granted: input.consent.metadataRemoval,
        grantedAt: now,
        revokedAt: input.consent.metadataRemoval ? null : now
      });
      await tx.revokeSessionsForDevice(user.id, deviceIdHash, now);
      await tx.revokeSessionsBeyondLimit(user.id, 4, now);
      await tx.insertSession(this.toStoredSession(pair, user.id, deviceIdHash, now));
    });

    return pair.output;
  }

  public async refresh(input: RefreshInput): Promise<ApplicationSessionPair> {
    const parsed = RefreshInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("INVALID_REFRESH_INPUT");
    }
    const refreshToken = parsed.data.refreshToken;
    const suppliedDeviceHash = digestToken(parsed.data.deviceId);
    const refreshTokenHash = digestToken(refreshToken);
    const now = this.clock.now();

    return this.repository.transaction(async (tx) => {
      const current = await tx.findSessionByRefreshHashForUpdate(refreshTokenHash);
      this.requireUsableSession(current, now, "refresh");
      if (
        !timingSafeEqual(current.deviceIdHash, suppliedDeviceHash)
      ) {
        throw new Error("SESSION_REVOKED");
      }

      const replacement = this.buildSessionPair(now, current.refreshExpiresAt);
      await tx.revokeSession(current.id, now);
      await tx.insertSession(
        this.toStoredSession(
          replacement,
          current.userId,
          current.deviceIdHash,
          now
        )
      );
      return replacement.output;
    });
  }

  public async logoutCurrent(accessToken: string): Promise<void> {
    const accessTokenHash = digestToken(accessToken);
    const now = this.clock.now();

    await this.repository.transaction(async (tx) => {
      const session = await tx.findSessionByAccessHashForUpdate(accessTokenHash);
      this.requireUsableSession(session, now, "access");
      await tx.revokeSession(session.id, now);
    });
  }

  public async logoutAll(accessToken: string): Promise<void> {
    const accessTokenHash = digestToken(accessToken);
    const now = this.clock.now();

    await this.repository.transaction(async (tx) => {
      const session = await tx.findSessionByAccessHashForUpdate(accessTokenHash);
      this.requireUsableSession(session, now, "access");
      await tx.revokeAllSessions(session.userId, now);
    });
  }

  public async requestDeletion(accessToken: string): Promise<void> {
    const accessTokenHash = digestToken(accessToken);
    const now = this.clock.now();

    await this.repository.transaction(async (tx) => {
      const session = await tx.findSessionByAccessHashForUpdate(accessTokenHash);
      this.requireUsableSession(session, now, "access");
      await tx.markUserDeleting(session.userId, now);
      await tx.revokeAllSessions(session.userId, now);
    });
  }

  private buildSessionPair(now: Date, refreshExpiresAt?: Date): {
    access: IssuedToken;
    refresh: IssuedToken;
    output: ApplicationSessionPair;
  } {
    const access = this.tokenIssuer();
    const refresh = this.tokenIssuer();
    return {
      access,
      refresh,
      output: {
        accessToken: access.raw,
        accessExpiresAt: new Date(
          now.getTime() + this.config.accessTokenLifetimeMilliseconds
        ),
        refreshToken: refresh.raw,
        refreshExpiresAt: refreshExpiresAt
          ? new Date(refreshExpiresAt)
          : new Date(now.getTime() + refreshLifetimeMilliseconds)
      }
    };
  }

  private toStoredSession(
    pair: {
      access: IssuedToken;
      refresh: IssuedToken;
      output: ApplicationSessionPair;
    },
    userId: string,
    deviceIdHash: Buffer,
    now: Date
  ): StoredSession {
    return {
      id: this.idGenerator(),
      userId,
      deviceIdHash: Buffer.from(deviceIdHash),
      accessTokenHash: Buffer.from(pair.access.digest),
      accessExpiresAt: new Date(pair.output.accessExpiresAt),
      refreshTokenHash: Buffer.from(pair.refresh.digest),
      refreshExpiresAt: new Date(pair.output.refreshExpiresAt),
      lastUsedAt: new Date(now),
      revokedAt: null
    };
  }

  private requireUsableSession(
    session: StoredSession | undefined,
    now: Date,
    tokenKind: "access" | "refresh"
  ): asserts session is StoredSession {
    if (!session || session.revokedAt !== null) {
      throw new Error("SESSION_REVOKED");
    }
    const expiresAt = tokenKind === "access"
      ? session.accessExpiresAt
      : session.refreshExpiresAt;
    if (expiresAt.getTime() <= now.getTime()) {
      throw new Error("SESSION_EXPIRED");
    }
  }
}
