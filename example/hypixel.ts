/**
 * Hypixel 代理示例 - 新 TypeScript 风格 API
 *
 * 这个示例展示如何使用新的 Geofront API 创建一个 Hypixel 加速代理，
 * 演示高级路由、动态 MOTD、连接管理和性能监控功能。
 *
 * 运行方式：
 * ```bash
 * bun dev example/hypixel.ts  # 开发模式
 * bun run example/hypixel.ts  # 生产模式
 * ```
 */

import { Geofront, type RouteContext, type MotdContext, type Connection, type ConnectionInfo } from "../src/geofront"

// 配置
const PROXY_HOST = "0.0.0.0"
const PROXY_PORT = 25565
const HYPIXEL_HOST = "mc.hypixel.net"
const HYPIXEL_PORT = 25565

// 可选的上游代理配置
const UPSTREAM_PROXY = "socks5://127.0.0.1:1080" // 如果需要的话

async function main() {
  console.log("🚀 启动 Geofront Hypixel 代理示例 (新 API)")
  console.log("=".repeat(50))

  try {
    // 创建代理实例
    const proxy = Geofront.createProxy()
    console.log("✓ Geofront 代理实例已创建")

    // ===== 高级路由函数 =====
    const hypixelRouter = async (context: RouteContext) => {
      console.log(`[路由] ${context.username}@${context.ip} -> ${context.host} (协议: ${context.protocol})`)

      // 检查玩家连接限制
      const existingConnections = proxy.getConnectionsByPlayer(context.username)
      if (existingConnections.length >= 2) {
        console.log(`[限制] 玩家 ${context.username} 已有 ${existingConnections.length} 个连接，拒绝新连接`)
        return Geofront.disconnect('§c你已有多个连接，请先断开其他连接')
      }

      // IP 连接数限制
      const ipConnections = proxy.getConnectionsByIp(context.ip)
      if (ipConnections.length >= 5) {
        console.log(`[限制] IP ${context.ip} 连接数过多: ${ipConnections.length}`)
        return Geofront.disconnect('§c此 IP 地址连接数过多，请稍后重试')
      }

      // 检查协议版本兼容性
      if (context.protocol < 754) { // 1.16.5 以下
        console.log(`[版本] 玩家 ${context.username} 使用旧版本协议: ${context.protocol}`)
        return Geofront.disconnect('§c请使用 Minecraft 1.16.5 或更新版本')
      }

      // 封禁用户检查（示例）
      const bannedUsers = ['griefer123', 'cheater456']
      if (bannedUsers.includes(context.username.toLowerCase())) {
        console.log(`[封禁] 拒绝被封禁用户: ${context.username}`)
        return Geofront.disconnect('§c你已被封禁，无法使用代理服务')
      }

      // VIP 用户检测
      const isVip = context.username.endsWith('_VIP') || context.username.startsWith('premium_')
      
      // 路由到 Hypixel，VIP 用户使用上游代理加速
      return {
        target: {
          host: HYPIXEL_HOST,
          port: HYPIXEL_PORT
        },
        rewrite: {
          host: HYPIXEL_HOST // 重写握手包中的主机名，绕过 Hypixel 直连检测
        },
        proxy: isVip ? {
          url: UPSTREAM_PROXY,
          protocol: 1 as const
        } : undefined
      }
    }

    // ===== 动态 MOTD 生成器 =====
    const hypixelMotdProvider = async (context: MotdContext) => {
      console.log(`[MOTD] 状态查询来自 ${context.ip}`)

      const onlineCount = proxy.getConnectionCount()
      const playerCount = proxy.getPlayerCount()
      const now = new Date()
      const hour = now.getHours()

      // 模拟 Hypixel 在线人数
      const hypixelOnline = 45000 + Math.floor(Math.random() * 15000)
      
      // 根据时间段显示不同信息
      let timeMessage = ''
      let timeColor = '§a'
      
      if (hour >= 6 && hour < 12) {
        timeMessage = '早上好'
        timeColor = '§e'
      } else if (hour >= 12 && hour < 18) {
        timeMessage = '下午好'
        timeColor = '§6'
      } else if (hour >= 18 && hour < 22) {
        timeMessage = '晚上好'
        timeColor = '§d'
      } else {
        timeMessage = '深夜了'
        timeColor = '§8'
      }

      // 服务器负载状态（模拟）
      const load = Math.random()
      let loadStatus = ''
      let loadColor = '§a'
      
      if (load < 0.3) {
        loadStatus = '流畅'
        loadColor = '§a'
      } else if (load < 0.7) {
        loadStatus = '正常'
        loadColor = '§e'
      } else {
        loadStatus = '繁忙'
        loadColor = '§c'
      }

      return {
        version: {
          name: "Hypixel 加速代理",
          protocol: context.protocol
        },
        players: {
          max: 100000,
          online: hypixelOnline,
          sample: [
            { name: `${timeColor}${timeMessage}！`, id: "00000000-0000-0000-0000-000000000000" },
            { name: `§6§lHypixel 加速服务器`, id: "00000000-0000-0000-0000-000000000001" },
            { name: `§7代理状态: ${loadColor}${loadStatus}`, id: "00000000-0000-0000-0000-000000000002" },
            { name: `§7当前用户: §b${onlineCount} §7人`, id: "00000000-0000-0000-0000-000000000003" },
            { name: `§7Hypixel 在线: §a${hypixelOnline.toLocaleString()}`, id: "00000000-0000-0000-0000-000000000004" },
            { name: `§a§l低延迟 §8| §b§l稳定连接`, id: "00000000-0000-0000-0000-000000000005" }
          ]
        },
        description: {
          text: `§6§lHYPIXEL 加速代理 §r\n§7${timeColor}${timeMessage}§r§7，代理状态：${loadColor}${loadStatus}`
        },
        favicon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
      }
    }

    // ===== 配置代理 =====
    proxy
      .setRouter(hypixelRouter)
      .setMotdProvider(hypixelMotdProvider)
      .setGlobalRateLimit(Geofront.rateLimit(50, 50)) // 50MB/s 默认速度
      .setEventHandlers({
        onConnectionEstablished: (connection: Connection) => {
          console.log(`✅ [连接建立] ${connection.player}@${connection.ip}`)
          console.log(`   ID: ${connection.id} | 主机: ${connection.host} | 协议: ${connection.protocol}`)
          
          // 根据用户类型设置不同的限速策略
          if (connection.player.endsWith('_VIP') || connection.player.startsWith('premium_')) {
            connection.setRateLimit(Geofront.rateLimit(100, 100)) // VIP 100MB/s
            console.log(`🌟 [VIP] ${connection.player} 获得 VIP 速度 (100MB/s)`)
          } else if (connection.player.startsWith('admin_')) {
            connection.setRateLimit(Geofront.rateLimit(200, 200)) // 管理员 200MB/s
            console.log(`👑 [管理员] ${connection.player} 获得管理员速度 (200MB/s)`)
          } else {
            connection.setRateLimit(Geofront.rateLimit(20, 20)) // 普通用户 20MB/s
            console.log(`👤 [普通] ${connection.player} 使用标准速度 (20MB/s)`)
          }

          // 记录连接统计
          const totalConnections = proxy.getConnectionCount()
          const uniquePlayers = proxy.getPlayerCount()
          console.log(`📊 [统计] 总连接: ${totalConnections} | 不同玩家: ${uniquePlayers}`)
        },

        onConnectionClosed: (connection: Connection, info: ConnectionInfo) => {
          const metrics = connection.getMetrics()
          const duration = connection.getDuration()
          const totalTraffic = metrics.bytesSent + metrics.bytesReceived
          
          console.log(`❌ [连接关闭] ${info.player}@${info.ip}`)
          console.log(`   持续时间: ${connection.getDurationString()}`)
          console.log(`   流量统计: ↑${(metrics.bytesSent / 1024 / 1024).toFixed(2)}MB ↓${(metrics.bytesReceived / 1024 / 1024).toFixed(2)}MB`)
          
          // 记录特殊情况
          if (duration > 2 * 60 * 60 * 1000) { // 超过2小时
            console.log(`🕐 [长连接] ${info.player} 连接了 ${connection.getDurationString()}`)
          }
          
          if (totalTraffic > 500 * 1024 * 1024) { // 超过 500MB
            console.log(`📈 [大流量] ${info.player} 使用了 ${(totalTraffic / 1024 / 1024).toFixed(2)}MB 流量`)
          }
        },

        onListenerStarted: (listener) => {
          console.log(`🚀 [监听器] Hypixel 代理已启动`)
          console.log(`   地址: ${listener.config.host}:${listener.config.port}`)
          console.log(`   代理协议: ${listener.config.proxyProtocol}`)
        },

        onError: (error: Error) => {
          console.error(`🚨 [错误] ${error.message}`)
        }
      })

    // 启动监听器
    const listener = await proxy.listen({
      host: PROXY_HOST,
      port: PROXY_PORT,
      proxyProtocol: 'optional' // 支持 Proxy Protocol
    })

    console.log(`✓ Hypixel 代理已启动: ${listener.config.host}:${listener.config.port}`)
    console.log(`🎯 目标服务器: ${HYPIXEL_HOST}:${HYPIXEL_PORT}`)
    console.log("")

    // ===== 高级监控和管理 =====
    const monitorInterval = setInterval(() => {
      const metrics = proxy.getMetrics()
      const connections = proxy.getConnections()
      const playerCount = proxy.getPlayerCount()
      const activePlayerList = proxy.getActivePlayerList()

      console.log('\n📊 === HYPIXEL 代理状态 ===')
      console.log(`连接统计: ${metrics.connections.active} 活跃 / ${metrics.connections.total} 总计`)
      console.log(`玩家统计: ${playerCount} 不同玩家`)
      console.log(`流量统计: ↑${(metrics.traffic.totalBytesSent / 1024 / 1024).toFixed(2)}MB ↓${(metrics.traffic.totalBytesReceived / 1024 / 1024).toFixed(2)}MB`)
      
      if (activePlayerList.length > 0) {
        console.log(`在线玩家: ${activePlayerList.slice(0, 10).join(', ')}${activePlayerList.length > 10 ? `... (+${activePlayerList.length - 10})` : ''}`)
      }

      if (connections.length > 0) {
        console.log('\n🔗 === 连接详情 ===')
        
        // 按流量排序显示前10个连接
        const sortedConnections = [...connections]
          .sort((a, b) => {
            const aTraffic = a.getMetrics().bytesSent + a.getMetrics().bytesReceived
            const bTraffic = b.getMetrics().bytesSent + b.getMetrics().bytesReceived
            return bTraffic - aTraffic
          })
          .slice(0, 10)

        sortedConnections.forEach((conn, index) => {
          const connMetrics = conn.getMetrics()
          const totalTraffic = connMetrics.bytesSent + connMetrics.bytesReceived
          console.log(`  ${index + 1}. [${conn.id}] ${conn.player}@${conn.ip}`)
          console.log(`      时长: ${conn.getDurationString()} | 流量: ${(totalTraffic / 1024 / 1024).toFixed(2)}MB`)
        })

        // ===== 自动管理策略 =====
        
        // 1. 检测可疑的大流量连接
        connections.forEach(conn => {
          const connMetrics = conn.getMetrics()
          const totalTraffic = connMetrics.bytesSent + connMetrics.bytesReceived
          const duration = conn.getDuration()
          
          // 短时间内大流量（可能的攻击或异常行为）
          if (duration < 10 * 60 * 1000 && totalTraffic > 100 * 1024 * 1024) { // 10分钟内超过100MB
            console.log(`⚠️ [异常流量] 检测到异常大流量连接: ${conn.player} (${(totalTraffic / 1024 / 1024).toFixed(2)}MB in ${conn.getDurationString()})`)
            // 可以选择限速或断开
            conn.setRateLimit(Geofront.rateLimit(1, 1)) // 限制到 1MB/s
          }
          
          // 超长时间无流量连接
          if (duration > 30 * 60 * 1000 && totalTraffic < 1024) { // 30分钟无流量
            console.log(`😴 [闲置连接] 检测到长期闲置连接: ${conn.player} (${conn.getDurationString()})`)
            // 在生产环境中可以断开
            // conn.disconnect('§e由于长时间无活动，连接已自动断开')
          }
        })

        // 2. IP 连接数管理
        const ipConnectionCount = new Map<string, Connection[]>()
        connections.forEach(conn => {
          const existing = ipConnectionCount.get(conn.ip) || []
          existing.push(conn)
          ipConnectionCount.set(conn.ip, existing)
        })

        ipConnectionCount.forEach((conns, ip) => {
          if (conns.length > 8) { // 单个 IP 超过 8 个连接
            console.log(`🚨 [IP 警告] IP ${ip} 有 ${conns.length} 个连接，可能需要注意`)
            // 可以限制最旧的连接
            const oldestConn = conns.sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0]
            // oldestConn.disconnect('§c单个 IP 连接数过多')
          }
        })

        // 3. 性能统计
        const avgDuration = connections.reduce((sum, conn) => sum + conn.getDuration(), 0) / connections.length
        const totalTraffic = connections.reduce((sum, conn) => {
          const metrics = conn.getMetrics()
          return sum + metrics.bytesSent + metrics.bytesReceived
        }, 0)
        
        console.log(`\n📈 === 性能指标 ===`)
        console.log(`平均连接时长: ${Math.floor(avgDuration / 1000 / 60)}分钟`)
        console.log(`总活跃流量: ${(totalTraffic / 1024 / 1024).toFixed(2)}MB`)
        console.log(`平均每连接: ${(totalTraffic / connections.length / 1024 / 1024).toFixed(2)}MB`)
      }
    }, 20000) // 每 20 秒监控一次

    console.log("🎮 Hypixel 代理服务器已就绪！")
    console.log("🔗 玩家现在可以通过此代理连接到 Hypixel")
    console.log("按 Ctrl+C 停止服务器")

    // ===== 优雅关闭 =====
    process.on("SIGINT", async () => {
      console.log("\n🛑 正在关闭 Hypixel 代理...")
      
      clearInterval(monitorInterval)

      const connections = proxy.getConnections()
      if (connections.length > 0) {
        console.log(`📊 关闭时统计: ${connections.length} 个活跃连接`)
        
        // 显示连接汇总
        const totalTraffic = connections.reduce((sum, conn) => {
          const metrics = conn.getMetrics()
          return sum + metrics.bytesSent + metrics.bytesReceived
        }, 0)
        
        console.log(`总流量: ${(totalTraffic / 1024 / 1024).toFixed(2)}MB`)
        console.log(`玩家列表: ${proxy.getActivePlayerList().join(', ')}`)
      }

      // 通知所有用户并断开连接
      const disconnectedCount = await proxy.disconnectAll('§e代理服务器正在维护，请稍后重新连接')
      console.log(`✅ 已断开 ${disconnectedCount} 个连接`)

      // 完全关闭代理
      await proxy.shutdown()
      console.log("✅ Hypixel 代理已完全关闭")
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