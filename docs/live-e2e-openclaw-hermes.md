# Live E2E with OpenClaw and Hermes

Use this runbook for periodic model-driven acceptance. CI remains the release gate. This run adds a real OpenClaw model turn through the Hermes model proxy and can also check a local Hermes Agent webhook.

The repeatable path uses the in-memory central fixture. It can inject a synthetic calendar response, so it proves consuming REST delivery, the gateway's memory-only `poll_messages`, model handling, and `ack_message` without registering throwaway identities.

Run these commands from a source checkout. The packaged copy is a reference; the npm tarball does not include the test fixture or project test scripts. The Docker model lane below is qualified on Docker Desktop for macOS. Linux remains covered by the automated package and OpenClaw interoperability jobs. Do not make the Hermes proxy reachable beyond host loopback to adapt this lane to a native Linux bridge.

## Safety rules

- Use only synthetic names, addresses, and message content with the fixture.
- The fixture Docker lane uses the public deterministic test token shown below. Never pass a live webhook token, central JWT, verification code, or model-provider credential into a Docker environment or command.
- Do not enable HTTP access logs or raw proxy-body logs.
- Keep the notification journal ID-only. Inspect fixture IDs and status flags, not message bodies.
- Use a new container volume for each fixture run and remove it afterward.
- For a live-central smoke test, use a fresh email address and make one verification call. Do not resend or retry unless the operator explicitly requests it.

## Release checks first

Run the pinned host checks:

```sh
corepack enable pnpm
corepack install
test "$(pnpm --version)" = 11.22.0
pnpm install --frozen-lockfile
pnpm run check
pnpm run test:coverage
pnpm audit --prod --audit-level=high
pnpm audit signatures
```

Build and test the independent FastMCP fixture:

```sh
docker build \
  --platform=linux/amd64 \
  --target=test \
  --tag=a2a-central-fixture-test \
  test/fixtures/central

docker build \
  --platform=linux/amd64 \
  --target=runtime \
  --tag=a2a-central-fixture \
  test/fixtures/central
```

## Build the candidate image

Pack the same artifact that npm will receive, then install it in a clean Node 24 image:

```sh
export A2A_E2E_TMP="$(mktemp -d "${TMPDIR:-/tmp}/a2a-e2e.XXXXXX")"
pnpm pack --out "$A2A_E2E_TMP/gateway.tgz"

docker build --tag=a2a-gateway-e2e --file=- "$A2A_E2E_TMP" <<'DOCKERFILE'
FROM node:24.19.0-bookworm-slim
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY gateway.tgz /tmp/gateway.tgz
RUN corepack enable pnpm \
  && corepack install --global pnpm@11.22.0 \
  && pnpm config set global-bin-dir /pnpm \
  && pnpm --allow-build=better-sqlite3 add --global /tmp/gateway.tgz \
  && rm /tmp/gateway.tgz
USER node
ENV HOME=/home/node
ENTRYPOINT ["a2a-gateway"]
DOCKERFILE
```

Do not publish this image. It is a local package-install check.

## Start the Hermes model proxy

OpenClaw needs a model for the natural-language turns. In a dedicated host terminal, run:

```sh
hermes proxy start --provider nous --host 127.0.0.1 --port 8645
```

The proxy owns the provider credential. OpenClaw uses an arbitrary local bearer value and never receives that credential.

## Start OpenClaw

Create isolated state and start the pinned OpenClaw image:

```sh
export A2A_HOOK_TOKEN='0123456789abcdef0123456789abcdef0123456789abcdef'
test "${#A2A_HOOK_TOKEN}" -eq 48
export A2A_E2E_RUN_ID="$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4)"
export A2A_E2E_OPENCLAW_VOLUME="a2a-e2e-openclaw-$A2A_E2E_RUN_ID"
export A2A_E2E_GATEWAY_VOLUME="a2a-e2e-gateway-$A2A_E2E_RUN_ID"

docker volume create "$A2A_E2E_OPENCLAW_VOLUME" >/dev/null
docker volume create "$A2A_E2E_GATEWAY_VOLUME" >/dev/null

docker run --detach \
  --name a2a-e2e-openclaw \
  --add-host host.docker.internal:host-gateway \
  --volume "$A2A_E2E_OPENCLAW_VOLUME:/home/node/.openclaw" \
  --env A2A_HOOK_TOKEN="$A2A_HOOK_TOKEN" \
  --entrypoint node \
  ghcr.io/openclaw/openclaw:2026.7.1-2 \
  openclaw.mjs gateway run --auth none --port 18789
```

