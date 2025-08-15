/**
 * 简单代理示例 - 新 TypeScript 风格 API
 *
 * 这个示例展示如何使用新的 Geofront API 创建一个功能完整的代理服务器，
 * 演示连接管理、路由、MOTD 和事件处理功能。
 *
 * 运行方式：
 * ```bash
 * bun dev example/simple.ts  # 开发模式
 * bun run example/simple.ts  # 生产模式
 * ```
 */

import { Geofront, type RouteContext, type MotdContext, type Connection, type ConnectionInfo } from "../src/geofront"

// 配置
const PROXY_HOST = "0.0.0.0"
const PROXY_PORT = 25565
const BACKEND_HOST = "127.0.0.1"
const BACKEND_PORT = 25566

async function main() {
  console.log("🌍 启动 Geofront 简单代理示例 (新 API)")
  console.log("=".repeat(50))

  try {
    // 使用新的工厂方法创建代理
    const proxy = Geofront.createProxy()
    console.log("✓ Geofront 代理实例已创建")

    // ===== 自定义路由函数 =====
    const customRouter = (context: RouteContext) => {
      console.log(`[路由] ${context.username}@${context.ip} -> ${context.host} (协议: ${context.protocol})`)

      // 检查重复连接
      const existingConnections = proxy.getConnectionsByPlayer(context.username)
      if (existingConnections.length > 0) {
        console.log(`[警告] 玩家 ${context.username} 已有 ${existingConnections.length} 个连接`)
      }

      // 检查 IP 连接数
      const ipConnections = proxy.getConnectionsByIp(context.ip)
      if (ipConnections.length >= 3) {
        return Geofront.disconnect('§c此 IP 地址连接数过多，请稍后重试')
      }

      // 根据主机名进行路由
      if (context.host.toLowerCase().includes("example.com")) {
        return {
          target: {
            host: BACKEND_HOST,
            port: BACKEND_PORT
          }
        }
      }

      // 支持测试主机
      if (context.host.toLowerCase().includes("test")) {
        return {
          target: {
            host: "127.0.0.1",
            port: 25567
          }
        }
      }

      // 默认拒绝连接
      return Geofront.disconnect("§c未知的服务器地址！\n§7请使用 example.com 连接")
    }

    // ===== 自定义 MOTD 生成器 =====
    const customMotdProvider = (context: MotdContext) => {
      console.log(`[MOTD] 状态请求来自 ${context.ip} -> ${context.host}`)

      const onlineCount = proxy.getConnectionCount()
      const playerCount = proxy.getPlayerCount()
      const activePlayerList = proxy.getActivePlayerList()

      // 根据主机生成不同的 MOTD
      if (context.host.toLowerCase().includes("test")) {
        return {
          version: {
            name: "测试服务器",
            protocol: context.protocol
          },
          players: {
            max: 10,
            online: onlineCount,
            sample: [
              { name: "§e这是测试服务器", id: "00000000-0000-0000-0000-000000000000" },
              { name: "§7用于开发和测试", id: "00000000-0000-0000-0000-000000000001" }
            ]
          },
          description: {
            text: "§e§l测试服务器 §r\n§7开发和测试专用"
          }
        }
      }

      return {
        version: {
          name: "Geofront Proxy",
          protocol: context.protocol
        },
        players: {
          max: 100,
          online: onlineCount,
          sample: [
            { name: `§a在线连接: §6${onlineCount}`, id: "00000000-0000-0000-0000-000000000000" },
            { name: `§a玩家数量: §6${playerCount}`, id: "00000000-0000-0000-0000-000000000001" },
            { name: `§7来自: §b${context.ip}`, id: "00000000-0000-0000-0000-000000000002" },
            ...activePlayerList.slice(0, 2).map((player, index) => ({
              name: `§7${player}`,
              id: `00000000-0000-0000-0000-00000000000${index + 3}`
            }))
          ]
        },
        description: {
          text: `§6§lGeofront 代理服务器 §r\n§7在线: §a${onlineCount} §7玩家: §a${playerCount}`
        },
        favicon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
      }
    }

    // ===== 配置代理 =====
    proxy
      .setRouter(customRouter)
      .setMotdProvider(customMotdProvider)
      .setGlobalRateLimit(Geofront.rateLimit(10, 10)) // 10MB/s 上传下载
      .setEventHandlers({
        onConnectionEstablished: (connection: Connection) => {
          console.log(`✅ [连接建立]`)
          console.log(`   ID: ${connection.id}`)
          console.log(`   玩家: ${connection.player}`)
          console.log(`   IP: ${connection.ip}`)
          console.log(`   主机: ${connection.host}`)
          console.log(`   协议: ${connection.protocol}`)
          console.log(`   时间: ${connection.startAt.toISOString()}`)

          // 根据玩家名设置不同的限速
          if (connection.player.endsWith('_VIP')) {
            connection.setRateLimit(Geofront.rateLimit(20, 20)) // VIP 20MB/s
            console.log(`🌟 [VIP] 玩家 ${connection.player} 获得 VIP 速度`)
          } else if (connection.player.startsWith('admin_')) {
            connection.setRateLimit(Geofront.rateLimit(50, 50)) // 管理员 50MB/s
            console.log(`👑 [管理员] 玩家 ${connection.player} 获得管理员速度`)
          }
        },

        onConnectionClosed: (connection: Connection, info: ConnectionInfo) => {
          const metrics = connection.getMetrics()
          console.log(`❌ [连接关闭]`)
          console.log(`   ID: ${info.id}`)
          console.log(`   玩家: ${info.player}`)
          console.log(`   IP: ${info.ip}`)
          console.log(`   持续时间: ${connection.getDurationString()}`)
          console.log(`   流量: ↑${(metrics.bytesSent / 1024 / 1024).toFixed(2)}MB ↓${(metrics.bytesReceived / 1024 / 1024).toFixed(2)}MB`)

          // 记录长时间连接
          if (connection.getDuration() > 60 * 60 * 1000) { // 超过1小时
            console.log(`📊 [长连接] 玩家 ${info.player} 连接了 ${connection.getDurationString()}`)
          }
        },

        onListenerStarted: (listener) => {
          console.log(`🚀 [监听器启动] ${listener.config.host}:${listener.config.port} (ID: ${listener.id})`)
        },

        onListenerStopped: (listener) => {
          console.log(`🛑 [监听器停止] ID: ${listener.id}`)
        },

        onError: (error: Error) => {
          console.error(`🚨 [代理错误] ${error.message}`)
        }
      })

    // 启动监听器
    const listener = await proxy.listen({
      host: PROXY_HOST,
      port: PROXY_PORT,
      proxyProtocol: 'optional'
    })

    console.log(`✓ 代理服务器已启动: ${listener.config.host}:${listener.config.port}`)
    console.log(`🎯 将转发到: ${BACKEND_HOST}:${BACKEND_PORT}`)
    console.log("")

    // ===== 监控循环 =====
    const monitorInterval = setInterval(() => {
      const metrics = proxy.getMetrics()
      const connections = proxy.getConnections()
      const playerCount = proxy.getPlayerCount()
      const activePlayerList = proxy.getActivePlayerList()

      console.log('\n📊 === 服务器状态 ===')
      console.log(`连接数: ${metrics.connections.active} | 玩家数: ${playerCount}`)
      console.log(`总流量: ↑${(metrics.traffic.totalBytesSent / 1024 / 1024).toFixed(2)}MB ↓${(metrics.traffic.totalBytesReceived / 1024 / 1024).toFixed(2)}MB`)
      
      if (activePlayerList.length > 0) {
        console.log(`在线玩家: ${activePlayerList.join(', ')}`)
      }

      if (connections.length > 0) {
        console.log('\n🔗 === 连接详情 ===')
        connections.forEach(conn => {
          const connMetrics = conn.getMetrics()
          console.log(`  [${conn.id}] ${conn.player}@${conn.ip} -> ${conn.host}`)
          console.log(`       时长: ${conn.getDurationString()} | 流量: ↑${(connMetrics.bytesSent / 1024).toFixed(1)}KB ↓${(connMetrics.bytesReceived / 1024).toFixed(1)}KB`)
        })

        // ===== 自动管理策略 =====
        
        // 长时间无流量的连接
        connections.forEach(conn => {
          const connMetrics = conn.getMetrics()
          const duration = conn.getDuration()
          
          // 连接超过 5 分钟且流量小于 1KB (示例用短时间)
          if (duration > 5 * 60 * 1000 && (connMetrics.bytesSent + connMetrics.bytesReceived) < 1024) {
            console.log(`⚠️ [闲置连接] 检测到闲置连接: ${conn.player} (${conn.getDurationString()})`)
            // 在实际环境中可能会断开连接
            // conn.disconnect('§e由于长时间无活动，连接已断开')
          }
        })
      }
    }, 15000) // 每 15 秒检查一次

    console.log("🎮 代理服务器已就绪！")
    console.log("按 Ctrl+C 停止服务器")

    // ===== 优雅关闭 =====
    process.on("SIGINT", async () => {
      console.log("\n🛑 正在关闭代理...")
      
      clearInterval(monitorInterval)

      const connections = proxy.getConnections()
      if (connections.length > 0) {
        console.log(`📊 关闭时统计: ${connections.length} 个活跃连接`)
        connections.forEach(conn => {
          console.log(`  ${conn.player}@${conn.ip}: ${conn.getDurationString()}`)
        })
      }

      // 通知所有用户并断开连接
      const disconnectedCount = await proxy.disconnectAll('§e服务器正在重启，请稍后重新连接')
      console.log(`✅ 已断开 ${disconnectedCount} 个连接`)

      // 完全关闭代理
      await proxy.shutdown()
      console.log("✅ 代理已完全关闭")
      process.exit(0)
    })

    // 保持运行
    await new Promise(() => {})
  } catch (error) {
    console.error("❌ 启动失败:", error)
    process.exit(1)
  }
}

if (import.meta.main) {
  main()
}

export { main }