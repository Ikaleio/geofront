/**
 * Hypixel 代理示例
 *
 * 这个示例展示如何使用 Geofront 创建一个 Hypixel 代理服务器，
 * 包含路由和 MOTD 功能。
 *
 * 运行方式：
 * ```bash
 * bun run example/hypixel.ts
 * ```
 *
 * 然后在 Minecraft 客户端中连接到 localhost:32768
 */

import { Geofront } from "../src/geofront";
import type { MotdResult } from "../src/motd";

// 配置
const PROXY_HOST = "0.0.0.0";
const PROXY_PORT = 32768;
const HYPIXEL_HOST = "mc.hypixel.net";
const HYPIXEL_PORT = 25565;

async function main() {
  console.log("🌍 启动 Geofront Hypixel 代理示例");
  console.log("=".repeat(50));

  const geofront = new Geofront();

  try {
    // 初始化 Geofront
    await geofront.initialize();
    console.log("✓ Geofront 初始化完成");

    // 设置路由回调
    geofront.setRouter((ip, host, player, protocol) => {
      console.log(
        `[Router] 新连接: ${player}@${ip} -> ${host} (协议: ${protocol})`
      );

      // 将所有连接路由到 Hypixel
      return {
        remoteHost: HYPIXEL_HOST,
        remotePort: HYPIXEL_PORT,
        rewriteHost: HYPIXEL_HOST, // 重写主机名以确保正确路由
      };
    });
    console.log("✓ 路由回调已设置");

    // 设置 MOTD 回调
    // 注意：MOTD 回调在客户端请求服务器状态时触发（服务器列表显示）
    geofront.setMotdCallback((ip, host, protocol) => {
      console.log(`[MOTD] 状态请求: ${ip} -> ${host} (协议: ${protocol})`);

      const motd: MotdResult = {
        version: {
          name: "Geofront -> Hypixel",
          protocol: protocol,
        },
        players: {
          max: 100000,
          online: "auto", // 自动获取在线玩家数
          sample: [
            "§6Geofront Proxy",
            "§aMade by Ikaleio",
            "§7Built with Rust + TypeScript",
          ],
        },
        description: {
          text: "§6§lGeofront Proxy §r§7-> §b§lHypixel Network\n§7高性能 Minecraft 代理服务器",
        },
      };
      return motd;
    });
    console.log("✓ MOTD 回调已设置");

    // 设置断开连接回调
    geofront.setDisconnectionCallback((connId) => {
      console.log(`🔌 连接 ${connId} 已断开`);
    });

    // 启动监听器
    await geofront.listen(PROXY_HOST, PROXY_PORT);
    console.log(`✓ 代理服务器已启动: ${PROXY_HOST}:${PROXY_PORT}`);

    console.log("");
    console.log("🎮 代理服务器运行中！");
    console.log(`📍 在 Minecraft 客户端中连接到: localhost:${PROXY_PORT}`);
    console.log("🎯 所有连接将被转发到 Hypixel Network");
    console.log("📊 MOTD 将显示自定义信息");
    console.log("");
    console.log("按 Ctrl+C 停止服务器");

    // 优雅关闭处理
    const shutdown = async () => {
      console.log("");
      console.log("🛑 正在关闭代理服务器...");

      try {
        await geofront.shutdown();
        console.log("✓ 代理服务器已安全关闭");
      } catch (err) {
        console.error("❌ 关闭时出错:", err);
      }

      process.exit(0);
    };

    // 监听终止信号
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // 保持进程运行
    await new Promise(() => {}); // 永远等待
  } catch (error) {
    console.error("❌ 启动失败:", error);
    process.exit(1);
  }
}

// 启动示例
if (import.meta.main) {
  main().catch((error) => {
    console.error("❌ 未处理的错误:", error);
    process.exit(1);
  });
}

export { main };