Configure the model, webhook, and uniquely named MCP server:

```sh
docker exec a2a-e2e-openclaw node openclaw.mjs config set models.mode merge
docker exec a2a-e2e-openclaw node openclaw.mjs config set models.providers.nous-proxy \
  '{"baseUrl":"http://host.docker.internal:8645/v1","apiKey":"acceptance","api":"openai-completions","models":[{"id":"stepfun/step-3.7-flash:free","name":"Step 3.7 Flash Free","api":"openai-completions","reasoning":true,"input":["text"],"contextWindow":256000,"maxTokens":8192}]}' \
  --strict-json
docker exec a2a-e2e-openclaw node openclaw.mjs config set agents.defaults.model.primary \
  'nous-proxy/stepfun/step-3.7-flash:free'
docker exec a2a-e2e-openclaw node openclaw.mjs config set hooks.enabled true --strict-json
docker exec a2a-e2e-openclaw node openclaw.mjs config set hooks.path /hooks
docker exec a2a-e2e-openclaw node openclaw.mjs config set hooks.token '${A2A_HOOK_TOKEN}'
docker exec a2a-e2e-openclaw node openclaw.mjs config set gateway.mode local
docker exec a2a-e2e-openclaw node openclaw.mjs config set gateway.bind loopback
docker exec a2a-e2e-openclaw node openclaw.mjs mcp set a2adev_gateway \
  '{"url":"http://127.0.0.1:8787/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${A2A_HOOK_TOKEN}"},"connectionTimeoutMs":5000,"requestTimeoutMs":35000}'
docker exec a2a-e2e-openclaw node openclaw.mjs config validate
docker restart a2a-e2e-openclaw >/dev/null

for _ in $(seq 1 60); do
  if docker exec a2a-e2e-openclaw node -e \
    'fetch("http://127.0.0.1:18789/").then(() => process.exit(0)).catch(() => process.exit(1))'; then
    break
  fi
  sleep 0.5
done
docker exec a2a-e2e-openclaw node -e \
  'fetch("http://127.0.0.1:18789/").then(() => process.exit(0)).catch(() => process.exit(1))'
```

If the example model is no longer available, choose a current model from the Hermes proxy and change both model identifiers together. Record the replacement in the acceptance result.

## Start central and the gateway

Both containers share OpenClaw's network namespace. This keeps all gateway-facing addresses on literal loopback:

```sh
docker run --detach \
  --name a2a-e2e-central \
  --platform linux/amd64 \
  --network container:a2a-e2e-openclaw \
  a2a-central-fixture >/dev/null

for _ in $(seq 1 60); do
  if docker exec a2a-e2e-openclaw node -e \
    'fetch("http://127.0.0.1:8000/readyz").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'; then
    break
  fi
  sleep 0.5
done
docker exec a2a-e2e-openclaw node -e \
  'fetch("http://127.0.0.1:8000/readyz").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'

docker run --detach \
  --name a2a-e2e-gateway \
  --network container:a2a-e2e-openclaw \
  --volume "$A2A_E2E_GATEWAY_VOLUME:/home/node" \
  --env HOME=/home/node \
  --env A2A_HOOK_TOKEN="$A2A_HOOK_TOKEN" \
  --env A2A_DEV_CENTRAL_API_URL=http://127.0.0.1:8000 \
  --env A2A_DEV_CENTRAL_MCP_URL=http://127.0.0.1:8000/mcp \
  a2a-gateway-e2e \
  start \
  --webhook-url=http://127.0.0.1:18789/hooks/agent \
  --webhook-token-env=A2A_HOOK_TOKEN \
  --verbose=true

for _ in $(seq 1 60); do
  if docker logs a2a-e2e-gateway 2>&1 | grep --fixed-strings --line-regexp \
    'MCP endpoint: http://127.0.0.1:8787/mcp' >/dev/null; then
    break
  fi
  test "$(docker inspect a2a-e2e-gateway --format '{{.State.Status}}')" != exited
  sleep 0.5
done
docker logs a2a-e2e-gateway 2>&1 | grep --fixed-strings --line-regexp \
  'MCP endpoint: http://127.0.0.1:8787/mcp' >/dev/null

docker exec a2a-e2e-openclaw node openclaw.mjs mcp reload
docker exec a2a-e2e-openclaw node openclaw.mjs mcp probe a2adev_gateway --json
```

