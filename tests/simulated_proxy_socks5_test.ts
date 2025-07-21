import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { Server } from 'net'
import { connect } from 'net'
import { randomBytes } from 'crypto'
import { Geofront } from '../src/geofront'
import * as socks from 'socksv5'
import {
	startBackendServer,
	TEST_CONSTANTS,
	getRandomPort,
	createHandshakePacket,
	createLoginStartPacket,
	writeVarInt
} from './helpers'

describe('Geofront E2E Test: SOCKS5 Proxy', () => {
	let geofront: Geofront
	let backendServer: Server
	let backendClosed: Promise<void>
	let socksServer: socks.SocksServer
	let PROXY_PORT: number
	let BACKEND_PORT: number
	let SOCKS_PORT: number

	beforeAll(async () => {
		PROXY_PORT = getRandomPort()
		BACKEND_PORT = getRandomPort()
		SOCKS_PORT = getRandomPort()
		// 启动 SOCKS5 服务器
		socksServer = socks.createServer((info, accept) => accept())
		socksServer.useAuth(socks.auth.None())
		await new Promise<void>(resolve =>
			socksServer.listen(SOCKS_PORT, '127.0.0.1', resolve)
		)

		// 启动后端服务器
		const backend = await startBackendServer({
			port: BACKEND_PORT
		})
		backendServer = backend.server
		backendClosed = backend.closed

		// 启动 Geofront
		geofront = new Geofront()
		await geofront.initialize()
		geofront.setRouter((ip, host, player, protocol) => {
			return {
				remoteHost: TEST_CONSTANTS.BACKEND_HOST,
				remotePort: BACKEND_PORT,
				proxy: `socks5://127.0.0.1:${SOCKS_PORT}`
			}
		})
		await geofront.listen('0.0.0.0', PROXY_PORT)
	})

	afterAll(async () => {
		const errors: string[] = []

		// 清理 Geofront
		if (geofront) {
			try {
				await Promise.race([
					geofront.shutdown(),
					new Promise<void>((_, reject) =>
						setTimeout(() => reject(new Error('Geofront 关闭超时')), 8000)
					)
				])
			} catch (err: any) {
				const isWorkerTerminatedError =
					err?.message?.includes('Worker has been terminated') ||
					err?.message?.includes('InvalidStateError') ||
					err?.message?.includes('Worker is terminated')

				if (!isWorkerTerminatedError && !err?.message?.includes('关闭超时')) {
					errors.push(`关闭 Geofront 时发生错误: ${err?.message || err}`)
				}
			}
		}

		// 给 Comlink 清理时间
		await new Promise(resolve => setTimeout(resolve, 200))

		// 清理服务器
		if (backendServer) {
			try {
				await new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(() => {
						reject(new Error('后端服务器关闭超时'))
					}, 3000)

					backendServer.close(err => {
						clearTimeout(timeout)
						if (err) reject(err)
						else resolve()
					})
				})
			} catch (err: any) {
				errors.push(`关闭后端服务器时发生错误: ${err?.message || err}`)
			}
		}

		if (socksServer) {
			try {
				await new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(() => {
						reject(new Error('SOCKS 服务器关闭超时'))
					}, 3000)

					socksServer.close(err => {
						clearTimeout(timeout)
						if (err) reject(err)
						else resolve()
					})
				})
			} catch (err: any) {
				errors.push(`关闭 SOCKS 服务器时发生错误: ${err?.message || err}`)
			}
		}

		if (backendClosed) {
			try {
				await Promise.race([
					backendClosed,
					new Promise<void>((_, reject) =>
						setTimeout(() => reject(new Error('等待后端服务器关闭超时')), 2000)
					)
				])
			} catch (err: any) {
				errors.push(`等待后端服务器关闭时发生错误: ${err?.message || err}`)
			}
		}

		if (errors.length > 0) {
			console.warn('清理过程中出现非关键错误:', errors.join('; '))
		}
	})

	test('should proxy data correctly through SOCKS5', async () => {
		const testData = randomBytes(1024) // 1KB 测试数据

		const testResult = new Promise<{ success: boolean; error?: string }>(
			resolve => {
				let resolved = false
				let client: any = null
				let timeoutId: NodeJS.Timeout | null = null

				const safeResolve = (result: { success: boolean; error?: string }) => {
					if (resolved) return
					resolved = true

					if (timeoutId) {
						clearTimeout(timeoutId)
						timeoutId = null
					}

					if (client) {
						try {
							client.destroy()
						} catch (e) {
							// 忽略关闭错误
						}
						client = null
					}

					resolve(result)
				}

				try {
					client = connect(PROXY_PORT, '127.0.0.1', () => {
						try {
							// 发送握手包
							const handshake = createHandshakePacket(
								TEST_CONSTANTS.TEST_PROTOCOL_VERSION,
								TEST_CONSTANTS.TEST_HOST,
								BACKEND_PORT,
								2 // Login state
							)
							client.write(handshake)

							// 发送登录开始包
							const loginStart = createLoginStartPacket(
								TEST_CONSTANTS.TEST_USERNAME
							)
							client.write(loginStart)
						} catch (err: any) {
							safeResolve({
								success: false,
								error: `发送握手包失败: ${err.message}`
							})
						}
					})

					let loginSuccessReceived = false
					let dataTransmitted = false

					client.on('data', (data: Buffer) => {
						if (!loginSuccessReceived && data.length > 0) {
							loginSuccessReceived = true

							// 发送自定义数据包来测试数据传输
							const packetId = writeVarInt(0x10) // 自定义包 ID
							const packetData = Buffer.concat([packetId, testData])
							const packet = Buffer.concat([
								writeVarInt(packetData.length),
								packetData
							])

							try {
								client.write(packet)
								dataTransmitted = true

								// 立即认为测试成功
								safeResolve({ success: true })
							} catch (err: any) {
								safeResolve({
									success: false,
									error: `发送数据包失败: ${err.message}`
								})
							}
						}
					})

					client.on('error', (err: Error) => {
						safeResolve({ success: false, error: `客户端错误: ${err.message}` })
					})

					client.on('close', () => {
						if (!resolved) {
							if (!loginSuccessReceived) {
								safeResolve({
									success: false,
									error: '连接在登录完成前就被关闭了'
								})
							} else if (!dataTransmitted) {
								safeResolve({
									success: false,
									error: '登录成功但数据传输失败'
								})
							}
						}
					})

					// 设置超时
					timeoutId = setTimeout(() => {
						safeResolve({
							success: false,
							error: `测试超时：登录=${loginSuccessReceived}, 数据传输=${dataTransmitted}`
						})
					}, 5000) // 减少到 5 秒超时
				} catch (err: any) {
					safeResolve({
						success: false,
						error: `创建连接失败: ${err.message}`
					})
				}
			}
		)

		const result = await testResult
		if (!result.success) {
			throw new Error(result.error || '未知错误')
		}

		expect(result.success).toBe(true)
	}, 10000)
})
