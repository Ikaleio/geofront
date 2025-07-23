import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "net";
import { connect } from "net";
import { randomBytes } from "crypto";
import { Geofront } from "../src/geofront";
import * as socks from "socksv5";
import {
  startBackendServer,
  TEST_CONSTANTS,
  getRandomPort,
  createHandshakePacket,
  createLoginStartPacket,
  writeVarInt,
} from "./helpers";

describe("Geofront E2E Test: SOCKS5 Proxy", () => {
  let geofront: Geofront;
  let backendServer: Server;
  let backendClosed: Promise<void>;
  let socksServer: socks.SocksServer;
  let PROXY_PORT: number;
  let BACKEND_PORT: number;
  let SOCKS_PORT: number;

  beforeAll(async () => {
    PROXY_PORT = getRandomPort();
    BACKEND_PORT = getRandomPort();
    SOCKS_PORT = getRandomPort();
    // 启动 SOCKS5 服务器
    socksServer = socks.createServer((info, accept) => accept());
    socksServer.useAuth(socks.auth.None());
    await new Promise<void>((resolve) =>
      socksServer.listen(SOCKS_PORT, "127.0.0.1", resolve)
    );

    // 启动后端服务器
    const backend = await startBackendServer({
      port: BACKEND_PORT,
    });
    backendServer = backend.server;
    backendClosed = backend.closed;

    // 启动 Geofront
    geofront = new Geofront();
    await geofront.initialize();
    geofront.setRouter((ip, host, player, protocol) => {
      return {
        remoteHost: TEST_CONSTANTS.BACKEND_HOST,
        remotePort: BACKEND_PORT,
        proxy: `socks5://127.0.0.1:${SOCKS_PORT}`,
      };
    });
    await geofront.listen("0.0.0.0", PROXY_PORT);
  });

  afterAll(async () => {
    if (geofront) {
      await geofront.shutdown();
    }
    if (socksServer) {
      socksServer.close();
    }
    if (backendServer) {
      backendServer.close();
      await backendClosed;
    }
  });

  test("should proxy data correctly through SOCKS5", async () => {
    const testData = randomBytes(1024); // 1KB 测试数据

    const testResult = new Promise<{ success: boolean; error?: string }>(
      (resolve) => {
        let resolved = false;
        let client: any = null;

        const safeResolve = (result: { success: boolean; error?: string }) => {
          if (resolved) return;
          resolved = true;

          if (client) {
            try {
              client.destroy();
            } catch (e) {
              // 忽略关闭错误
            }
            client = null;
          }

          resolve(result);
        };

        try {
          client = connect(PROXY_PORT, "127.0.0.1", () => {
            try {
              // 发送握手包
              const handshake = createHandshakePacket(
                TEST_CONSTANTS.TEST_PROTOCOL_VERSION,
                TEST_CONSTANTS.TEST_HOST,
                BACKEND_PORT,
                2 // Login state
              );
              client.write(handshake);

              // 发送登录开始包
              const loginStart = createLoginStartPacket(
                TEST_CONSTANTS.TEST_USERNAME
              );
              client.write(loginStart);
            } catch (err: any) {
              safeResolve({
                success: false,
                error: `发送握手包失败: ${err.message}`,
              });
            }
          });

          let loginSuccessReceived = false;
          let dataTransmitted = false;

          client.on("data", (data: Buffer) => {
            if (!loginSuccessReceived && data.length > 0) {
              loginSuccessReceived = true;

              // 发送自定义数据包来测试数据传输
              const packetId = writeVarInt(0x10); // 自定义包 ID
              const packetData = Buffer.concat([packetId, testData]);
              const packet = Buffer.concat([
                writeVarInt(packetData.length),
                packetData,
              ]);

              try {
                client.write(packet);
                dataTransmitted = true;

                // 立即认为测试成功
                safeResolve({ success: true });
              } catch (err: any) {
                safeResolve({
                  success: false,
                  error: `发送数据包失败: ${err.message}`,
                });
              }
            }
          });

          client.on("error", (err: Error) => {
            safeResolve({
              success: false,
              error: `客户端错误: ${err.message}`,
            });
          });

          client.on("close", () => {
            if (!resolved) {
              if (!loginSuccessReceived) {
                safeResolve({
                  success: false,
                  error: "连接在登录完成前就被关闭了",
                });
              } else if (!dataTransmitted) {
                safeResolve({
                  success: false,
                  error: "登录成功但数据传输失败",
                });
              }
            }
          });
        } catch (err: any) {
          safeResolve({
            success: false,
            error: `创建连接失败: ${err.message}`,
          });
        }
      }
    );

    const result = await testResult;
    if (!result.success) {
      throw new Error(result.error || "未知错误");
    }

    expect(result.success).toBe(true);
  }, 10000);
});