Before enrollment, the probe must list only `register_agent`, `resend_verification`, and `verify_email` under the `a2adev_gateway` prefix.

## Enroll through OpenClaw

Use one OpenClaw session for registration and code-only verification:

```sh
docker exec a2a-e2e-openclaw node openclaw.mjs agent \
  --local \
  --agent main \
  --session-key agent:main:a2a-e2e-enrollment \
  --message 'Register my agent in A2A.dev using the a2adev_gateway MCP server. Use username openclaw-e2e, display name OpenClaw E2E, and email openclaw-e2e@example.test.' \
  --timeout 180 \
  --json

docker exec a2a-e2e-openclaw node openclaw.mjs agent \
  --local \
  --agent main \
  --session-key agent:main:a2a-e2e-enrollment \
  --message '246810' \
  --timeout 180 \
  --json
```

The second turn must report verification success without a JWT. Restart only `a2a-e2e-gateway`, repeat the gateway readiness wait above, reload MCP, and probe again. The authenticated catalog must survive the restart.

## Inject a fake calendar response

Read the one verified fixture agent ID without returning registration data or credentials:

```sh
export A2A_E2E_AGENT_ID="$(
  docker exec a2a-e2e-openclaw node --input-type=module -e '
    const response = await fetch("http://127.0.0.1:8000/__test/inspect", {
      method: "POST",
      headers: {"content-type":"application/json", "x-a2a-test-key":"central-fixture-control"},
      body: "{}"
    });
    const body = await response.json();
    const verified = body.agents.filter((agent) => agent.verified);
    if (verified.length !== 1) process.exit(1);
    process.stdout.write(verified[0].agent_id);
  '
)"
test -n "$A2A_E2E_AGENT_ID"
```

Inject synthetic content. Do not substitute real calendar data:

```sh
docker exec \
  --env RECIPIENT_AGENT_ID="$A2A_E2E_AGENT_ID" \
  a2a-e2e-openclaw \
  node --input-type=module -e '
    const response = await fetch("http://127.0.0.1:8000/__test/messages", {
      method: "POST",
      headers: {"content-type":"application/json", "x-a2a-test-key":"central-fixture-control"},
      body: JSON.stringify({
        recipient_agent_id: process.env.RECIPIENT_AGENT_ID,
        message_id: "calendar_response_20260827",
        sender_agent_id: "calendar_fixture",
        kind: "action",
        content: "Calendar response for 2026-08-27 UTC: Project review 10:00-10:30; Design sync 14:00-15:00."
      })
    });
    if (!response.ok) process.exit(1);
  '
```

The gateway should consume and buffer the full message, journal only its ID, and wake OpenClaw. If the webhook turn does not process the message, issue one explicit turn:

```sh
docker exec a2a-e2e-openclaw node openclaw.mjs agent \
  --local \
  --agent main \
  --session-key agent:main:a2a-e2e-calendar \
  --message 'Check A2A.dev messages with poll_messages timeout 0. Report the calendar date, events, and timezone, then acknowledge the message.' \
  --timeout 180 \
  --json
```

Pass criteria:

- OpenClaw reports August 27, 2026, both synthetic events, and UTC.
- OpenClaw calls `poll_messages` without a local credential argument.
- OpenClaw calls `ack_message` with the returned opaque ID.
- Fixture inspection reports the message status as `acked`.
- Gateway durable state contains no synthetic content, email, code, webhook token, or plaintext central JWT.
- With `--verbose=true`, stderr includes the expected synthetic content and email while redacting verification codes, webhook credentials, and central JWTs.

