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

describe("Geofront Stress Test (New API)", () => {
  let proxy: Geofront.GeofrontProxy;
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

    proxy = Geofront.createProxy();
    proxy.setRouter(() => ({
      target: {
        host: TEST_CONSTANTS.BACKEND_HOST,
        port: BACKEND_PORT,
      }
    }));

    const listener = await proxy.listen({
      host: "0.0.0.0",
      port: PROXY_PORT,
      proxyProtocol: 'none'
    });
    expect(listener.id).toBeGreaterThan(0);
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

  test(`should handle ${CLIENT_COUNT} concurrent connections with new API`, async () => {
    const connectionEvents: { established: number; closed: number } = { established: 0, closed: 0 };
    
    // 设置事件处理器来监控连接
    proxy.setEventHandlers({
      onConnectionEstablished: (connection) => {
        connectionEvents.established++;
        console.log(`[压力测试] 连接建立: ${connection.player}@${connection.ip} (${connectionEvents.established}/${CLIENT_COUNT})`);
      },
      onConnectionClosed: (connection, info) => {
        connectionEvents.closed++;
        console.log(`[压力测试] 连接关闭: ${info.player} 持续时间: ${connection.getDurationString()} (${connectionEvents.closed}/${CLIENT_COUNT})`);
      },
      onError: (error) => {
        console.error(`[压力测试错误] ${error.message}`);
      }
    });

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

    // 等待一些时间让所有事件被处理
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 验证连接事件
    console.log(`[压力测试统计] 建立: ${connectionEvents.established}, 关闭: ${connectionEvents.closed}`);
    expect(connectionEvents.established).toBeGreaterThanOrEqual(CLIENT_COUNT * 0.8); // 至少80%成功
    expect(connectionEvents.closed).toBeGreaterThanOrEqual(CLIENT_COUNT * 0.8);

    // 验证最终状态
    const finalMetrics = proxy.getMetrics();
    console.log(`[最终统计] 总连接: ${finalMetrics.connections.total}, 活跃: ${finalMetrics.connections.active}`);
    expect(finalMetrics.connections.total).toBeGreaterThanOrEqual(CLIENT_COUNT * 0.8);
    expect(finalMetrics.connections.active).toBeLessThanOrEqual(5); // 大部分连接应该已关闭
  }, 30000); // 增加超时时间用于压力测试

  test("should track connection metrics during stress test", async () => {
    const connections: Geofront.Connection[] = [];
    const metrics: { peak: number; totalTraffic: number } = { peak: 0, totalTraffic: 0 };

    proxy.setEventHandlers({
      onConnectionEstablished: (connection) => {
        connections.push(connection);
        const currentCount = proxy.getConnectionCount();
        if (currentCount > metrics.peak) {
          metrics.peak = currentCount;
        }
      },
      onConnectionClosed: (connection) => {
        const connMetrics = connection.getMetrics();
        metrics.totalTraffic += connMetrics.bytesSent + connMetrics.bytesReceived;
      }
    });

    // 运行较小的压力测试来验证监控
    const smallClientCount = 20;
    const clientPromises: Promise<void>[] = [];
    
    for (let i = 0; i < smallClientCount; i++) {
      const clientPromise = runClientTest({
        port: PROXY_PORT,
        onData: (data, client) => {
          client.end();
        },
      });
      clientPromises.push(clientPromise);
    }

    await Promise.allSettled(clientPromises);
    await new Promise(resolve => setTimeout(resolve, 500));

    console.log(`[监控统计] 峰值连接: ${metrics.peak}, 总流量: ${metrics.totalTraffic} 字节`);
    expect(metrics.peak).toBeGreaterThan(0);
    expect(connections.length).toBeGreaterThanOrEqual(smallClientCount * 0.8);
  }, 20000);
});