import { Router } from "express";
import { config } from "../config.js";

export const wellKnownRouter = Router();

wellKnownRouter.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    resource: config.resource,
    resource_name: "Cloudinary",
    resource_logo_uri: "https://cloudinary.com/favicon.ico",
    authorization_servers: [config.baseUrl],
    scopes_supported: config.scopesSupported,
    bearer_methods_supported: ["header"],
  });
});

wellKnownRouter.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    resource: config.resource,
    authorization_servers: [config.baseUrl],
    scopes_supported: config.scopesSupported,
    bearer_methods_supported: ["header"],

    issuer: config.baseUrl,
    token_endpoint: `${config.baseUrl}${config.tokenEndpointPath}`,
    revocation_endpoint: `${config.baseUrl}${config.revocationEndpointPath}`,
    grant_types_supported: [
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
      "urn:workos:agent-auth:grant-type:claim",
    ],

    agent_auth: {
      skill: `${config.baseUrl}/auth.md`,
      identity_endpoint: `${config.baseUrl}${config.identityEndpointPath}`,
      claim_endpoint: `${config.baseUrl}${config.claimEndpointPath}`,
      events_endpoint: `${config.baseUrl}${config.eventsEndpointPath}`,
      /*
       * Cloudinary's shipped agent-registration path is service_auth: the
       * agent supplies the user's email, Cloudinary returns inert credentials,
       * and a mandatory email-verification step (the claim ceremony) activates
       * them. The demo also exercises an `anonymous` track, but that's protocol
       * illustration, not part of Cloudinary's surface (account creation always
       * requires an email).
       *
       * `identity_assertion` (ID-JAG) and the provider-pushed revocation SET
       * receiver (`events_supported`) are deliberately NOT advertised: inbound
       * federation isn't built yet (see config.trustedIssuers), so there are no
       * trusted providers to mint assertions or push events.
       */
      identity_types_supported: ["service_auth"],
      events_supported: [],
    },
  });
});
