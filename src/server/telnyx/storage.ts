import { createHash, createHmac } from "node:crypto";
import type { StoredObject } from "./types";

/**
 * Telnyx Cloud Storage (S3-compatible) for knowledge buckets. Requests carry an AWS SigV4
 * Authorization header with the Telnyx API key as the access key id; Telnyx ignores the signature,
 * but we sign properly so the header is well-formed. Never presign with this: a presigned URL would
 * carry the API key (docs/telnyx-api-notes.md §15).
 */

export const STORAGE_REGION = "us-central-1";
const HOST = `${STORAGE_REGION}.telnyxcloudstorage.com`;

export class StorageError extends Error {
  constructor(
    public status: number,
    public code: string,
    path: string,
  ) {
    super(`Telnyx storage ${status} ${code} on ${path}`);
  }
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** S3 URI-encodes every path segment, keeping the slashes between them. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

export function signedHeaders(apiKey: string, method: string, path: string, query: URLSearchParams, now = new Date()) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = "UNSIGNED-PAYLOAD";
  const sortedQuery = [...query.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const canonical = [method, encodePath(path), sortedQuery, `host:${HOST}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`, "host;x-amz-content-sha256;x-amz-date", payloadHash].join("\n");
  const scope = `${day}/${STORAGE_REGION}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${apiKey}`, day), STORAGE_REGION), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${apiKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
  };
}

function xmlValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function createStorageClient(apiKey: string) {
  async function s3(method: string, path: string, opts: { query?: URLSearchParams; body?: Blob; contentType?: string } = {}) {
    const query = opts.query ?? new URLSearchParams();
    const qs = query.toString();
    const res = await fetch(`https://${HOST}${encodePath(path)}${qs ? `?${qs}` : ""}`, {
      method,
      headers: {
        ...signedHeaders(apiKey, method, path, query),
        ...(opts.contentType ? { "Content-Type": opts.contentType } : {}),
      },
      body: opts.body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new StorageError(res.status, xmlValues(text, "Code")[0] ?? "Unknown", path);
    }
    return res;
  }

  return {
    async createBucket(bucket: string) {
      try {
        await s3("PUT", `/${bucket}`);
      } catch (err) {
        // Our own bucket from an earlier, interrupted attempt.
        if (err instanceof StorageError && err.code === "BucketAlreadyOwnedByYou") return;
        throw err;
      }
    },

    async putObject(bucket: string, key: string, body: Blob, contentType: string) {
      await s3("PUT", `/${bucket}/${key}`, { body, contentType });
    },

    /** Empty when the bucket doesn't exist, so teardown can always run. */
    async listObjects(bucket: string): Promise<StoredObject[]> {
      const out: StoredObject[] = [];
      let token: string | undefined;
      do {
        const query = new URLSearchParams({ "list-type": "2", "max-keys": "1000" });
        if (token) query.set("continuation-token", token);
        let xml: string;
        try {
          xml = await (await s3("GET", `/${bucket}`, { query })).text();
        } catch (err) {
          if (err instanceof StorageError && err.code === "NoSuchBucket") return out;
          throw err;
        }
        for (const item of xmlValues(xml, "Contents")) {
          out.push({ key: unescapeXml(xmlValues(item, "Key")[0] ?? ""), sizeBytes: Number(xmlValues(item, "Size")[0] ?? 0) });
        }
        token = xmlValues(xml, "IsTruncated")[0] === "true" ? unescapeXml(xmlValues(xml, "NextContinuationToken")[0] ?? "") : undefined;
      } while (token);
      return out;
    },

    async deleteObject(bucket: string, key: string) {
      try {
        await s3("DELETE", `/${bucket}/${key}`);
      } catch (err) {
        if (err instanceof StorageError && err.status === 404) return;
        throw err;
      }
    },

    async deleteBucket(bucket: string) {
      try {
        await s3("DELETE", `/${bucket}`);
      } catch (err) {
        if (err instanceof StorageError && (err.status === 404 || err.code === "NoSuchBucket")) return;
        throw err;
      }
    },
  };
}
