#!/usr/bin/env node

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const token = process.env.A2A_GATEWAY_TOKEN;
if (token === undefined || !/^[0-9a-f]{48}$/u.test(token)) {
  process.stderr.write("Invalid A2A gateway token\n");
  process.exitCode = 4;
} else {
  const expectedAuthorization = Buffer.from(`Bearer ${token}`, "ascii");
  const server = createServer(async (request, response) => {
    const authorization = Buffer.from(request.headers.authorization ?? "", "ascii");
    if (
      request.method !== "POST" ||
      request.url !== "/hooks/agent" ||
      request.headers.host !== "127.0.0.1:8645" ||
      request.headers.origin !== undefined ||
      authorization.byteLength !== expectedAuthorization.byteLength ||
      !timingSafeEqual(authorization, expectedAuthorization)
    ) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"ok":false}');
      return;
    }

    const chunks = [];
    let byteLength = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > 65_536) {
        response.writeHead(413, { "content-type": "application/json" });
        response.end('{"ok":false}');
        return;
      }
      chunks.push(bytes);
    }
    const body = Buffer.concat(chunks);
    try {
      const value = JSON.parse(body.toString("utf8"));
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "deliver,message,name,wakeMode" ||
        typeof value.message !== "string" ||
        value.name !== "A2A Gateway" ||
        value.deliver !== false ||
        value.wakeMode !== "now"
      ) {
        throw new Error("invalid body");
      }
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"ok":false}');
      return;
    }

    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = createHmac("sha256", token)
      .update(timestamp)
      .update(".")
      .update(body)
      .digest("hex");
    const deliveryId = request.headers["idempotency-key"];
    try {
      const upstream = await fetch("http://127.0.0.1:8644/webhooks/a2a", {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Timestamp": timestamp,
          "X-Webhook-Signature-V2": signature,
          ...(typeof deliveryId === "string" && deliveryId.length <= 256
            ? { "X-Request-ID": deliveryId }
            : {}),
        },
        body,
      });
      await upstream.body?.cancel();
      response.writeHead(upstream.ok ? upstream.status : 502, {
        "content-type": "application/json",
      });
      response.end(upstream.ok ? '{"ok":true}' : '{"ok":false}');
    } catch {
      response.writeHead(502, { "content-type": "application/json" });
      response.end('{"ok":false}');
    }
  });

  const stop = () => server.close(() => undefined);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.listen(8645, "127.0.0.1", () => {
    process.stdout.write("Hermes bridge: http://127.0.0.1:8645/hooks/agent\n");
  });
}
