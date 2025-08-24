import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "net";
import { connect } from "net";
import { Geofront } from "../src/geofront";
import {
  startBackendServer,
  getRandomPort,
  createHandshakePacket,
  writeVarInt,
  writeString,
  readVarInt,
  readString,
  TEST_CONSTANTS,
} from "./helpers";

describe("Handshake port rewrite and login forwarding", () => {
  let proxy: Geofront.GeofrontProxy;
  let backendServer: Server;
  let backendClosed: Promise<void>;
  let PROXY_PORT: number;
  let BACKEND_PORT: number;
  let capturedHandshake: Buffer | null = null;
  let capturedLogin: Buffer | null = null;
  let buffer = Buffer.alloc(0);

  beforeAll(async () => {
    PROXY_PORT = getRandomPort();
    BACKEND_PORT = getRandomPort();

    const backend = await startBackendServer({
      port: BACKEND_PORT,
      onData: (data, socket) => {
        buffer = Buffer.concat([buffer, data]);
        while (true) {
          if (!capturedHandshake) {
            if (buffer.length === 0) return;
            const [len, lenBytes] = readVarInt(buffer, 0);
            if (buffer.length < len + lenBytes) return;
            capturedHandshake = buffer.subarray(0, len + lenBytes);
            buffer = buffer.subarray(len + lenBytes);
          } else if (!capturedLogin) {
            if (buffer.length === 0) return;
            const [len, lenBytes] = readVarInt(buffer, 0);
            if (buffer.length < len + lenBytes) return;
            capturedLogin = buffer.subarray(0, len + lenBytes);
            socket.end();
            return;
          } else {
            return;
          }
        }
      },
    });
    backendServer = backend.server;
    backendClosed = backend.closed;

    proxy = Geofront.createProxy();
    proxy.setRouter(() => ({
      target: { host: TEST_CONSTANTS.BACKEND_HOST, port: BACKEND_PORT },
    }));
    const listener = await proxy.listen({
      host: "0.0.0.0",
      port: PROXY_PORT,
      proxyProtocol: "none",
    });
    expect(listener.id).toBeGreaterThan(0);
  });

  afterAll(async () => {
    if (proxy) await proxy.shutdown();
    if (backendServer) {
      backendServer.close();
      await backendClosed;
    }
  });

  test("rewrites handshake port and forwards login packet verbatim", async () => {
    const client = connect(PROXY_PORT, "127.0.0.1");
    const handshake = createHandshakePacket(
      TEST_CONSTANTS.TEST_PROTOCOL_VERSION,
      TEST_CONSTANTS.TEST_HOST,
      PROXY_PORT,
      2,
    );
    const extra = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const loginPayload = Buffer.concat([
      writeVarInt(0x00),
      writeString(TEST_CONSTANTS.TEST_USERNAME),
      extra,
    ]);
    const loginPacket = Buffer.concat([
      writeVarInt(loginPayload.length),
      loginPayload,
    ]);

    await new Promise<void>((resolve) => {
      client.on("connect", () => {
        client.write(handshake);
        client.write(loginPacket);
        client.end();
      });
      client.on("close", resolve);
    });

    await new Promise<void>((resolve) => {
      const check = () => {
        if (capturedHandshake && capturedLogin) resolve();
        else setTimeout(check, 10);
      };
      check();
    });

    const buf = capturedHandshake!;
    let offset = 0;
    const [, lenBytes] = readVarInt(buf, offset);
    offset += lenBytes;
    const [, idBytes] = readVarInt(buf, offset);
    offset += idBytes;
    const [, protoBytes] = readVarInt(buf, offset);
    offset += protoBytes;
    const [, hostBytes] = readString(buf, offset);
    offset += hostBytes;
    const port = buf.readUInt16BE(offset);
    expect(port).toBe(BACKEND_PORT);

    expect(capturedLogin!.equals(loginPacket)).toBe(true);
  });
});
