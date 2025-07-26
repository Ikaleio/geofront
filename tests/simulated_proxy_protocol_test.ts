import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "net";
import { connect } from "net";
import { Geofront } from "../src/geofront";
import {
  startBackendServer,
  TEST_CONSTANTS,
  getRandomPort,
  createHandshakePacket,
  createLoginStartPacket,
} from "./helpers";

describe("Geofront E2E Test: PROXY Protocol Inbound", () => {
  let backendServer: Server;
  let backendClosed: Promise<void>;
  let BACKEND_PORT: number;

  beforeAll(async () => {
    BACKEND_PORT = getRandomPort();
    // 启动后端服务器，不使用 PROXY Protocol（因为我们测试的是入站处理）
    const backend = await startBackendServer({
      port: BACKEND_PORT,
      useProxyProtocol: false,
    });
    backendServer = backend.server;
    backendClosed = backend.closed;
  });

  afterAll(async () => {
    if (backendServer) {
      backendServer.close();
      await backendClosed;
    }
  });

  // 创建 PROXY Protocol v1 头部
  function createProxyHeader(
    srcIp: string,
    destIp: string,
    srcPort: number,
    destPort: number
  ): Buffer {
    const header = `PROXY TCP4 ${srcIp} ${destIp} ${srcPort} ${destPort}\r\n`;
    return Buffer.from(header, "ascii");
  }

  // 测试客户端连接函数
  function testConnection(
    proxyPort: number,
    sendProxyHeader: boolean = false
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      let client: any = null;
      let resolved = false;

      // 添加超时机制
      const timeout = setTimeout(() => {
        safeResolve({
          success: false,
          error: "连接超时",
        });
      }, 1000); // 1秒超时

      const safeResolve = (result: { success: boolean; error?: string }) => {
        if (resolved) return;
        resolved = true;

        clearTimeout(timeout);

        if (client) {
          try {
            client.destroy();
          } catch (e) {
            // 忽略关闭时的错误
          }
          client = null;
        }

        resolve(result);
      };

      try {
        client = connect(proxyPort, "127.0.0.1", () => {
          try {
            // 如果需要发送 PROXY 头部，先发送它
            if (sendProxyHeader) {
              const proxyHeader = createProxyHeader(
                "192.168.1.100",
                "127.0.0.1",
                12345,
                proxyPort
              );
              client.write(proxyHeader);
            }

            // 发送正常的 Minecraft 握手包
            const handshake = createHandshakePacket(
              TEST_CONSTANTS.TEST_PROTOCOL_VERSION,
              TEST_CONSTANTS.TEST_HOST,
              proxyPort,
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
              error: `发送数据包失败: ${err.message}`,
            });
          }
        });

        client.on("data", () => {
          // 收到任何数据都认为连接成功
          safeResolve({ success: true });
        });

        client.on("error", (err: Error) => {
          safeResolve({ success: false, error: `客户端错误: ${err.message}` });
        });

        client.on("close", () => {
          if (!resolved) {
            safeResolve({
              success: false,
              error: "连接被关闭，未收到响应",
            });
          }
        });
      } catch (err: any) {
        safeResolve({
          success: false,
          error: `创建连接失败: ${err.message}`,
        });
      }
    });
  }

  // 创建和配置 Geofront 实例的辅助函数
  async function createGeofrontInstance(
    proxyProtocolIn: "none" | "optional" | "strict"
  ) {
    const geofront = Geofront.create();

    // 设置 PROXY Protocol 选项
    const result = geofront.setOptions({ proxyProtocolIn });
    expect(result).toBe(0); // 确保设置成功

    geofront.setRouter((ip, host, player, protocol) => {
      return {
        remoteHost: TEST_CONSTANTS.BACKEND_HOST,
        remotePort: BACKEND_PORT,
      };
    });

    const proxyPort = getRandomPort();
    const { code } = geofront.listen("0.0.0.0", proxyPort);
    expect(code).toBe(0);

    return { geofront, proxyPort };
  }

  test('proxyProtocolIn: "none" - should accept normal connections without PROXY header', async () => {
    const { geofront, proxyPort } = await createGeofrontInstance("none");

    try {
      const result = await testConnection(proxyPort, false);
      expect(result.success).toBe(true);
    } finally {
      await geofront.shutdown();
    }
  });

  test('proxyProtocolIn: "none" - should reject connections with PROXY header', async () => {
    const { geofront, proxyPort } = await createGeofrontInstance("none");

    try {
      const result = await testConnection(proxyPort, true);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/连接|超时|关闭|失败|ECONNREFUSED|错误/); // 更宽松的错误匹配
    } finally {
      await geofront.shutdown();
    }
  });

  test('proxyProtocolIn: "optional" - should accept normal connections without PROXY header', async () => {
    const { geofront, proxyPort } = await createGeofrontInstance("optional");

    try {
      const result = await testConnection(proxyPort, false);
      expect(result.success).toBe(true);
    } finally {
      await geofront.shutdown();
    }
  });

  test('proxyProtocolIn: "optional" - should accept connections with PROXY header', async () => {
    const { geofront, proxyPort } = await createGeofrontInstance("optional");

    try {
      const result = await testConnection(proxyPort, true);
      expect(result.success).toBe(true);
    } finally {
      await geofront.shutdown();
    }
  });

  test('proxyProtocolIn: "strict" - should reject normal connections without PROXY header', async () => {
    const { geofront, proxyPort } = await createGeofrontInstance("strict");

    try {
      const result = await testConnection(proxyPort, false);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/连接|超时|关闭|ECONNREFUSED/); // 更宽松的错误匹配
    } finally {
      await geofront.shutdown();
    }
  });

  test('proxyProtocolIn: "strict" - should accept connections with PROXY header', async () => {
    const { geofront, proxyPort } = await createGeofrontInstance("strict");

    try {
      const result = await testConnection(proxyPort, true);
      expect(result.success).toBe(true);
    } finally {
      await geofront.shutdown();
    }
  });

  test("should validate setOptions with different values", async () => {
    const geofront = Geofront.create();

    try {
      // 测试所有有效的选项值
      const validOptions = ["none", "optional", "strict"] as const;
      for (const option of validOptions) {
        const result = geofront.setOptions({ proxyProtocolIn: option });
        expect(result).toBe(0); // PROXY_OK
      }

      // 测试无效选项应该抛出错误
      expect(() =>
        geofront.setOptions({ proxyProtocolIn: "invalid" as any })
      ).toThrow();

      // 测试空选项对象
      const result = geofront.setOptions({});
      expect(result).toBe(0);
    } finally {
      await geofront.shutdown();
    }
  });
});
