import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "net";
import { randomBytes } from "crypto";
import { connect } from "net";
import { Geofront } from "../src/geofront";
import {
  startBackendServer,
  runClientTest,
  TEST_CONSTANTS,
  getRandomPort,
  createHandshakePacket,
  createLoginStartPacket,
  writeVarInt,
} from "./helpers";

describe("Geofront E2E Test: Standard Proxy", () => {
  let geofront: Geofront;
  let backendServer: Server;
  let backendClosed: Promise<void>;
  let PROXY_PORT: number;
  let BACKEND_PORT: number;

  beforeAll(async () => {
    PROXY_PORT = getRandomPort();
    BACKEND_PORT = getRandomPort();
    // 启动后端服务器 - 配置为在游戏阶段回显接收到的数据
    const backend = await startBackendServer({
      port: BACKEND_PORT,
      onData: (data, socket) => {
        // 回显接收到的数据（用于大数据包测试）
        socket.write(data);
      },
    });
    backendServer = backend.server;
    backendClosed = backend.closed;

    // 启动 Geofront
    geofront = new Geofront();
    await geofront.initialize();

    // 设置选项测试
    const result = await geofront.setOptions({
      proxyProtocolIn: "none",
    });
    expect(result).toBe(0); // 应该返回成功状态码

    geofront.setRouter((ip, host, player, protocol) => {
      return {
        remoteHost: TEST_CONSTANTS.BACKEND_HOST,
        remotePort: BACKEND_PORT,
      };
    });
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

  test("should proxy 8MB random data correctly between client and backend", async () => {
    // 生成 8MB 随机数据
    const DATA_SIZE = 8 * 1024 * 1024; // 8MB
    const originalData = randomBytes(DATA_SIZE);

    const testResult = new Promise<{ success: boolean; error?: string }>(
      (resolve) => {
        let client: any = null;
        let resolved = false;
        let gamePhase = false;
        let loginSuccessReceived = false;

        // 安全的resolve函数，确保只调用一次并清理资源
        const safeResolve = (result: { success: boolean; error?: string }) => {
          if (resolved) return;
          resolved = true;

          // 强制关闭客户端连接
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
          client = connect(PROXY_PORT, "127.0.0.1", () => {
            try {
              // 发送握手包
              const handshake = createHandshakePacket(
                TEST_CONSTANTS.TEST_PROTOCOL_VERSION,
                TEST_CONSTANTS.TEST_HOST,
                PROXY_PORT,
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

          let receivedData = Buffer.alloc(0);
          let dataReceived = false;

          client.on("data", (data: Buffer) => {
            try {
              receivedData = Buffer.concat([receivedData, data]);

              if (!gamePhase) {
                // 等待登录成功包
                if (!loginSuccessReceived && receivedData.length > 0) {
                  loginSuccessReceived = true;
                  gamePhase = true;

                  // 创建一个自定义数据包，包含8MB随机数据
                  const packetId = writeVarInt(0x10); // 使用一个不常用的包ID
                  const packetData = Buffer.concat([packetId, originalData]);
                  const packet = Buffer.concat([
                    writeVarInt(packetData.length),
                    packetData,
                  ]);

                  client.write(packet);

                  // 重置接收缓冲区，准备接收回显数据
                  receivedData = Buffer.alloc(0);
                }
              } else {
                // 游戏阶段，检查数据回显
                if (receivedData.length >= DATA_SIZE + 5) {
                  // 包长度 + 包ID + 数据
                  dataReceived = true;

                  // 跳过包长度和包ID，获取实际数据
                  let offset = 0;
                  // 读取包长度
                  const [packetLen, packetLenBytes] = readVarInt(
                    receivedData,
                    offset
                  );
                  offset += packetLenBytes;
                  // 读取包ID
                  const [packetId, packetIdBytes] = readVarInt(
                    receivedData,
                    offset
                  );
                  offset += packetIdBytes;

                  // 提取实际数据
                  const actualData = receivedData.subarray(
                    offset,
                    offset + DATA_SIZE
                  );

                  // 验证数据完整性
                  if (actualData.length === DATA_SIZE) {
                    const isDataCorrect = originalData.equals(actualData);
                    if (isDataCorrect) {
                      safeResolve({ success: true });
                    } else {
                      safeResolve({
                        success: false,
                        error: `数据不匹配: 发送 ${DATA_SIZE} 字节，接收 ${actualData.length} 字节，内容不一致`,
                      });
                    }
                  } else {
                    safeResolve({
                      success: false,
                      error: `数据长度不匹配: 期望 ${DATA_SIZE} 字节，实际接收 ${actualData.length} 字节`,
                    });
                  }
                }
              }
            } catch (err: any) {
              safeResolve({
                success: false,
                error: `处理接收数据时出错: ${err.message}`,
              });
            }
          });

          client.on("error", (err: Error) => {
            safeResolve({
              success: false,
              error: `客户端错误: ${err.message}`,
            });
          });

          client.on("close", () => {
            if (!dataReceived && !resolved) {
              if (!gamePhase) {
                safeResolve({
                  success: false,
                  error: "连接在登录阶段就被关闭了",
                });
              } else {
                safeResolve({
                  success: false,
                  error: `连接关闭但数据未完全接收: 期望 ${DATA_SIZE} 字节，实际接收 ${receivedData.length} 字节`,
                });
              }
            }
          });
        } catch (err: any) {
          safeResolve({
            success: false,
            error: `创建客户端连接失败: ${err.message}`,
          });
        }
      }
    );

    // 辅助函数：读取 VarInt
    function readVarInt(buffer: Buffer, offset: number): [number, number] {
      let numRead = 0;
      let result = 0;
      let read: number;
      do {
        if (offset + numRead >= buffer.length) {
          throw new Error("Buffer underflow while reading VarInt");
        }
        read = buffer.readUInt8(offset + numRead);
        const value = read & 0x7f;
        result |= value << (7 * numRead);
        numRead++;
        if (numRead > 5) {
          throw new Error("VarInt is too big");
        }
      } while ((read & 0x80) !== 0);
      return [result, numRead];
    }

    const result = await testResult;

    if (!result.success) {
      throw new Error(result.error);
    }

    expect(result.success).toBe(true);
  });

  test("should call disconnection callback when client disconnects", async () => {
    // 记录断开连接的回调
    const disconnectedConnections: number[] = [];

    // 设置断开连接回调
    geofront.setDisconnectionCallback((connId: number) => {
      disconnectedConnections.push(connId);
    });

    const testResult = new Promise<{ success: boolean; error?: string }>(
      (resolve) => {
        let client: any = null;
        let resolved = false;
        let connectedSuccessfully = false;

        // 安全的resolve函数
        const safeResolve = (result: { success: boolean; error?: string }) => {
          if (resolved) return;
          resolved = true;

          // 强制关闭客户端连接
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
          client = connect(PROXY_PORT, "127.0.0.1", () => {
            try {
              connectedSuccessfully = true;
              // 发送握手包
              const handshake = createHandshakePacket(
                TEST_CONSTANTS.TEST_PROTOCOL_VERSION,
                TEST_CONSTANTS.TEST_HOST,
                PROXY_PORT,
                2 // Login state
              );
              client.write(handshake);

              // 发送登录开始包
              const loginStart = createLoginStartPacket(
                TEST_CONSTANTS.TEST_USERNAME
              );
              client.write(loginStart);

              // 短暂延迟后主动断开连接以触发断开连接回调
              setTimeout(() => {
                if (client && !resolved) {
                  client.end();
                }
              }, 100);
            } catch (err: any) {
              safeResolve({
                success: false,
                error: `发送握手包失败: ${err.message}`,
              });
            }
          });

          client.on("data", (data: Buffer) => {
            // 不需要特殊处理，只要连接建立就足够了
          });

          client.on("error", (err: Error) => {
            if (!connectedSuccessfully) {
              safeResolve({
                success: false,
                error: `客户端错误: ${err.message}`,
              });
            }
          });

          client.on("close", () => {
            // 连接关闭后，等待一小段时间让断开连接回调被调用
            setTimeout(() => {
              if (disconnectedConnections.length > 0) {
                safeResolve({ success: true });
              } else {
                safeResolve({
                  success: false,
                  error: "连接断开但未调用断开连接回调",
                });
              }
            }, 200); // 等待200ms确保回调被调用
          });
        } catch (err: any) {
          safeResolve({
            success: false,
            error: `创建客户端连接失败: ${err.message}`,
          });
        }
      }
    );

    const result = await testResult;

    // 在轮询模型中不再需要移除回调

    if (!result.success) {
      throw new Error(result.error);
    }

    expect(result.success).toBe(true);
    expect(disconnectedConnections.length).toBeGreaterThan(0);
  });

  test("should call disconnection callback for multiple connections", async () => {
    // 记录断开连接的回调
    const disconnectedConnections: number[] = [];

    // 设置断开连接回调
    geofront.setDisconnectionCallback((connId: number) => {
      disconnectedConnections.push(connId);
    });

    const numClients = 3;
    const clientPromises: Promise<boolean>[] = [];

    // 创建多个客户端连接
    for (let i = 0; i < numClients; i++) {
      const clientPromise = new Promise<boolean>((resolve) => {
        let client: any = null;
        let resolved = false;

        const safeResolve = (success: boolean) => {
          if (resolved) return;
          resolved = true;

          if (client) {
            try {
              client.destroy();
            } catch (e) {
              // 忽略关闭时的错误
            }
            client = null;
          }

          resolve(success);
        };

        try {
          client = connect(PROXY_PORT, "127.0.0.1", () => {
            try {
              // 发送握手包
              const handshake = createHandshakePacket(
                TEST_CONSTANTS.TEST_PROTOCOL_VERSION,
                TEST_CONSTANTS.TEST_HOST,
                PROXY_PORT,
                2 // Login state
              );
              client.write(handshake);

              // 发送登录开始包
              const loginStart = createLoginStartPacket(
                `${TEST_CONSTANTS.TEST_USERNAME}_${i}`
              );
              client.write(loginStart);

              // 延迟断开连接
              setTimeout(() => {
                if (client && !resolved) {
                  client.end();
                }
              }, 50 + i * 20); // 错开断开时间
            } catch (err: any) {
              safeResolve(false);
            }
          });

          client.on("error", (err: Error) => {
            // 忽略连接错误，专注于断开连接回调
          });

          client.on("close", () => {
            // 连接关闭后等待回调
            setTimeout(() => {
              safeResolve(true);
            }, 100);
          });
        } catch (err: any) {
          safeResolve(false);
        }
      });

      clientPromises.push(clientPromise);
    }

    // 等待所有客户端完成
    const results = await Promise.all(clientPromises);

    // 等待额外时间确保所有断开连接回调都被调用
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 在轮询模型中不再需要移除回调

    // 验证结果
    const successfulClients = results.filter((r) => r).length;
    expect(successfulClients).toBe(numClients);
    expect(disconnectedConnections.length).toBeGreaterThanOrEqual(numClients);
  });
});
