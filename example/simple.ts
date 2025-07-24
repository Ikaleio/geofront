/**
 * 简单代理示例
 *
 * 这个示例展示如何使用 Geofront 创建一个简单的代理服务器，
 * 演示基本的路由和 MOTD 功能。
 *
 * 运行方式：
 * ```bash
 * bun run example/simple.ts
 * ```
 */

import { Geofront } from "../src/geofront";
import type { MotdResult } from "../src/motd";
import { buildMotd } from "../src/motd";

// 配置
const PROXY_HOST = "0.0.0.0";
const PROXY_PORT = 25565;
const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 25566;

async function main() {
  console.log("🌍 启动 Geofront 简单代理示例");
  console.log("=".repeat(40));

  try {
    // 使用工厂方法创建 Geofront 实例
    const geofront = Geofront.create();
    console.log("✓ Geofront 初始化完成");

    // 设置路由
    geofront.setRouter((ip, host, player, protocol) => {
      console.log(`[路由] ${player}@${ip} -> ${host}:${protocol}`);

      // 根据主机名进行路由
      if (host.toLowerCase().includes("example.com")) {
        return {
          remoteHost: BACKEND_HOST,
          remotePort: BACKEND_PORT,
        };
      }

      // 默认拒绝连接
      return {
        disconnect: "§c未知的服务器地址！\n§7请使用 example.com 连接",
      };
    });

    // 设置 MOTD
    geofront.setMotdCallback((ip, host, protocol) => {
      console.log(`[MOTD] 状态请求来自 ${ip}`);

      const motd: MotdResult = {
        version: {
          name: "Geofront Proxy",
          protocol: protocol,
        },
        players: {
          max: 100,
          online: 0,
          sample: [
            {
              name: "§6欢迎使用 Geofront",
              id: "00000000-0000-0000-0000-000000000000",
            },
            {
              name: "§a高性能代理服务器",
              id: "00000000-0000-0000-0000-000000000001",
            },
          ],
        },
        description: {
          text: "§6§lGeofront Proxy §r\n§7简单代理示例",
        },
        favicon:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      };

      return motd;
    });

    // 启动监听器
    const { code, listenerId } = geofront.listen(PROXY_HOST, PROXY_PORT);
    if (code === 0) {
      console.log(
        `✓ 代理服务器已启动: ${PROXY_HOST}:${PROXY_PORT} (ID: ${listenerId})`
      );
      console.log(`🎯 将转发到: ${BACKEND_HOST}:${BACKEND_PORT}`);
      console.log("");
      console.log("按 Ctrl+C 停止服务器");
    } else {
      throw new Error(`启动监听器失败: code ${code}`);
    }

    // 优雅关闭
    process.on("SIGINT", async () => {
      console.log("\n🛑 正在关闭...");
      await geofront.shutdown();
      console.log("✓ 已关闭");
      process.exit(0);
    });

    // 保持运行
    await new Promise(() => {});
  } catch (error) {
    console.error("❌ 启动失败:", error);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}

export { main };
