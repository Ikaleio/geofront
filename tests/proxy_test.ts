import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "net";
import { randomBytes } from "crypto";
import { connect } from "net";
import { Geofront, type Connection, type ConnectionInfo } from "../src/geofront";
import {
  startBackendServer,
  runClientTest,
  TEST_CONSTANTS,
  getRandomPort,
  createHandshakePacket,
  createLoginStartPacket,
  writeVarInt,
} from "./helpers";

describe("Geofront E2E Test: Standard Proxy (New API)", () => {
  let proxy: Geofront.GeofrontProxy;
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

    // 使用新的工厂方法创建代理
    proxy = Geofront.createProxy();

    // 设置路由器
    proxy.setRouter((context) => {
      return {
        target: {
          host: TEST_CONSTANTS.BACKEND_HOST,
          port: BACKEND_PORT,
        }
      };
    });

    // 启动监听器
    const listener = await proxy.listen({
      host: "0.0.0.0",
      port: PROXY_PORT,
      proxyProtocol: 'none'
    });
    expect(listener.id).toBeGreaterThan(0); // 确保监听器启动成功
  });

  afterAll(async () => {
    if (proxy) {
      await proxy.shutdown();
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
    proxy.setEventHandlers({
      onConnectionClosed: (connection: Connection, info: ConnectionInfo) => {
        disconnectedConnections.push(info.id);
      }
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

    if (!result.success) {
      throw new Error(result.error);
    }

    expect(result.success).toBe(true);
    expect(disconnectedConnections.length).toBeGreaterThan(0);
  });

  test("should track connection information correctly", async () => {
    const connections: Connection[] = [];
    const closedConnections: ConnectionInfo[] = [];

    // 设置事件处理器
    proxy.setEventHandlers({
      onConnectionEstablished: (connection: Connection) => {
        connections.push(connection);
      },
      onConnectionClosed: (connection: Connection, info: ConnectionInfo) => {
        closedConnections.push(info);
      }
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
            // 忽略连接错误，专注于连接管理
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

    // 等待额外时间确保所有事件都被处理
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 验证连接信息
    expect(connections.length).toBeGreaterThanOrEqual(numClients);
    expect(closedConnections.length).toBeGreaterThanOrEqual(numClients);

    // 验证连接对象包含正确的信息
    for (const conn of connections) {
      expect(conn.id).toBeGreaterThan(0);
      expect(conn.player).toBeDefined();
      expect(conn.ip).toBeDefined();
      expect(conn.host).toBe(TEST_CONSTANTS.TEST_HOST);
      expect(conn.protocol).toBe(TEST_CONSTANTS.TEST_PROTOCOL_VERSION);
      expect(conn.startAt).toBeInstanceOf(Date);
      expect(conn.getDuration()).toBeGreaterThan(0);
    }

    // 验证关闭连接信息
    for (const info of closedConnections) {
      expect(info.id).toBeGreaterThan(0);
      expect(info.player).toBeDefined();
      expect(info.ip).toBeDefined();
      expect(info.host).toBe(TEST_CONSTANTS.TEST_HOST);
      expect(info.protocol).toBe(TEST_CONSTANTS.TEST_PROTOCOL_VERSION);
      expect(info.startAt).toBeInstanceOf(Date);
    }
  });

  test("should provide connection management APIs", async () => {
    // 这个测试验证连接管理API的基本功能
    // 初始状态验证
    expect(proxy.getConnections()).toHaveLength(0);
    expect(proxy.getActivePlayerList()).toHaveLength(0);
    expect(proxy.getConnectionCount()).toBe(0);
    expect(proxy.getPlayerCount()).toBe(0);

    // 基本 API 方法存在性验证
    expect(typeof proxy.getConnection).toBe('function');
    expect(typeof proxy.getConnectionsByPlayer).toBe('function');
    expect(typeof proxy.getConnectionsByIp).toBe('function');
    expect(typeof proxy.getConnectionsByHost).toBe('function');
    expect(typeof proxy.disconnectAll).toBe('function');
    expect(typeof proxy.disconnectPlayer).toBe('function');
    expect(typeof proxy.disconnectIp).toBe('function');
    expect(typeof proxy.getMetrics).toBe('function');
    
    // 验证 getConnection 对不存在的连接返回 undefined
    expect(proxy.getConnection(99999)).toBeUndefined();
    
    // 验证按条件查询对空状态返回空数组
    expect(proxy.getConnectionsByPlayer("nonexistent")).toHaveLength(0);
    expect(proxy.getConnectionsByIp("127.0.0.1")).toHaveLength(0);
    expect(proxy.getConnectionsByHost("test.example.com")).toHaveLength(0);
    
    // 验证断开连接方法对空状态返回 0
    const disconnectedAll = await proxy.disconnectAll("test");
    expect(disconnectedAll).toBe(0);
    
    const disconnectedPlayer = await proxy.disconnectPlayer("nonexistent", "test");
    expect(disconnectedPlayer).toBe(0);
    
    const disconnectedIp = await proxy.disconnectIp("127.0.0.1", "test");
    expect(disconnectedIp).toBe(0);
    
    // 验证 metrics 返回正确的结构
    const metrics = proxy.getMetrics();
    expect(metrics).toHaveProperty('connections');
    expect(metrics).toHaveProperty('traffic');
    expect(metrics.connections).toHaveProperty('total');
    expect(metrics.connections).toHaveProperty('active');
    expect(metrics.traffic).toHaveProperty('totalBytesSent');
    expect(metrics.traffic).toHaveProperty('totalBytesReceived');
  });
});