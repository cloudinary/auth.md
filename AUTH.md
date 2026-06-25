# auth.md — Cloudinary

You are an agent. Cloudinary supports **agentic registration** — discover → register → (claim if needed) → use the API → handle revocation. This document tells you how to authenticate with Cloudinary on behalf of a user, whether or not that user already has a Cloudinary account.

Cloudinary exposes **two** registration paths. Pick one with this decision tree:

1. **The user already has (or will sign in to) a Cloudinary account** → **[Delegation via OAuth](#path-1--delegation-oauth-via-cloudinarys-mcp-servers)**. The user authenticates and consents in a browser; you receive a scoped, short-lived bearer token. This is the richer path and is what Cloudinary's remote MCP servers use.
2. **The user has no Cloudinary account yet and you only have their email** → **[Provisioning via `service_auth`](#path-2--provisioning-service_auth)**. You create a new account for them; Cloudinary returns credentials that stay **inert** until the human verifies their email (the claim ceremony).

> **Mapping to the reference protocol.** Path 1 is the protocol's interactive delegation, layered on standard OAuth discovery (RFC 9728 / RFC 8414). Path 2 is the protocol's `service_auth` identity type. The protocol's `identity_assertion` (ID-JAG) type is **not supported yet** — see [Future](#future--identity_assertion-id-jag). A "Divergences from the reference protocol" note is at the [end](#divergences-from-the-reference-protocol).

---

## Path 1 — Delegation (OAuth via Cloudinary's MCP servers)

Use this when the agent acts on behalf of a user who has, or will sign in to, a Cloudinary account. The human authenticates Cloudinary-side in a browser and chooses which product environment (cloud) you may act on; you get a scoped bearer token. No API key/secret ever touches the agent.

### Step 1 — Discover

Cloudinary's remote MCP servers are OAuth 2.1 protected resources. Each publishes the standard discovery documents:

| MCP server | Endpoint |
| --- | --- |
| Asset management | `https://asset-management.mcp.cloudinary.com/mcp` |
| Environment config | `https://environment-config.mcp.cloudinary.com/mcp` |
| Structured metadata | `https://structured-metadata.mcp.cloudinary.com/mcp` |
| Analysis | `https://analysis.mcp.cloudinary.com/sse` |

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
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256", "plain"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic", "none"]
}
```

> **Discovery note.** Fetch `/.well-known/oauth-protected-resource` directly at the resource host — it's the standardized well-known location, so it always resolves. Cloudinary's `401`s do not include the optional `WWW-Authenticate: Bearer resource_metadata="…"` pointer; [RFC 9728 §5](https://datatracker.ietf.org/doc/html/rfc9728#section-5) marks that pointer as a *MAY*, and because the documents live at the conventional path, it isn't needed to discover them.

### Step 2 — Register a client (dynamic, optional)

The MCP servers support [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) Dynamic Client Registration at the `registration_endpoint`, so you can self-register without contacting Cloudinary:

```http
POST https://asset-management.mcp.cloudinary.com/register
Content-Type: application/json

{ "client_name": "<your agent>", "redirect_uris": ["<your callback>"], "token_endpoint_auth_method": "none" }
```

Public clients (`token_endpoint_auth_method: "none"`) are accepted — use PKCE.

### Step 3 — Authorize (browser, with consent + cloud selection)

Run a standard [OAuth 2.1 authorization-code flow with PKCE](https://datatracker.ietf.org/doc/html/rfc7636). Request the scopes you need:

- `asset_management` — Admin API (manage assets + account/upload/transform/delivery settings)
- `upload` — Upload API
- plus `openid profile email offline_access` (the last gives you a refresh token)

```http
GET https://asset-management.mcp.cloudinary.com/authorize
  ?response_type=code
  &client_id=<client_id>
  &redirect_uri=<callback>
  &scope=openid%20email%20offline_access%20asset_management%20upload
  &code_challenge=<S256>&code_challenge_method=S256
```

The user signs in to Cloudinary, **consents**, and **selects the product environment (cloud)** the token will act on. The chosen cloud is bound into the token (it is not an OAuth `resource`/audience parameter — Cloudinary carries it in the token's claims).

### Step 4 — Exchange the code for a token

```http
POST https://asset-management.mcp.cloudinary.com/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=<code>&redirect_uri=<callback>
&client_id=<client_id>&code_verifier=<verifier>
```

You receive a JWT **access token** (short-lived) and, with `offline_access`, a **refresh token** (long-lived).

### Step 5 — Use, refresh, revoke

- **Use:** send `Authorization: Bearer <access_token>` to the MCP server (or to the Cloudinary API the token is scoped for).
- **Refresh:** when the access token expires, use the `refresh_token` grant at the `token_endpoint`.
- **Revoke:** the MCP authorization-server metadata does not currently advertise a `revocation_endpoint`. Signing the user out of Cloudinary invalidates the session behind the grant, and access tokens are short-lived so they age out quickly.

---

## Path 2 — Provisioning (`service_auth`)

Use this when the user does **not** have a Cloudinary account and you have their email. You create a new Free-plan account for them. The credentials Cloudinary returns are **inert** until the human verifies the email — that verification is the claim ceremony.

### Step 1 — Register

`POST` the agent account-creation endpoint. **No authentication is required** to call it.

```http
POST https://api.cloudinary.com/v1_1/provisioning/agents/accounts
Content-Type: application/json

