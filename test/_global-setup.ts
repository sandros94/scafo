import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { signRequest } from "uns3/core";

/* Starts a disposable S3-compatible store unless S3_ENDPOINT is supplied. */

interface StoreSpec {
  image: string;
  port: number;
  command?: string[];
  accessKey: string;
  secretKey: string;
  /* Anonymous stores skip signing on the set-up requests. */
  signedBucketCreate: boolean;
}

const STORES: Record<string, StoreSpec> = {
  seaweedfs: {
    image: "chrislusf/seaweedfs:4.45",
    port: 8333,
    command: ["server", "-s3"],
    accessKey: "scafo",
    secretKey: "scafo-secret",
    signedBucketCreate: false,
  },
  rustfs: {
    image: "rustfs/rustfs:1.0.0-beta.12",
    port: 9000,
    accessKey: "rustfsadmin",
    secretKey: "rustfsadmin",
    signedBucketCreate: true,
  },
};

const BUCKET = "scafo-test";

export default async function setup(): Promise<() => Promise<void>> {
  if (process.env.S3_ENDPOINT !== undefined) return async () => {};

  const storeName = process.env.SCAFO_TEST_STORE ?? "seaweedfs";
  const spec = STORES[storeName];
  if (spec === undefined) {
    throw new Error(
      `unknown SCAFO_TEST_STORE "${storeName}", expected one of: ${Object.keys(STORES).join(", ")}`,
    );
  }

  let container: StartedTestContainer;
  try {
    let builder = new GenericContainer(spec.image)
      .withExposedPorts(spec.port)
      .withWaitStrategy(Wait.forListeningPorts());
    if (spec.command !== undefined) builder = builder.withCommand(spec.command);
    container = await builder.start();
  } catch (error) {
    console.warn(
      `integration tests stay skipped, could not start ${spec.image}:`,
      error instanceof Error ? error.message : error,
    );
    return async () => {};
  }

  const endpoint = `http://${container.getHost()}:${String(container.getMappedPort(spec.port))}`;
  try {
    await createBucket(endpoint, BUCKET, spec);
    await awaitFirstWrite(endpoint, BUCKET, spec);
  } catch (error) {
    await container.stop();
    throw error;
  }

  process.env.S3_ENDPOINT = endpoint;
  process.env.S3_ACCESS_KEY = spec.accessKey;
  process.env.S3_SECRET_KEY = spec.secretKey;
  process.env.S3_BUCKET = BUCKET;

  return async () => {
    await container.stop();
  };
}

/* Listening can precede S3 readiness. */
async function createBucket(endpoint: string, bucket: string, spec: StoreSpec): Promise<void> {
  const url = new URL(`${endpoint}/${bucket}`);

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await send("PUT", url, spec);
      if (response.ok || response.status === 409) return;
    } catch {
      /* gateway not accepting requests yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`could not create bucket "${bucket}" at ${endpoint}`);
}

/* A bucket that exists can still hold its first object write for seconds while
   the store lays out space for it (SeaweedFS 4.45 takes about five on a fresh
   container; 4.42 took one). That is start-up cost, not conformance, and the
   first test to write must not be the one to pay it. */
async function awaitFirstWrite(endpoint: string, bucket: string, spec: StoreSpec): Promise<void> {
  const url = new URL(`${endpoint}/${bucket}/.ready-${crypto.randomUUID()}`);

  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const written = await send("PUT", url, spec, "ready", AbortSignal.timeout(10_000));
      if (written.ok) {
        await send("DELETE", url, spec);
        return;
      }
    } catch {
      /* the write timed out or the gateway refused it; try again */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`bucket "${bucket}" at ${endpoint} never accepted a first write`);
}

/* One request to the store, signed when the store insists on it. */
async function send(
  method: "PUT" | "DELETE",
  url: URL,
  spec: StoreSpec,
  body?: string,
  signal?: AbortSignal,
): Promise<Response> {
  let headers: Headers | undefined;
  if (spec.signedBucketCreate) {
    const signed = await signRequest({
      method,
      url,
      region: "us-east-1",
      credentials: { accessKeyId: spec.accessKey, secretAccessKey: spec.secretKey },
      ...(body === undefined ? {} : { body }),
    });
    headers = signed.headers;
  }
  return fetch(url, { method, headers, body, signal });
}
