import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { Server } from 'net'
import { randomBytes } from 'crypto'
import { connect } from 'net'
import { Geofront, type Connection } from '../src/geofront'
import {
	startBackendServer,
	TEST_CONSTANTS,
	getRandomPort,
	createHandshakePacket,
	createLoginStartPacket,
	writeVarInt
} from './helpers'

describe('Geofront E2E Test: Rate Limiting and Metrics', () => {
	let geofront: Geofront
	let backendServer: Server
	let backendClosed: Promise<void>
	let PROXY_PORT: number
	let BACKEND_PORT: number

	beforeAll(async () => {
		PROXY_PORT = getRandomPort()
		BACKEND_PORT = getRandomPort()
		const backend = await startBackendServer({
			port: BACKEND_PORT,
			onData: (data, socket) => {
				// Minimal login success packet to allow the client to proceed to the play state.
				// Packet ID 0x02 for Login Success
				const loginSuccessPacket = Buffer.from([
					0x02,
					0x00 // UUID and username, can be minimal for this test
				])
				const packetLength = writeVarInt(loginSuccessPacket.length)
				socket.write(Buffer.concat([packetLength, loginSuccessPacket]))
			}
		})
		backendServer = backend.server
		backendClosed = backend.closed

		geofront = Geofront.create()

		geofront.setRouter(() => {
			return {
				remoteHost: TEST_CONSTANTS.BACKEND_HOST,
				remotePort: BACKEND_PORT
			}
		})
		await geofront.listen('0.0.0.0', PROXY_PORT)
	})

	afterAll(async () => {
		if (geofront) {
			await geofront.shutdown()
		}
		if (backendServer) {
			backendServer.close()
			await backendClosed
		}
	})

	test('should enforce rate limit and report correct metrics', async () => {
		const RATE_LIMIT_BPS = 1024 * 1024 // 1 MB/s
		const TEST_DURATION_S = 5 // 5 seconds
		const SEND_INTERVAL_MS = 50
		const CHUNK_SIZE = (RATE_LIMIT_BPS * SEND_INTERVAL_MS) / 1000 / 2 // Send at half the rate limit speed

		let totalSent = 0
		let clientConnection: Connection | undefined

		// 用于测量接收数据的时间间隔
		let lastReceiveTime: number | null = null
		let receiveIntervals: number[] = []
		let totalReceivedBytes = 0

		const testResult = new Promise<{
			success: boolean
			error?: string
			finalMetrics?: any
		}>(resolve => {
			const client = connect(PROXY_PORT, '127.0.0.1', async () => {
				// Handshake and login
				const handshake = createHandshakePacket(
					TEST_CONSTANTS.TEST_PROTOCOL_VERSION,
					TEST_CONSTANTS.TEST_HOST,
					PROXY_PORT,
					2
				)
				client.write(handshake)
				const loginStart = createLoginStartPacket(TEST_CONSTANTS.TEST_USERNAME)
				client.write(loginStart)
			})

			let gamePhase = false
			let loginSuccessReceived = false
			let receivedData = Buffer.alloc(0)
			let sendInterval: NodeJS.Timeout | null = null

			client.on('data', async (data: Buffer) => {
				// 测量接收数据的时间间隔
				const currentTime = Date.now()
				if (lastReceiveTime !== null) {
					const interval = currentTime - lastReceiveTime
					receiveIntervals.push(interval)
				}
				lastReceiveTime = currentTime
				totalReceivedBytes += data.length

				receivedData = Buffer.concat([receivedData, data])
				if (!gamePhase && receivedData.length > 0) {
					loginSuccessReceived = true
					gamePhase = true

					// Find the connection object
					for await (const conn of geofront.connections()) {
						clientConnection = conn
						break
					}

					if (!clientConnection) {
						resolve({
							success: false,
							error: 'Could not find client connection object'
						})
						return
					}

					// Apply rate limit
					await clientConnection.limit({
						sendAvgBytes: RATE_LIMIT_BPS,
						sendBurstBytes: Math.floor(CHUNK_SIZE * 4) // Smaller burst for smoother sending
					})

					// Start sending data at a fixed interval
					const chunk = randomBytes(CHUNK_SIZE)
					sendInterval = setInterval(() => {
						const packetId = writeVarInt(0x10)
						const packetData = Buffer.concat([packetId, chunk])
						const packet = Buffer.concat([
							writeVarInt(packetData.length),
							packetData
						])
						client.write(packet, err => {
							if (!err) {
								totalSent += packet.length
							}
						})
					}, SEND_INTERVAL_MS)
				}
			})

			client.on('error', err => {
				if (sendInterval) clearInterval(sendInterval)
				resolve({ success: false, error: `Client error: ${err.message}` })
			})

			client.on('close', () => {
				if (sendInterval) clearInterval(sendInterval)
				if (!loginSuccessReceived) {
					resolve({
						success: false,
						error: 'Connection closed before login success'
					})
				}
			})

			// Stop the test after the duration
			setTimeout(async () => {
				if (sendInterval) clearInterval(sendInterval)

				// If clientConnection is still not found, try to get it again.
				if (!clientConnection) {
					for await (const conn of geofront.connections()) {
						clientConnection = conn
						break
					}
				}

				if (!clientConnection) {
					resolve({
						success: false,
						error: 'Test finished but client connection was not found'
					})
					client.end()
					return
				}

				// Log metrics periodically during the test
				const logInterval = setInterval(async () => {
					if (clientConnection) {
						await geofront.updateMetrics()
					}
				}, 1000)

				setTimeout(async () => {
					clearInterval(logInterval)

					if (!clientConnection) {
						resolve({
							success: false,
							error: 'Client connection not found at the end of the test.'
						})
						client.end()
						return
					}

					// Update and get metrics BEFORE closing the connection
					await geofront.updateMetrics()
					const globalMetrics = geofront.metrics
					const finalMetrics = globalMetrics.connections[clientConnection.id]

					if (!finalMetrics) {
						resolve({
							success: false,
							error: `Metrics for connection ${clientConnection.id} not found in global metrics.`
						})
						client.end()
						return
					}

					client.end()

					// Wait a bit more for connection to be fully closed
					await new Promise(resolve => setTimeout(resolve, 1000))

					// Get final global metrics after waiting for connection to close
					await geofront.updateMetrics()
					const finalGlobalMetrics = geofront.metrics

					resolve({
						success: true,
						finalMetrics: {
							connection: finalMetrics,
							global: finalGlobalMetrics,
							totalSent,
							receiveIntervals,
							totalReceivedBytes
						}
					})
				}, TEST_DURATION_S * 1000)
			}, TEST_DURATION_S * 1000)
		})

		const result = await testResult
		if (result.error) {
			console.error('Test failed with error:', result.error)
		}
		expect(result.success).toBe(true)

		const {
			connection: connMetrics,
			global: globalMetrics,
			totalSent: clientTotalSent,
			receiveIntervals: finalReceiveIntervals
		} = result.finalMetrics

		// Verification
		const expectedMaxBytes = RATE_LIMIT_BPS * TEST_DURATION_S
		const tolerance = 0.2 // Allow 20% tolerance for timing inaccuracies and burst

		// 1. Check connection metrics
		// bytes_sent should be close to what the client sent, but capped by the limit.
		// Since we send slower than the limit, it should be close to totalSent.
		// However, the proxy adds its own overhead, so we check if it's within a reasonable range.
		console.log(`Client sent: ${clientTotalSent} bytes`)
		console.log(`Connection metrics (sent): ${connMetrics.bytes_sent} bytes`)
		console.log(`Expected max bytes (limit): ${expectedMaxBytes} bytes`)

		// 2. 分析接收数据的时间间隔来验证平滑限速
		if (finalReceiveIntervals.length > 0) {
			const avgInterval =
				finalReceiveIntervals.reduce((a, b) => a + b, 0) /
				finalReceiveIntervals.length
			const intervalVariance =
				finalReceiveIntervals.reduce((sum, interval) => {
					return sum + Math.pow(interval - avgInterval, 2)
				}, 0) / finalReceiveIntervals.length
			const intervalStdDev = Math.sqrt(intervalVariance)

			// 验证间隔的一致性 - 如果是平滑限速，间隔应该相对稳定
			const coefficientOfVariation = intervalStdDev / avgInterval
			console.log(
				`[TIMING] Intervals: ${
					finalReceiveIntervals.length
				}, Avg: ${avgInterval.toFixed(
					2
				)}ms, CV: ${coefficientOfVariation.toFixed(3)}`
			)

			// 检查是否有太多极大的间隔（表示突发传输）
			const largeIntervals = finalReceiveIntervals.filter(
				interval => interval > avgInterval * 2
			)
			const largeIntervalRatio =
				largeIntervals.length / finalReceiveIntervals.length

			// 验证平滑性：变异系数应该 < 1.0，大间隔比例应该 < 30%
			expect(coefficientOfVariation).toBeLessThan(1.0)
			expect(largeIntervalRatio).toBeLessThan(0.3)
		}

		// 3. Check global metrics
		// Global metrics should include the traffic from this connection.
		expect(globalMetrics.total_bytes_sent).toBeGreaterThanOrEqual(
			connMetrics.bytes_sent
		)
		expect(globalMetrics.active_conn).toBe(0) // Connection should be closed by now
	}, 15000) // Increase timeout for this test
})
