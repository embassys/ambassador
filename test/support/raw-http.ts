import { request } from "node:http";

export async function rawPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const target = new URL(url);
    const outgoing = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes <= 65_536) {
            chunks.push(chunk);
          }
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}
