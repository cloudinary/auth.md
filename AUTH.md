# auth.md — Cloudinary

You are an agent. Cloudinary supports **agentic registration** — discover → register → (claim if needed) → use the API → handle revocation. This document tells you how to authenticate with Cloudinary on behalf of a user, whether or not that user already has a Cloudinary account.

Cloudinary exposes **two** registration paths. Pick one with this decision tree:

1. **The user already has (or will sign in to) a Cloudinary account** → **[Delegation via OAuth](#path-1--delegation-oauth-via-cloudinarys-mcp-servers)**. The user authenticates and consents in a browser; you receive a scoped, short-lived bearer token. This is the richer path and is what Cloudinary's remote MCP servers use.
2. **The user has no Cloudinary account yet and you only have their email** → **[Provisioning via `service_auth`](#path-2--provisioning-service_auth)**. You create a new account for them; Cloudinary returns credentials that stay **inert** until the human verifies their email (the claim ceremony). If that email already belongs to a Cloudinary account, provisioning is rejected — switch to Path 1.

> **Mapping to the reference protocol.** Path 1 is the protocol's interactive delegation, layered on standard OAuth discovery (RFC 9728 / RFC 8414). Path 2 is the protocol's `service_auth` identity type. The protocol's `identity_assertion` (ID-JAG) type is **not supported yet** — see [Future](#future--identity_assertion-id-jag). A "Divergences from the reference protocol" note is at the [end](#divergences-from-the-reference-protocol).

---

## Path 1 — Delegation (OAuth via Cloudinary's MCP servers)

Use this when the agent acts on behalf of a user who has, or will sign in to, a Cloudinary account. The human authenticates Cloudinary-side in a browser and chooses which product environment (cloud) you may act on; you get a scoped bearer token. No API key/secret ever touches the agent.

This path is **interactive**: it requires the user to complete a browser sign-in and consent (an OAuth redirect). There is no fully headless delegation for existing accounts yet — that's the future [ID-JAG](#future--identity_assertion-id-jag) path.

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

## Path 2 — Provisioning (`service_auth`)

Use this when the user does **not** have a Cloudinary account and you have their email. This path **bootstraps and claims an account**; it does not, by itself, have to be how you make API calls. **Once the human has completed the claim (Step 2)** — and not before — the recommended way to act on the account is **[Path 1](#path-1--delegation-oauth-via-cloudinarys-mcp-servers)** (OAuth delegation): short-lived, scoped tokens, with no root secret ever held by the agent. Until the claim completes there is no Cloudinary login to delegate, so Path 1 is not available; the root credentials provisioning returns are a documented fallback, not the default.

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

These are the product environment's **root** `api_key` / `api_secret`. **They do not work yet** — the environment is created disabled. You generally do **not** need to store them: prefer the OAuth hand-off in Step 3. If you do retain them for the fallback path, treat `api_secret` as a full-access root secret — never log it or expose it in client-side code, and persist it securely. Surface the `guidance` to the user either way.

### Step 2 — Claim ceremony (email verification)

Cloudinary emails the human a verification link. Direct the user to:

1. Open the email Cloudinary sent to the address you supplied.
2. Click the verification link, **set a password**, and confirm.

That completes the claim: Cloudinary marks the email verified and **activates** the product environment. After this, the human has a normal Cloudinary account with a password — which is exactly what Path 1 (delegation) needs. The link expires in ~24 hours.

### Step 3 — Get API access

**Preferred — switch to delegation (Path 1).** This becomes available **only after the claim in Step 2 is complete** — the user has verified their email and set a password, which is the login Path 1 delegates against. There is no OAuth login to perform before that point. Once claimed, run the [Path 1](#path-1--delegation-oauth-via-cloudinarys-mcp-servers) authorization-code + PKCE flow; the user signs in with the password they just set and selects the product environment. You receive a scoped, short-lived bearer token and never handle the root secret. It is interactive (browser), but the user is already in a browser from the claim ceremony, so the sign-in folds naturally into the same session.

**Fallback — use the returned root credentials directly.** Use this when no browser is available for OAuth (e.g. a fully headless agent), or when you need direct REST API access beyond what the MCP servers expose — Path 1 tokens are MCP-only (see [Path 1, Step 5](#step-5--use-refresh-revoke)), so the root key/secret are the only way to call Cloudinary's REST APIs directly. Once the environment is active, authenticate with the root key/secret (HTTP Basic, or the `CLOUDINARY_URL` / SDK config):

```http
POST https://api.cloudinary.com/v1_1/<cloud_name>/image/upload      # Upload API
GET  https://api.cloudinary.com/v1_1/<cloud_name>/resources/image   # Admin API
Authorization: Basic base64(<api_key>:<api_secret>)
```

Or configure an SDK directly from `api_environment_variable`. This is less safe than delegation: the root key/secret are **full-access** and long-lived, so the leak blast radius is the entire product environment. Prefer Path 1 whenever a browser is reachable. Full API reference: <https://cloudinary.com/documentation>.

> **Detecting activation (fallback path only).** There is **no agent-pollable completion signal** for the claim — Cloudinary returns no `user_code`, `verification_uri` to poll, or status endpoint. To learn that activation completed, **retry a real API call** until it succeeds, backing off between attempts. (On the preferred path, the user completing OAuth sign-in is itself the signal.)

### Step 4 — Revoke

- If you took the **Path 1** hand-off, revoke per [Path 1, Step 5](#step-5--use-refresh-revoke) (sign the user out; tokens are short-lived).
- If you used the **root credentials** directly, there is no token to revoke — the human rotates the API key/secret or disables the product environment in the Cloudinary Console.

### Errors (provisioning)

All errors use Cloudinary's standard envelope. `category` and `message` are always present; `code` and `details` are **optional** and appear only on some errors — the validation and duplicate-email `400`s below carry just `category` + `message`:

```json
{ "error": { "category": "...", "message": "...", "code": "<optional>", "details": { } } }
```

To detect the duplicate-email case (so you know to switch to Path 1), match on `400` whose `message` reports the email is already taken — observed as the string `{"email":["has already been taken"]}` — rather than a literal "already registered".

| Status | `code` | What to do |
| --- | --- | --- |
| 400 | *(validation message)* | Missing/oversized `email` or agent metadata, or invalid UTF-8. Fix the body. |
| 400 | *(email already registered)* | The email already has a Cloudinary account — don't retry provisioning; use **Path 1** (delegation) instead. |
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
