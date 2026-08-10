import { ports } from "shared";

const baseUrl = `http://localhost:${ports.consumer}`;
const providerUrl = `http://localhost:${ports.provider}`;

export const config = Object.freeze({
  port: ports.consumer,
  baseUrl,
  resource: `${baseUrl}/api/`,
  prmUrl: `${baseUrl}/.well-known/oauth-protected-resource`,
  /**
   * Trusted issuer list for ID-JAGs (the `identity_assertion` type). Empty
   * today: Cloudinary does not yet accept provider-minted ID-JAGs, so there
   * are no trusted agent providers to list. This is the (future) inbound-
   * federation trust list — each entry would carry a service-controlled
   * `displayName` rendered on the step-up confirmation page, typically
   * sourced from CIMD (Client ID Metadata Document, RFC draft).
   */
  trustedIssuers: [] as { iss: string; displayName: string }[],
  /** Cloudinary OAuth scopes: asset management (Admin API) and upload. */
  scopesSupported: ["asset_management", "upload"],
  /**
   * Scope an unclaimed registration's access_token gets before the human
   * claims. Illustrative reduced scope so the anonymous demo track stays
   * runnable; Cloudinary's real claimable-cloud path expresses the pre-claim
   * limit differently — full API capability from the start, with media
   * delivery restricted to declared IPs and lower usage caps. See AUTH.md.
   */
  preClaimScopes: ["upload"],
  postClaimScopes: ["asset_management", "upload"],
  accessTokenTtlSeconds: 3600,
  /**
   * Lifetime of service-signed identity_assertions returned by /agent/identity.
   * Agents re-exchange the assertion at /oauth2/token to refresh access_tokens
   * within this window; when it expires, the agent re-calls /agent/identity.
   */
  serviceAssertionTtlSeconds: 3600,
  anonymousTtlSeconds: 86400,
  /**
   * Maximum age of the upstream user authentication carried in an ID-JAG's
   * auth_time claim. ID-JAGs whose underlying login is older than this are
   * rejected with login_required; the agent should refresh the user's
   * session at its provider and request a fresh ID-JAG.
   */
  idJagMaxAuthAgeSeconds: 3600,
  claimViewTokenTtlSeconds: 600,
  /** Lifetime of the user_code minted at ceremony start (RFC 8628). */
  userCodeTtlSeconds: 600,
  /** Recommended agent poll cadence (RFC 8628 `interval`). */
  pollIntervalSeconds: 5,
  /** Lifetime of the cookie-bound session minted at /login. */
  sessionTtlSeconds: 86400,
  /**
   * Secret for express-session cookie signing. In production this would be
   * a high-entropy value held outside the repo; for the demo we accept a
   * stable default so cookies survive dev-server restarts.
   */
  sessionSecret: process.env.SESSION_SECRET ?? "demo-secret-do-not-ship",
  clockSkewSeconds: 60,
  /** RFC 7523 JWT-bearer grant endpoint. */
  tokenEndpointPath: "/oauth2/token",
  /** RFC 7009 token revocation endpoint. */
  revocationEndpointPath: "/oauth2/revoke",
  /** Agent identity-assertion endpoint (profile extension). */
  identityEndpointPath: "/agent/identity",
  /** Claim ceremony endpoint, nested under identity. */
  claimEndpointPath: "/agent/identity/claim",
  /** RFC 8935 SET receiver path (provider-pushed identity events). */
  eventsEndpointPath: "/agent/event/notify",
  corsOrigins: [providerUrl],
  keyPath: ".keys/signing-key.json",
});
