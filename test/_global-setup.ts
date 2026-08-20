import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { signRequest } from "uns3/core";

/*
 * Starts a disposable S3-compatible store for the integration suite, unless
 * S3_ENDPOINT already points at one (CI override, real provider, local
 * playground). Pick the store with SCAFO_TEST_STORE (seaweedfs | rustfs;
 * default seaweedfs). Without docker the container fails to start and the
 * integration suite simply stays skipped.
 */

interface StoreSpec {
  image: string;
  port: number;
  command?: string[];
  accessKey: string;
  secretKey: string;
  /* Anonymous stores skip signing on the bucket-create request. */
  signedBucketCreate: boolean;
}

const STORES: Record<string, StoreSpec> = {
  seaweedfs: {
    image: "chrislusf/seaweedfs:4.42",
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

/*
 * The retry loop doubles as the readiness gate: the S3 gateway inside the
 * container may come up after its port is already listening.
 */
async function createBucket(endpoint: string, bucket: string, spec: StoreSpec): Promise<void> {
  const url = new URL(`${endpoint}/${bucket}`);

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      let headers: Headers | undefined;
      if (spec.signedBucketCreate) {
        const signed = await signRequest({
          method: "PUT",
          url,
          region: "us-east-1",
          credentials: { accessKeyId: spec.accessKey, secretAccessKey: spec.secretKey },
        });
        headers = signed.headers;
      }
      const response = await fetch(url, { method: "PUT", headers });
      if (response.ok || response.status === 409) return;
    } catch {
      /* gateway not accepting requests yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`could not create bucket "${bucket}" at ${endpoint}`);
}
