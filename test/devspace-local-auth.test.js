import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DevSpaceLocalOAuth } from "../src/devspace-local-auth.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test("local DevSpace OAuth uses PKCE and keeps authorization local", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codassol-oauth-"));
  const ownerTokenPath = path.join(directory, "auth.json");
  await writeFile(ownerTokenPath, JSON.stringify({ ownerToken: "owner-secret" }));

  let baseUrl;
  let authorizationSawOwnerToken = false;
  let tokenExchangeSawVerifier = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ resource: `${baseUrl}/mcp` }));
      return;
    }
    if (url.pathname === "/register") {
      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        client_id: "client-1",
        token_endpoint_auth_method: "none"
      }));
      return;
    }
    if (url.pathname === "/authorize") {
      const body = new URLSearchParams(await readBody(req));
      authorizationSawOwnerToken = body.get("owner_token") === "owner-secret";
      if (
        !body.get("client_id") ||
        !body.get("redirect_uri") ||
        body.get("response_type") !== "code" ||
        body.get("code_challenge_method") !== "S256" ||
        !body.get("code_challenge") ||
        !body.get("resource")
      ) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "invalid_request" }));
        return;
      }
      const redirect = new URL(body.get("redirect_uri"));
      redirect.searchParams.set("code", "code-1");
      redirect.searchParams.set("state", body.get("state"));
      res.statusCode = 302;
      res.setHeader("location", redirect.href);
      res.end();
      return;
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(await readBody(req));
      tokenExchangeSawVerifier = Boolean(body.get("code_verifier"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        access_token: "access-1",
        refresh_token: "refresh-1",
        token_type: "bearer",
        expires_in: 3600
      }));
      return;
    }
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== "Bearer access-1") {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const port = await listen(server);
  baseUrl = `http://127.0.0.1:${port}`;
  let savedState = {};
  try {
    const oauth = new DevSpaceLocalOAuth({
      baseUrl,
      ownerTokenPath,
      oauthState: {},
      saveOAuthState: async (state) => {
        savedState = structuredClone(state);
      }
    });
    const response = await oauth.authorizedFetch("/mcp", { method: "GET" });
    assert.equal(response.status, 200);
    assert.equal(authorizationSawOwnerToken, true);
    assert.equal(tokenExchangeSawVerifier, true);
    assert.equal(savedState.refreshToken, "refresh-1");
    assert.equal(savedState.accessToken, "access-1");
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a cancelled OAuth refresh preserves the grant and the next request recovers", async () => {
  const grant = {
    clientId: "test-client", refreshToken: "test-refresh", accessExpiresAt: 0,
    redirectUri: "http://127.0.0.1:17677/callback", resource: "http://127.0.0.1/mcp"
  };
  let saved = structuredClone(grant), fail = true;
  const requests = [];
  const oauth = new DevSpaceLocalOAuth({
    baseUrl: "http://127.0.0.1", oauthState: grant,
    saveOAuthState: async state => { saved = structuredClone(state); },
    fetchFn: async (url, options) => {
      requests.push(url.pathname);
      if (url.pathname === "/token") {
        assert.equal(new URLSearchParams(options.body).get("refresh_token"), "test-refresh");
        if (fail) throw new DOMException("job deadline", "AbortError");
        return Response.json({ access_token: "fresh-access", expires_in: 3600 });
      }
      assert.equal(url.pathname, "/mcp");
      assert.equal(options.headers.get("authorization"), "Bearer fresh-access");
      return Response.json({ ok: true });
    }
  });
  await assert.rejects(oauth.authorizedFetch("/mcp"), { name: "AbortError" });
  assert.deepEqual(saved, grant);
  fail = false;
  assert.equal((await oauth.authorizedFetch("/mcp")).status, 200);
  assert.equal(saved.refreshToken, "test-refresh");
  assert.equal(saved.redirectUri, grant.redirectUri);
  assert.deepEqual(requests, ["/token", "/token", "/mcp"]);
});

test("an explicitly revoked refresh grant reauthorizes with its registered redirect URI", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codassol-oauth-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const ownerTokenPath = path.join(directory, "auth.json");
  await writeFile(ownerTokenPath, JSON.stringify({ ownerToken: "test-owner" }));
  const redirectUri = "http://127.0.0.1:17677/callback";
  let authorizationCount = 0;
  const oauth = new DevSpaceLocalOAuth({
    baseUrl: "http://127.0.0.1", ownerTokenPath,
    oauthState: { clientId: "test-client", redirectUri, refreshToken: "revoked", resource: "http://127.0.0.1/mcp" },
    fetchFn: async (url, options) => {
      const body = new URLSearchParams(options.body);
      if (url.pathname === "/token" && body.get("grant_type") === "refresh_token") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (url.pathname === "/authorize") {
        authorizationCount++;
        assert.equal(body.get("redirect_uri"), redirectUri);
        const redirect = new URL(redirectUri);
        redirect.searchParams.set("state", body.get("state"));
        redirect.searchParams.set("code", "new-code");
        return new Response(null, { status: 302, headers: { location: redirect.href } });
      }
      assert.equal(url.pathname, "/token");
      assert.equal(body.get("redirect_uri"), redirectUri);
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    }
  });
  assert.equal(await oauth.accessToken(), "new-access");
  assert.equal(authorizationCount, 1);
});

