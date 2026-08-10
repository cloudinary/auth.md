# auth.md — Cloudinary

You are an agent. Cloudinary supports **agentic registration** — discover → register → (claim if needed) → use the API → handle revocation. This document tells you how to authenticate with Cloudinary on behalf of a user, whether or not that user already has a Cloudinary account.

Cloudinary exposes **two** registration paths. Pick one with this decision tree:

1. **The user already has (or will sign in to) a Cloudinary account** → **[Delegation via OAuth](#path-1--delegation-oauth-via-cloudinarys-mcp-servers)**. The user authenticates and consents in a browser; you receive a scoped, short-lived bearer token. This is the richer path and is what Cloudinary's remote MCP servers use.
2. **The user has no Cloudinary account yet, or you don't know whether they do** → **[Provisioning a claimable cloud](#path-2--provisioning-a-claimable-cloud)**. One unauthenticated call returns credentials that work immediately, for a temporary cloud. The human **claims** it within 24 hours to convert it into a permanent free account; their email is optional up front.

> **Mapping to the reference protocol.** Path 1 is the protocol's interactive delegation, layered on standard OAuth discovery (RFC 9728 / RFC 8414). Path 2 is the protocol's `anonymous` identity type — you register with no user identity, operate under a restricted capability, and defer the claim ceremony until the user wants ownership. The protocol's third type, `identity_assertion` (ID-JAG) — a trusted provider minting a signed identity assertion so an agent can register headlessly — is **not supported**: Cloudinary has no inbound assertion-verification surface. A "Divergences from the reference protocol" note is at the [end](#divergences-from-the-reference-protocol).

---

## Path 1 — Delegation (OAuth via Cloudinary's MCP servers)

Use this when the agent acts on behalf of a user who has, or will sign in to, a Cloudinary account. The human authenticates Cloudinary-side in a browser and chooses which product environment (cloud) you may act on; you get a scoped bearer token. No API key/secret ever touches the agent.

This path is **interactive**: it requires the user to complete a browser sign-in and consent (an OAuth redirect). There is no fully headless delegation for existing accounts — that would require the protocol's `identity_assertion` (ID-JAG) type, which Cloudinary does not support.

> **If you use an MCP-capable client** (an SDK or host like Claude or Cursor), point it at one of the server URLs below and it runs Steps 1–4 for you — discovery, client registration, the authorization-code + PKCE flow, and token exchange. The manual flow documented here is for agents that implement OAuth directly.

### Step 1 — Discover

Cloudinary's remote MCP servers are OAuth 2.1 protected resources. Each publishes the standard discovery documents:

| MCP server | Endpoint |
| --- | --- |
| Asset management | `https://asset-management.mcp.cloudinary.com/mcp` |
| Environment config | `https://environment-config.mcp.cloudinary.com/mcp` |
| Structured metadata | `https://structured-metadata.mcp.cloudinary.com/mcp` |
| Analysis | `https://analysis.mcp.cloudinary.com/sse` |

Each server advertises **its own** scopes — always read the PRM of the one you're targeting. The example below is `asset-management` (`asset_management` / `upload`); the **Analysis** server uses the `/sse` transport and different scopes (`media_analysis`, `query_analysis_tasks`).

Two-hop discovery (per [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) → [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414)):

```http
GET https://asset-management.mcp.cloudinary.com/.well-known/oauth-protected-resource
```

```json
{
  "resource": "https://asset-management.mcp.cloudinary.com",
  "authorization_servers": ["https://asset-management.mcp.cloudinary.com"],
  "scopes_supported": ["openid", "profile", "email", "offline_access", "asset_management", "upload"],
  "bearer_methods_supported": ["header"],
  "resource_documentation": "https://asset-management.mcp.cloudinary.com/docs"
}
```

Then fetch the Authorization Server metadata from `authorization_servers[0]`:

```http
GET https://asset-management.mcp.cloudinary.com/.well-known/oauth-authorization-server
```

```json
{
  "issuer": "https://asset-management.mcp.cloudinary.com",
  "authorization_endpoint": "https://asset-management.mcp.cloudinary.com/authorize",
  "token_endpoint": "https://asset-management.mcp.cloudinary.com/token",
  "registration_endpoint": "https://asset-management.mcp.cloudinary.com/register",
  "userinfo_endpoint": "https://asset-management.mcp.cloudinary.com/userinfo",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256", "plain"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic", "none"]
}
```

> **Discovery note.** Fetch `/.well-known/oauth-protected-resource` directly at the resource host — it's the standardized well-known location, so it always resolves. Cloudinary's `401`s also return the [RFC 9728 §5](https://datatracker.ietf.org/doc/html/rfc9728#section-5) `WWW-Authenticate: Bearer resource_metadata="…"` pointer to that same document, so you can discover it from a challenge response too.

### Step 2 — Register a client (dynamic, optional)

The MCP servers support [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) Dynamic Client Registration at the `registration_endpoint`, so you can self-register without contacting Cloudinary:

```http
POST https://asset-management.mcp.cloudinary.com/register
Content-Type: application/json

{ "client_name": "<your agent>", "redirect_uris": ["<your callback>"], "token_endpoint_auth_method": "none" }
```

Public clients (`token_endpoint_auth_method: "none"`) are accepted — use PKCE.

### Step 3 — Authorize (browser, with consent + cloud selection)

Run a standard [OAuth 2.1 authorization-code flow with PKCE](https://datatracker.ietf.org/doc/html/rfc7636). Request the scopes you need — each authorizes a set of MCP tools, not direct REST access (see [Step 5](#step-5--use-refresh-revoke)):

- `asset_management` — Admin-API capabilities (manage assets + account/upload/transform/delivery settings)
- `upload` — Upload-API capabilities (upload assets)
- plus `openid profile email offline_access` (the last gives you a refresh token)

```http
GET https://asset-management.mcp.cloudinary.com/authorize
  ?response_type=code
  &client_id=<client_id>
  &redirect_uri=<callback>
  &scope=openid%20profile%20email%20offline_access%20asset_management%20upload
  &code_challenge=<S256>&code_challenge_method=S256
```

The user signs in to Cloudinary, **consents**, and **selects the product environment (cloud)** the token will act on.

### Step 4 — Exchange the code for a token

```http
POST https://asset-management.mcp.cloudinary.com/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=<code>&redirect_uri=<callback>
&client_id=<client_id>&code_verifier=<verifier>
```

You receive a JWT **access token** (short-lived) and, with `offline_access`, a **refresh token** (long-lived).

### Step 5 — Use, refresh, revoke

- **Use:** present `Authorization: Bearer <access_token>` to the MCP server you obtained it from. This is an **MCP access token** — it authenticates calls to Cloudinary's MCP servers only; you **cannot** use it directly against Cloudinary's REST APIs (`https://api.cloudinary.com/…`). The MCP server already operates in the cloud the user selected at consent, so you don't need `<cloud_name>` yourself.
- **Refresh:** when the access token expires, use the `refresh_token` grant at the `token_endpoint`.
- **Revoke:** the MCP authorization-server metadata does not currently advertise a `revocation_endpoint`. Signing the user out of Cloudinary invalidates the session behind the grant, and access tokens are short-lived so they age out quickly.

---

## Path 2 — Provisioning a claimable cloud

Use this when the user has no Cloudinary account, or when you don't know whether they do and want to start working now. One unauthenticated call provisions a **claimable cloud**: a temporary product environment whose credentials work immediately. The human **claims** it within 24 hours to convert it into a permanent free account. If nobody claims it, Cloudinary deletes the cloud and everything in it.

Unlike Path 1, nothing here is interactive up front — no signup, no browser, no existing credentials. The trade is that you hold the environment's root secret, and delivery is restricted until the claim completes (Step 2).

> **Shortcut.** If you can run shell commands, `npx @cloudinary/cloud` does Step 1 for you — it provisions the cloud, writes the credentials to `.env`, and prints the claim URL. The HTTP flow below is for agents calling the API directly.

### Step 1 — Provision

**No authentication is required** to call this endpoint.

```http
POST https://api.cloudinary.com/v1_1/provisioning/clouds
Content-Type: application/json

{
  "delivery_ips": ["requester_ip"],
  "email": "user@example.com"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `delivery_ips` | yes | One to three **public** IP addresses (IPv4 or IPv6) allowed to fetch delivered media while the cloud is unclaimed. Pass the literal string `"requester_ip"` to use the calling machine's public IP — the right choice when the agent runs on the same machine where the media will be viewed. CIDR ranges and private/LAN addresses are rejected. |
| `email` | no | Pre-fills the claim page. The human confirms or changes it at claim time, so this is a convenience, not a binding — supplying it does not reserve the account or make the claim automatic. |

Response (`200`):

```json
{
  "id": "0aaaaa1bbbbb2ccccc3ddddd4eeeee5f",
  "email": "user@example.com",
  "expires_at": "2026-07-22T09:30:00Z",
  "delivery_ips": ["203.0.113.7"],
  "product_environments": [
    {
      "external_id": "1a2b3c4d5e6f7a8b9c0d1e2f3a4b",
      "cloud_name": "my-cloud",
      "api_key": "123456789012345",
      "api_secret": "ABCdef1234567890ghijklMNOpqr",
      "api_environment_variable": "CLOUDINARY_URL=cloudinary://123456789012345:ABCdef1234567890ghijklMNOpqr@my-cloud"
    }
  ],
  "claim_url": "https://console.cloudinary.com/users/agent_email_confirmation?token=abc123",
  "guidance": "<agent-readable next steps>"
}
```

Three fields matter beyond the credentials:

- `claim_url` — the ceremony handle, carrying a bearer token in the query string. Anyone with this URL can claim the cloud, so treat it as a secret: hand it to your user, don't log it or post it anywhere shared. It is not re-issuable, so keep it for as long as the cloud is unclaimed.
- `expires_at` — the end of the claim window (24 hours from provisioning). A hard deadline, not a soft one (see [Step 3](#step-3--claim-ceremony-deferred)).
- `guidance` — agent-readable next steps. Surface it to the user.

`api_key` / `api_secret` are the product environment's **root** credentials. Treat `api_secret` as full-access: never log it or expose it in client-side code, and persist it securely.

### Step 2 — Use the credentials

The credentials work right away — there is nothing to activate and nothing to wait for. Authenticate with HTTP Basic, or configure an SDK from `api_environment_variable`:

```http
POST https://api.cloudinary.com/v1_1/<cloud_name>/image/upload      # Upload API
GET  https://api.cloudinary.com/v1_1/<cloud_name>/resources/image   # Admin API
Authorization: Basic base64(<api_key>:<api_secret>)
```

Two limits apply while the cloud is unclaimed:

- **Delivery is IP-locked.** Only the `delivery_ips` you declared can fetch delivered media. Uploads, transformations, and API calls are unrestricted; only delivery of the resulting media is. So a delivery URL that renders on your machine will fail for anyone else — don't share delivery URLs pre-claim, and don't read a failure elsewhere as a broken asset or a bad transformation.
- **Usage caps are lower** than a regular free account. Claiming lifts them to the free plan's normal limits.

This is where the protocol's pre-claim restriction lands: Cloudinary expresses it as delivery egress plus quota rather than as reduced `pre_claim_scopes`, so your API capability is full from the start but your reach is not.

Full API reference: <https://cloudinary.com/documentation>.

### Step 3 — Claim ceremony (deferred)

The claim converts the temporary cloud into a permanent free account owned by the human. Surface `claim_url` to the user. Suggested copy:

> Open this link to keep the cloud I set up — it expires in 24 hours, and everything in it is deleted if it isn't claimed:
> https://console.cloudinary.com/users/agent_email_confirmation?token=…

At that URL the user will:

1. Enter their email address (pre-filled if you supplied one at provisioning).
2. Review the privacy policy and terms of service.
3. Optionally set a password for signing in to the Console.
4. Confirm from the verification email Cloudinary sends.

On success, nothing you stored breaks: `cloud_name`, `api_key`, and `api_secret` stay the same. The delivery IP restriction is removed, delivery works globally, and the free plan's regular limits apply.

**Surface the claim URL early — don't sit on it.** There is no extension and no grace period: at `expires_at` an unclaimed cloud and all of its content are deleted. Treat a long-running job on an unclaimed cloud as work you may lose.

> **No completion signal.** Cloudinary exposes no status endpoint for a claimable cloud and no `user_code` + poll grant, so you cannot ask whether the claim landed. Either ask the user, or infer it by attempting a delivery from outside your declared `delivery_ips` — it starts succeeding once the cloud is claimed. Don't busy-poll delivery to find out.

### Step 4 — After the claim: consider delegation (optional)

Claiming gives the human a Console login, which is exactly what [Path 1](#path-1--delegation-oauth-via-cloudinarys-mcp-servers) delegates against — so OAuth becomes available to you only after Step 3, never before.

Switching is worth it for long-lived work: Path 1 gives you short-lived, scoped tokens and no root secret. Note the asymmetry before you commit — Path 1 tokens are **MCP-only** (see [Path 1, Step 5](#step-5--use-refresh-revoke)), so if you need direct REST access, the root key/secret remain the only way to get it.

Whichever you choose, be explicit with the user about what you keep. The claim does not rotate the credentials, so an agent that provisioned the cloud still holds root access to what is now the user's permanent account. If they don't want that, they rotate the API key/secret in the Console.

### Step 5 — Revoke

- **Unclaimed** — let it lapse. Expiry deletes the cloud outright, so simply not claiming is the teardown.
- **Claimed, root credentials** — no token to revoke; the human rotates the API key/secret or disables the product environment in the Cloudinary Console.
- **Claimed, delegated via Path 1** — revoke per [Path 1, Step 5](#step-5--use-refresh-revoke) (sign the user out; tokens are short-lived).

### Errors (provisioning)

Failures return an HTTP status and, for most cases, a machine-readable `code` — match on the `code` where one is listed below, since messages may be reworded.

| Status | `code` | What to do |
| --- | --- | --- |
| 400 | `delivery_ips_required` | You omitted `delivery_ips`. Send one to three public IPs, or `"requester_ip"`. |
| 400 | `delivery_ips_too_many` | More than three supplied. Send at most three. |
| 400 | `delivery_ips_invalid` | Not a valid IPv4/IPv6 address — CIDR ranges are rejected, so expand or pick a single address. |
| 400 | `delivery_ips_not_public` | A private/LAN address was supplied. Use a routable public IP, or `"requester_ip"` to let Cloudinary resolve it. |
| 403 | `agent_registration_disabled` | Provisioning is temporarily off. Do not retry tightly; fall back to asking the human to sign up. |
| 403 | `geo_location_not_permitted` | Requests from your region are not allowed. |
| 403 | *(none)* | Blocked by abuse controls. Do not probe. |
| 429 | `ip_rate_limit_exceeded` | Per-IP cap reached. Back off and retry later. |
| 429 | `global_rate_limit_exceeded` | Cloudinary-wide cap reached. Back off and retry later; this one is not about you. |
| 5xx | *(generic)* | Transient server error. Exponential backoff, then retry. |

---

## Divergences from the reference protocol

Cloudinary follows the protocol's shape but differs in mechanics on the provisioning path — called out so you don't expect protocol-exact behavior:

1. **Credential type.** Path 2 returns an **API key/secret** (HTTP Basic), not a bearer token. (Path 1 is bearer-token, as the protocol expects.)
2. **Pre-claim restriction.** The protocol limits an unclaimed agent with reduced `pre_claim_scopes`. Cloudinary instead grants **full API capability** and restricts **media delivery** to the IPs you declared, plus lower usage caps. Practical consequence: you have to decide your delivery topology at provisioning time, before you know where the media will be viewed.
3. **Claim mechanism.** The ceremony is a **claim URL plus email verification**, not the device-style `user_code` + `verification_uri` + poll grant. No code travels agent → user, so the URL itself is the entire binding — whoever holds it can claim the cloud.
4. **No completion signal.** There's no poll grant and no status endpoint; you ask the user, or infer the claim from delivery starting to work outside your declared IPs.
5. **Hard expiry.** In the protocol an unclaimed registration merely stops being upgradeable. Here the cloud **and all of its content are deleted** 24 hours after provisioning. Unclaimed is not a state you can park in.
