import { logger } from "../logger.js";
import {
  formatQoderHttpError,
  getMachineId,
  getQoderExchangeURL,
  getQoderJobTokenRefreshURL,
  getQoderUserInfoURL,
  type QoderRoute,
  QoderUserAgent,
} from "./cosy.js";

/** An explicit auth rejection (401 / expired / invalid) that permits PAT recovery. */
export class QoderTokenError extends Error {
  readonly requiresReauthentication: boolean;

  constructor(operation: "exchange" | "refresh", status: number, statusText: string, body: string, url: string) {
    const safeBody = body.replace(/\b(?:pt|jt|jrt)-[A-Za-z0-9._~+/=-]+/g, "[redacted]");
    super(
      operation === "exchange"
        ? formatQoderHttpError("pat-exchange", status, statusText, safeBody, url)
        : `Qoder job token refresh failed: ${status} ${statusText}. Response: ${safeBody.replace(/\s+/g, " ").slice(0, 200)}`,
    );
    this.name = "QoderTokenError";
    this.requiresReauthentication =
      status === 401 ||
      ((status === 400 || status === 403) &&
        /\b(?:ExpiredTokenError|InvalidTokenError|InvalidRefreshTokenError|TOKEN_EXPIRED?)\b/.test(body));
  }
}

export interface PatExchangeResult {
  jobToken: string;
  jobRefreshToken: string;
  expiresAt: number;
}

export interface QoderIdentity {
  userID: string;
  email: string;
  name: string;
}

export interface QoderSession extends QoderIdentity {
  access: string;
  machineID: string;
}

function parseExpiry(data: { expires_at?: string; expires_in?: number }): number {
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (data.expires_in) {
    // expires_in is reported in milliseconds on VPC/CN OpenAPI.
    return Date.now() + data.expires_in;
  }
  return Date.now() + 24 * 60 * 60 * 1000;
}

/** Exchange a PAT (pt-...) for a short-lived job token (jt-...). No COSY required. */
export async function exchangeJobToken(pat: string, route: QoderRoute): Promise<PatExchangeResult> {
  const url = getQoderExchangeURL(route);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": QoderUserAgent,
      "Cosy-Version": "1.0.1",
      "Cosy-ClientType": "5",
    },
    body: JSON.stringify({ personal_token: pat }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new QoderTokenError("exchange", res.status, res.statusText, text, url);
  }

  const data = (await res.json()) as {
    token?: string;
    refresh_token?: string;
    expires_at?: string;
    expires_in?: number;
  };
  if (!data.token) throw new Error("Qoder PAT exchange returned no job token");
  return { jobToken: data.token, jobRefreshToken: data.refresh_token || "", expiresAt: parseExpiry(data) };
}

/** Refresh a job token using the server-issued jrt (rotated on success). */
export async function refreshJobToken(jobRefreshToken: string, route: QoderRoute): Promise<PatExchangeResult> {
  if (!jobRefreshToken?.trim()) throw new Error("Qoder job token refresh requires a non-empty refresh_token (jrt-...)");
  const url = getQoderJobTokenRefreshURL(route);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": QoderUserAgent,
      "Cosy-Version": "1.0.1",
      "Cosy-ClientType": "5",
    },
    body: JSON.stringify({ refresh_token: jobRefreshToken }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new QoderTokenError("refresh", res.status, res.statusText, text, url);
  }

  const data = (await res.json()) as {
    token?: string;
    refresh_token?: string;
    expires_at?: string;
    expires_in?: number;
  };
  if (!data.token) throw new Error("Qoder job token refresh returned no job token");
  return {
    jobToken: data.token,
    jobRefreshToken: data.refresh_token || jobRefreshToken,
    expiresAt: parseExpiry(data),
  };
}

/** Fetch the account identity (userID/email/name) using a job token. */
export async function fetchUserInfo(jobToken: string, route: QoderRoute): Promise<Partial<QoderIdentity>> {
  try {
    const res = await fetch(getQoderUserInfoURL(route), {
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": QoderUserAgent,
        "Cosy-Version": "1.0.1",
        "Cosy-ClientType": "5",
      },
    });
    if (!res.ok) return {};
    const info = (await res.json()) as { id?: string; email?: string; name?: string; username?: string };
    return { userID: info.id || "", email: info.email || "", name: info.name || info.username || "" };
  } catch {
    return {};
  }
}

/**
 * Single-account credential manager for the relay.
 *
 * The upstream PAT is long-lived and always available from configuration, so a
 * rejected jrt is never fatal: the manager falls back to a fresh PAT exchange.
 * Access tokens are cached and refreshed lazily with a 60s safety margin, and
 * concurrent callers share one renewal via a promise lock.
 */
export class QoderAuth {
  private access = "";
  private jobRefreshToken = "";
  private expiresAt = 0;
  private identity: QoderIdentity | undefined;
  private pending: Promise<QoderSession> | undefined;

  constructor(
    private readonly pat: string,
    private readonly route: QoderRoute,
  ) {
    if (!pat.trim()) {
      throw new Error(
        "QODER_PAT is required: set a Qoder Personal Access Token (pt-...) from the integrations page for your region.",
      );
    }
  }

  async getSession(): Promise<QoderSession> {
    if (this.access && this.identity && Date.now() < this.expiresAt - 60_000) {
      return this.snapshot();
    }
    if (!this.pending) {
      this.pending = this.renew().finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  private snapshot(): QoderSession {
    return {
      access: this.access,
      userID: this.identity?.userID || "",
      email: this.identity?.email || "",
      name: this.identity?.name || "",
      machineID: getMachineId(),
    };
  }

  /** Force a fresh access token (used after an upstream 401/403 during chat). */
  async forceRenew(): Promise<QoderSession> {
    this.access = "";
    this.expiresAt = 0;
    return this.getSession();
  }

  private async renew(): Promise<QoderSession> {
    let access = "";
    let expiresAt = 0;

    if (this.jobRefreshToken) {
      try {
        const refreshed = await refreshJobToken(this.jobRefreshToken, this.route);
        access = refreshed.jobToken;
        this.jobRefreshToken = refreshed.jobRefreshToken;
        expiresAt = refreshed.expiresAt;
        logger.debug("job token refreshed");
      } catch (error) {
        if (!(error instanceof QoderTokenError) || !error.requiresReauthentication) throw error;
        logger.debug("job refresh token rejected, re-exchanging PAT");
        this.jobRefreshToken = "";
      }
    }

    if (!access) {
      const exchanged = await exchangeJobToken(this.pat, this.route);
      access = exchanged.jobToken;
      this.jobRefreshToken = exchanged.jobRefreshToken;
      expiresAt = exchanged.expiresAt;
      logger.debug("PAT exchanged for job token");
    }

    if (!this.identity) {
      const info = await fetchUserInfo(access, this.route);
      if (!info.userID) {
        throw new Error(
          "Qoder identity unavailable: /userinfo did not return a userID. Check the PAT validity and, for VPC, QODER_VPC_INSTANCE.",
        );
      }
      this.identity = { userID: info.userID, email: info.email || "", name: info.name || "" };
      logger.info("authenticated with Qoder", { userID: this.identity.userID, mode: this.route.mode });
    }

    this.access = access;
    this.expiresAt = expiresAt;
    return this.snapshot();
  }
}
