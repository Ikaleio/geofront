# 🌍 Geofront

[![npm version](https://img.shields.io/npm/v/geofront-ts.svg)](https://www.npmjs.com/package/geofront-ts)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Ikaleio/geofront/release.yml)](https://github.com/Ikaleio/geofront/actions)
[![License](https://img.shields.io/npm/l/geofront-ts.svg)](./LICENSE)

**Geofront 是一个为 Minecraft 设计的高性能、可编程的入口代理核心，采用 Rust 编写，并通过 Bun FFI 与 TypeScript/JavaScript 无缝集成。**

它就像一个用于 Minecraft 的 `nginx`，允许你用单一的 IP 和端口，根据玩家连接时使用的服务器地址（`host`），将他们智能地路由到不同的后端 Minecraft 服务器。

📄 文档：[geofront.ikale.io](https://geofront.ikale.io)

---

## ✨ 核心特性

- **高性能网络核心**: 基于 Rust 和 Tokio 构建，拥有极低的的 CPU 和内存占用。
- **现代 TypeScript API**: 全新设计的函数式 API，提供完整的类型安全和丰富的连接管理功能。
- **智能连接管理**: 在 JavaScript 侧维护完整的连接信息，支持按玩家、IP、主机等条件查询和管理。
- **动态路由**: 通过简单的 JavaScript 函数，根据玩家 IP、用户名、连接主机等信息实现复杂的路由逻辑。
- **零拷贝转发**: 在 Linux 系统上自动启用 `splice`，在内核层面直接转发数据，实现极致性能。
- **动态速率限制**: 支持令牌桶算法，可对每个连接设置动态的上传/下载速率和突发流量。
- **上游代理支持**: 支持通过 SOCKS5 代理连接到后端服务器。
- **丰富的事件系统**: 完整的连接生命周期事件，包括建立、关闭、错误等。
- **实时流量统计**: 提供全局和单个连接的实时流量统计和性能监控。
- **Bun FFI 集成**: 利用 Bun 的 FFI 功能，提供比 WASM 或 N-API 更高效、更简单的原生调用。

## 📦 安装

```bash
bun install geofront-ts
```

## 🚀 快速上手

### 简单代理示例

下面是一个简单例子，演示如何创建一个功能完整的代理服务器：

```typescript
// server.ts
import { Geofront, type RouteContext, type MotdContext } from 'geofront-ts'

async function main() {
	// 使用新的工厂方法创建代理
	const proxy = Geofront.createProxy()

	// 设置路由函数
	proxy.setRouter((context: RouteContext) => {
		console.log(`[路由] ${context.username}@${context.ip} -> ${context.host}`)

		// 检查连接限制
		const existingConnections = proxy.getConnectionsByPlayer(context.username)
		if (existingConnections.length >= 2) {
			return Geofront.disconnect('§c你已有多个连接，请先断开其他连接')
		}

		// 根据主机名路由
		if (context.host.toLowerCase().includes('example.com')) {
			return {
				target: {
					host: '127.0.0.1',
					port: 25565
				}
			}
		}

		return Geofront.disconnect(
			'§c未知的服务器地址！\n§7请使用 example.com 连接'
		)
	})

	// 设置 MOTD 生成器
	proxy.setMotdProvider((context: MotdContext) => {
		const onlineCount = proxy.getConnectionCount()
		const playerCount = proxy.getPlayerCount()

		return {
			version: { name: 'Geofront Proxy', protocol: context.protocol },
			players: {
				max: 100,
				online: onlineCount,
				sample: [`§a在线连接: §6${onlineCount}`, `§a玩家数量: §6${playerCount}`]
			},
			description: {
				text: `§6§lGeofront 代理服务器 §r\n§7在线: §a${onlineCount} §7玩家: §a${playerCount}`
			}
		}
	})

	// 设置事件处理器
	proxy.setEventHandlers({
		onConnectionEstablished: connection => {
			console.log(`✅ [连接建立] ${connection.player}@${connection.ip}`)

			// 根据用户设置不同限速
			if (connection.player.endsWith('_VIP')) {
				connection.setRateLimit(Geofront.rateLimit(50, 50)) // 50MB/s
				console.log(`🌟 [VIP] ${connection.player} 获得 VIP 速度`)
			}
			// ⚠️ 生产注意：以上通过玩家名后缀 _VIP 判定仅为演示。
			// 实际应：调用外部权限/会员 API -> 缓存 (Map + TTL) -> 设置限速。
			// 避免被用户伪造名字提升权限。
		},

		onConnectionClosed: (connection, info) => {
			const metrics = connection.getMetrics()
			console.log(
				`❌ [连接关闭] ${
					info.player
				} 持续时间: ${connection.getDurationString()}`
			)
			console.log(
				`   流量: ↑${(metrics.bytesSent / 1024 / 1024).toFixed(2)}MB ↓${(
					metrics.bytesReceived /
					1024 /
					1024
				).toFixed(2)}MB`
			)
		},

		onError: error => {
			console.error(`🚨 [错误] ${error.message}`)
		}
	})

	// 设置全局速率限制
	proxy.setGlobalRateLimit(Geofront.rateLimit(10, 10)) // 10MB/s

	// 启动监听器
	const listener = await proxy.listen({
		host: '0.0.0.0',
		port: 25565,
		proxyProtocol: 'optional'
	})

	console.log(`✅ 代理已启动: ${listener.config.host}:${listener.config.port}`)

	// 监控循环
	setInterval(() => {
		const metrics = proxy.getMetrics()
		const connections = proxy.getConnections()

		console.log(
			`📊 活跃连接: ${
				metrics.connections.active
			}, 玩家: ${proxy.getPlayerCount()}`
		)

		// 连接管理示例
		connections.forEach(conn => {
			const connMetrics = conn.getMetrics()
			const totalTraffic = connMetrics.bytesSent + connMetrics.bytesReceived

			// 限制大流量连接
			if (totalTraffic > 100 * 1024 * 1024) {
				// 超过 100MB
				conn.setRateLimit(Geofront.rateLimit(1, 1)) // 限制到 1MB/s
			}
		})
	}, 10000)

	// 优雅关闭
	process.on('SIGINT', async () => {
		console.log('\n🛑 正在关闭代理...')
		await proxy.disconnectAll('§e服务器正在重启')
		await proxy.shutdown()
		process.exit(0)
	})
}

main().catch(console.error)
```

## 🤝 贡献

欢迎提交 Pull Requests 和 Issues！

## 📄 许可证

MIT License - 详见 [LICENSE](./LICENSE) 文件。
