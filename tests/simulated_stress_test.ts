import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "net";
import { Geofront } from "../src/geofront";
import {
  startBackendServer,
  runClientTest,
  TEST_CONSTANTS,
  getRandomPort,
} from "./helpers";

const CLIENT_COUNT = 100;

describe("Geofront Stress Test", () => {
  let geofront: Geofront;
  let backendServer: Server;
  let backendClosed: Promise<void>;
  let PROXY_PORT: number;
  let BACKEND_PORT: number;

  beforeAll(async () => {
    PROXY_PORT = getRandomPort();
    BACKEND_PORT = getRandomPort();
    const backend = await startBackendServer({ port: BACKEND_PORT });
    backendServer = backend.server;
    backendClosed = backend.closed;

    geofront = new Geofront();
    await geofront.initialize();
    geofront.setRouter(() => ({
      remoteHost: TEST_CONSTANTS.BACKEND_HOST,
      remotePort: BACKEND_PORT,
    }));
    await geofront.listen("0.0.0.0", PROXY_PORT);
  });

  afterAll(async () => {
    if (geofront) {
      await geofront.shutdown();
    }
    if (backendServer) {
      backendServer.close();
      await backendClosed;
    }
  });

  test(`should handle ${CLIENT_COUNT} concurrent connections`, async () => {
    const clientPromises: Promise<void>[] = [];
    for (let i = 0; i < CLIENT_COUNT; i++) {
      const clientPromise = new Promise<void>((resolve, reject) => {
        runClientTest({
          port: PROXY_PORT,
          onData: (data, client) => {
            client.end();
            resolve();
          },
        }).catch(reject);
      });
      clientPromises.push(clientPromise);
    }

    const results = await Promise.allSettled(clientPromises);
    const failed = results.filter((r) => r.status === "rejected");

    expect(failed.length).toBe(0);
    if (failed.length > 0) {
      console.error("Failed clients:", failed);
    }
  }, 20000); // Increase timeout for stress test
});
