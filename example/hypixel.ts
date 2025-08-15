/**
 * Hypixel 代理示例 - 简化版本
 *
 * 这个示例展示如何使用 Geofront API 创建一个简单的 Hypixel 代理，
 * 包含基本的路由、MOTD 和连接管理功能。
 *
 * 运行方式：
 * ```bash
 * bun dev example/hypixel.ts  # 开发模式
 * bun run example/hypixel.ts  # 生产模式
 * ```
 */

import { Geofront, type RouteContext, type MotdContext } from '../src/geofront'

// 配置
const PROXY_HOST = '0.0.0.0'
const PROXY_PORT = 32768
const HYPIXEL_HOST = 'mc.hypixel.net'
const HYPIXEL_PORT = 25565

async function main() {
	console.log('🚀 启动 Geofront Hypixel 代理')
	console.log('='.repeat(40))

	// 创建代理实例
	const proxy = Geofront.createProxy()
	console.log('✓ 代理实例已创建')

	// 设置路由器 - 将所有连接路由到 Hypixel
	proxy.setRouter((context: RouteContext) => {
		console.log(`[路由] ${context.username}@${context.ip} -> Hypixel`)

		// 简单的连接数限制
		const playerConnections = proxy.getConnectionsByPlayer(context.username)
		if (playerConnections.length >= 3) {
			return Geofront.disconnect('§c你已有太多连接，请先断开其他连接')
		}

		// 路由到 Hypixel
		return {
			target: {
				host: HYPIXEL_HOST,
				port: HYPIXEL_PORT
			},
			rewrite: {
				host: HYPIXEL_HOST // 重写握手包中的主机名
			}
		}
	})

	// 设置 MOTD - 显示简单的服务器信息
	proxy.setMotdProvider((context: MotdContext) => {
		const onlineCount = proxy.getConnectionCount()
		const playerCount = proxy.getPlayerCount()

		return {
			version: {
				name: 'Geofront',
				protocol: context.protocol
			},
			players: {
				max: 100000,
				online: 50000 + Math.floor(Math.random() * 10000), // 模拟 Hypixel 在线人数
				sample: [
					'§6§lHypixel 加速代理',
					`§a当前用户: §6${onlineCount} 人`,
					'§b低延迟稳定连接'
				]
			},
			description: {
				text: '§6§lHYPIXEL 加速代理\n§7Geofront Example'
			}
		}
	})

	// 设置事件处理器
	proxy.setEventHandlers({
		onConnectionEstablished: connection => {
			console.log(`✅ [连接] ${connection.player}@${connection.ip}`)
		},

		onConnectionClosed: (connection, info) => {
			const metrics = connection.getMetrics()
			const duration = connection.getDurationString()
			const totalTraffic =
				(metrics.bytesSent + metrics.bytesReceived) / 1024 / 1024

			console.log(
				`❌ [断开] ${
					info.player
				} | 时长: ${duration} | 流量: ${totalTraffic.toFixed(2)}MB`
			)
		},

		onError: error => {
			console.error(`🚨 [错误] ${error.message}`)
		}
	})

	// 启动代理
	const listener = await proxy.listen({
		host: PROXY_HOST,
		port: PROXY_PORT,
		proxyProtocol: 'none'
	})

	console.log(
		`✅ Hypixel 代理已启动: ${listener.config.host}:${listener.config.port}`
	)
	console.log(`🎯 目标服务器: ${HYPIXEL_HOST}:${HYPIXEL_PORT}`)
	console.log('🎮 现在可以连接到代理服务器了！')
	console.log('按 Ctrl+C 停止服务器')

	// 简单的状态输出
	setInterval(() => {
		const metrics = proxy.getMetrics()
		const playerList = proxy.getActivePlayerList()

		if (metrics.connections.active > 0) {
			console.log(
				`📊 活跃连接: ${metrics.connections.active} | 玩家: ${playerList.length}`
			)
			if (playerList.length > 0) {
				console.log(
					`   在线玩家: ${playerList.slice(0, 5).join(', ')}${
						playerList.length > 5 ? '...' : ''
					}`
				)
			}
		}
	}, 30000) // 每30秒输出一次状态

	// 优雅关闭
	process.on('SIGINT', async () => {
		console.log('\n🛑 正在关闭代理...')

		const finalMetrics = proxy.getMetrics()
		if (finalMetrics.connections.active > 0) {
			console.log(
				`📊 关闭时统计: ${finalMetrics.connections.active} 个活跃连接`
			)
			await proxy.disconnectAll('§e代理服务器正在关闭，请稍后重新连接')
		}

		await proxy.shutdown()
		console.log('✅ 代理已关闭')
		process.exit(0)
	})

	// 保持运行
	await new Promise(() => {})
}

// 错误处理
main().catch(error => {
	console.error('❌ 启动失败:', error)
	process.exit(1)
})

export { main }
