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

import { Geofront } from '../src/geofront'
import type { MotdResult } from '../src/motd'
import { buildMotd } from '../src/motd'

// 配置
const PROXY_HOST = '0.0.0.0'
const PROXY_PORT = 32768
const HYPIXEL_HOST = 'mc.hypixel.net'
const HYPIXEL_PORT = 25565

async function main() {
	console.log('🌍 启动 Geofront Hypixel 代理示例')
	console.log('='.repeat(50))

	const geofront = new Geofront()

	try {
		// 初始化 Geofront
		await geofront.initialize()
		console.log('✓ Geofront 初始化完成')

		// 设置路由回调
		geofront.setRouter((ip, host, player, protocol) => {
			console.log(
				`[Router] 新连接: ${player}@${ip} -> ${host} (协议: ${protocol})`
			)

			// 将所有连接路由到 Hypixel
			return {
				remoteHost: HYPIXEL_HOST,
				remotePort: HYPIXEL_PORT,
				rewriteHost: HYPIXEL_HOST // 重写主机名以确保正确路由
			}
		})
		console.log('✓ 路由回调已设置')

		// 设置 MOTD 回调
		// 注意：MOTD 回调在客户端请求服务器状态时触发（服务器列表显示）
		geofront.setMotdCallback((ip, host, protocol) => {
			console.log(`[MOTD] 状态请求: ${ip} -> ${host} (协议: ${protocol})`)

			// 创建自定义 MOTD
			const motd: MotdResult = buildMotd(
				{
					version: {
						name: 'Geofront -> Hypixel',
						protocol: 'auto' // 自动使用客户端协议版本
					},
					players: {
						max: 100000,
						online: 'auto', // 这里会被实际在线玩家数替换（如果有的话）
						sample: [
							{
								name: '§6Geofront Proxy',
								id: '00000000-0000-0000-0000-000000000000'
							},
							{
								name: '§aMade by Ikaleio',
								id: '00000000-0000-0000-0000-000000000001'
							},
							{
								name: '§7Built with Rust + TypeScript',
								id: '00000000-0000-0000-0000-000000000002'
							}
						]
					},
					description: {
						text: '§6§lGeofront Proxy §r§7-> §b§lHypixel Network\n§7高性能 Minecraft 代理服务器'
					},
					favicon:
						'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAAC6aXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAMAUExURQAAAP///wAAAPDw8NDQ0KCgoHBwcEBAQBAQEICAgGBgYJCQkLCwsODg4PAwMIAwMGAwMKAwMOAwMEAwMJAwMLAwMOAwQIAwQGAwQKAwQOAwQEAwQLAwQOAwUIAwUIAwYGAwYKAwYOAwYEAwYLAwYOAwcIAwcGAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcAAAAO3Q8MAAAA/3RSTlMAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl9gYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1+f4CBgoOEhYaHiImKi4yNjo+QkZKTlJWWl5iZmpucnZ6foKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr/AwcLDxMXGx8jJysvMzc7P0NHS09TV1tfY2drb3N3e3+Dh4uPk5ebn6Onq6+zt7u/w8fLz9PX29/j5+vv8/f7rCNvbAAAABklEQVRYw+2X'
				},
				0,
				protocol
			) // 0 玩家在线（因为这是代理服务器）

			return motd
		})
		console.log('✓ MOTD 回调已设置')

		// 启动监听器
		await geofront.listen(PROXY_HOST, PROXY_PORT)
		console.log(`✓ 代理服务器已启动: ${PROXY_HOST}:${PROXY_PORT}`)

		console.log('')
		console.log('🎮 代理服务器运行中！')
		console.log(`📍 在 Minecraft 客户端中连接到: localhost:${PROXY_PORT}`)
		console.log('🎯 所有连接将被转发到 Hypixel Network')
		console.log('📊 MOTD 将显示自定义信息')
		console.log('')
		console.log('按 Ctrl+C 停止服务器')

		// 优雅关闭处理
		const shutdown = async () => {
			console.log('')
			console.log('🛑 正在关闭代理服务器...')

			try {
				await geofront.shutdown()
				console.log('✓ 代理服务器已安全关闭')
			} catch (err) {
				console.error('❌ 关闭时出错:', err)
			}

			process.exit(0)
		}

		// 监听终止信号
		process.on('SIGINT', shutdown)
		process.on('SIGTERM', shutdown)

		// 保持进程运行
		await new Promise(() => {}) // 永远等待
	} catch (error) {
		console.error('❌ 启动失败:', error)
		process.exit(1)
	}
}

// 启动示例
if (import.meta.main) {
	main().catch(error => {
		console.error('❌ 未处理的错误:', error)
		process.exit(1)
	})
}

export { main }