{
  "email": "user@example.com",
  "agent_framework": "<framework, e.g. langchain>",
  "agent_llm_model": "<model & version>",
  "agent_goal": "<why the account is being created>",
  "sdk_framework": "<optional, e.g. node>"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `email` | yes | The human you're acting for. Account, derived account name, and verification target. |
| `agent_framework` | yes | 2–100 chars. |
| `agent_llm_model` | yes | 2–100 chars. |
| `agent_goal` | yes | 2–300 chars. |
| `sdk_framework` | no | 2–100 chars; tailors the `guidance` block. |

Response (`200`):

```json
{
  "external_id": "<account external id>",
  "email": "user@example.com",
  "plan_name": "Free",
  "product_environments": [
    {
      "external_id": "<env external id>",
      "cloud_name": "<cloud>",
      "api_key": "<api key>",
      "api_secret": "<api secret>",
      "api_environment_variable": "CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud>"
    }
  ],
  "guidance": "<human/agent-readable next steps>"
}
```

These are the product environment's **root** `api_key` / `api_secret`. **They do not work yet** — the environment is created disabled. Hold them; surface the `guidance` to the user.

### Step 2 — Claim ceremony (email verification)

Cloudinary emails the human a verification link. Direct the user to:

1. Open the email Cloudinary sent to the address you supplied.
2. Click the verification link, **set a password**, and confirm.

That completes the claim: Cloudinary marks the email verified and **activates** the product environment, flipping the returned credentials from inert to live. The link expires in ~24 hours.

> There is **no agent-pollable completion signal** for this step. Cloudinary does not return a `user_code`, a `verification_uri` you poll, or a status endpoint. Instead, **retry a real API call** (Step 3) until it succeeds — that's how you learn activation completed. Back off between attempts.

### Step 3 — Use the credentials

Once active, authenticate with the root key/secret (HTTP Basic, or the `CLOUDINARY_URL` / SDK config):

```http
POST https://api.cloudinary.com/v1_1/<cloud_name>/image/upload      # Upload API
GET  https://api.cloudinary.com/v1_1/<cloud_name>/resources/image   # Admin API
Authorization: Basic base64(<api_key>:<api_secret>)
```

Or configure an SDK directly from `api_environment_variable`. Full API reference: <https://cloudinary.com/documentation>.

### Step 4 — Revoke

There is no token to revoke on this path. To cut off access, the human rotates the API key/secret or disables the product environment in the Cloudinary Console.

### Errors (provisioning)

All errors use Cloudinary's standard envelope:

```json
{ "error": { "category": "...", "code": "...", "message": "...", "details": {} } }
```

| Status | `code` | What to do |
| --- | --- | --- |
| 400 | *(validation message)* | Missing/oversized `email` or agent metadata, or invalid UTF-8. Fix the body. |
| 403 | `agent_registration_disabled` | Agent signup is temporarily off. Do not retry tightly; fall back to asking the human to sign up. |
| 403 | `geo_location_not_permitted` | Requests from your region are not allowed. |
| 403 | *(none — "Invalid request")* | Request blocked (e.g. IP gating). Do not probe. |
| 429 | `ip_rate_limit_exceeded` | Per-IP signup cap (default 10/day). Back off and retry later. |
| 5xx | *(generic)* | Transient server error. Exponential backoff, then retry. |

---

## Future — `identity_assertion` (ID-JAG)

The reference protocol's third type, `identity_assertion` ([ID-JAG](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-identity-assertion-authz-grant)), lets a **trusted agent provider** mint a signed assertion of the user's identity so the agent can register **headlessly** (no browser) on behalf of an already-authenticated user. Cloudinary does **not** accept ID-JAGs today — there is no provider trust list and no inbound assertion-verification surface. Until it ships, use Path 1 (interactive OAuth) for delegation, or Path 2 (`service_auth`) when there's no account yet.

An open design question specific to this headless path: a Cloudinary account can have multiple **product environments (clouds)**, and a credential acts on exactly one. The interactive OAuth path (Path 1) resolves this at the consent screen, where the user picks a cloud; a browserless ID-JAG flow has no such step, so it would need a policy for selecting the product environment (e.g. a default cloud, the user's sole cloud, or an explicit selection step). This does not affect Path 1 or Path 2.

---

## Divergences from the reference protocol

Cloudinary follows the protocol's shape but differs in mechanics on the provisioning path — called out so you don't expect protocol-exact behavior:

1. **Credential type.** Path 2 returns an **API key/secret** (HTTP Basic), not a bearer token. (Path 1 is bearer-token, as the protocol expects.)
2. **Claim mechanism.** The claim ceremony is an **email-verification link**, not the device-style `user_code` + `verification_uri` + poll grant.
3. **Credential timing.** Provisioning credentials are **returned immediately but inert**, then activated by verification — the protocol's `service_auth` withholds the credential until the ceremony completes. Same security property (nothing works until the human verifies), different timing.
4. **No completion signal.** There's no poll endpoint for the claim; you retry the API to detect activation.
