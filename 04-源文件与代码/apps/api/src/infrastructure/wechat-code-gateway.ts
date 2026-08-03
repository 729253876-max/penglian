type WechatConfig = {
  wechatAppId: string;
  wechatAppSecret: string;
};

export class WechatCodeGateway {
  public constructor(
    private readonly config: WechatConfig,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly timeoutMilliseconds = 5_000
  ) {}

  public async exchange(
    code: string
  ): Promise<{ openId: string; unionId?: string }> {
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.searchParams.set("appid", this.config.wechatAppId);
    url.searchParams.set("secret", this.config.wechatAppSecret);
    url.searchParams.set("js_code", code);
    url.searchParams.set("grant_type", "authorization_code");

    const signal = AbortSignal.timeout(this.timeoutMilliseconds);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        signal
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error("WECHAT_TIMEOUT");
      }
      throw new Error("WECHAT_NETWORK_ERROR");
    }
    if (!response.ok) {
      throw new Error("WECHAT_UNAVAILABLE");
    }

    let body: {
      openid?: unknown;
      unionid?: unknown;
      errcode?: unknown;
    } | null;
    try {
      body = await response.json() as typeof body;
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        throw new Error("WECHAT_TIMEOUT");
      }
      throw new Error("WECHAT_INVALID_RESPONSE");
    }
    if (body === null) {
      throw new Error("WECHAT_INVALID_RESPONSE");
    }
    if (typeof body.errcode === "number" && body.errcode !== 0) {
      throw new Error(mapWechatBusinessError(body.errcode));
    }
    if (typeof body.openid !== "string" || body.openid.length === 0) {
      throw new Error("WECHAT_INVALID_RESPONSE");
    }
    return {
      openId: body.openid,
      ...(typeof body.unionid === "string" && body.unionid.length > 0
        ? { unionId: body.unionid }
        : {})
    };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

function mapWechatBusinessError(errcode: number): string {
  if (errcode === 40029 || errcode === 40163) {
    return "WECHAT_CODE_REJECTED";
  }
  if (errcode === 45011) {
    return "WECHAT_RATE_LIMITED";
  }
  if (errcode === -1) {
    return "WECHAT_UNAVAILABLE";
  }
  return "WECHAT_REQUEST_FAILED";
}