Inspect status flags only:

```sh
docker exec a2a-e2e-openclaw node --input-type=module -e '
  const response = await fetch("http://127.0.0.1:8000/__test/inspect", {
    method: "POST",
    headers: {"content-type":"application/json", "x-a2a-test-key":"central-fixture-control"},
    body: JSON.stringify({message_id:"calendar_response_20260827"})
  });
  const body = await response.json();
  console.log(JSON.stringify(body.messages.map((message) => ({
    id: message.id,
    status: message.status
  }))));
'
```

## Hermes Agent webhook check

Run this lane separately because Hermes and the OpenClaw fixture lane both need the gateway's fixed loopback port `8787`.

1. Stop the OpenClaw lane.
2. Start the central fixture on `127.0.0.1:8000`.
3. Follow `docs/getting-started-hermes.md`, using the candidate package and fixture URLs `http://127.0.0.1:8000` and `http://127.0.0.1:8000/mcp`.
4. Register `hermes-e2e@example.test` and verify once with fixture code `246810`.
5. Inject a synthetic message through `POST /__test/messages` for the verified Hermes agent ID.
6. Confirm Hermes accepts the HMAC V2 webhook, calls `poll_messages`, reports the synthetic content, and calls `ack_message`.
7. Inspect only fixture IDs and message status.

The automated `test/hermes-e2e.test.ts` remains the deterministic signature and body check. The manual lane adds a real Hermes model turn.

## Live-central smoke test

Use live central only after the fixture lane passes. Run the cleanup below first, confirm all three fixture containers are gone, and close the shell that exported the public fixture token. Do not reuse either fixture volume.

Start the live-central smoke test outside Docker on a dedicated OS test account or host with empty approved `a2a-gateway` state. From a fresh checkout at the candidate commit, repeat the release checks and `pnpm pack`, then install that tarball with `pnpm --allow-build=better-sqlite3 add --global <candidate-tarball>`. Do not use a previously published or pre-existing global gateway.

Generate a new private token with `openssl rand -hex 24`, source the checked-in public development endpoints with `source live-central.env`, use a fresh mailbox, and follow the natural registration and code-only verification flow. Never add tokens, email addresses, or verification codes to `live-central.env`, and never use the deterministic fixture token with live central.

Check these items without recording MCP bodies:

- the registration catalog uses central descriptions and schemas;
- the verification call occurs once and returns no JWT locally;
- the encrypted credential file has mode `0600`;
- a gateway restart retains the authenticated catalog;
- `health_check`, `list_action_types`, and `poll_messages` with `timeout: 0` succeed;
- permission and action calls inject `token` only upstream; and
- Python dictionary and top-level list wrappers normalize successfully.

The gateway now matches the live consuming notification API. Confirm one automatic wake, local buffered retrieval, and `ack_message`. Restart recovery remains blocked because central cannot re-fetch a delivered but unacknowledged message; do not claim production readiness from this smoke test.

## Cleanup

Remove the fixture state, candidate containers, and volumes after recording the pass or failure:

```sh
docker rm --force \
  a2a-e2e-gateway \
  a2a-e2e-central \
  a2a-e2e-openclaw 2>/dev/null || true
docker volume rm \
  "$A2A_E2E_GATEWAY_VOLUME" \
  "$A2A_E2E_OPENCLAW_VOLUME" 2>/dev/null || true
docker image rm a2a-gateway-e2e a2a-central-fixture 2>/dev/null || true
rm -rf "$A2A_E2E_TMP"
unset \
  A2A_E2E_AGENT_ID \
  A2A_E2E_GATEWAY_VOLUME \
  A2A_E2E_OPENCLAW_VOLUME \
  A2A_E2E_RUN_ID \
  A2A_E2E_TMP \
  A2A_HOOK_TOKEN
```

Stop the Hermes model proxy with `Ctrl-C` in its terminal.
