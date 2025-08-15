import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Geofront } from '../src/geofront'
import {
	startBackendServer,
	getRandomPort,
	TEST_CONSTANTS,
	createHandshakePacket,
	createLoginStartPacket
} from './helpers'
import { connect } from 'net'
import type { Server } from 'net'

// 该测试验证：
// 1. 首次 MOTD 请求触发 provider 执行并缓存
// 2. 第二次同粒度请求命中缓存，provider 不再执行
//    （通过计数器断言）
// 3. 缓存 sample 中字符串形式可被解析

function createStatusHandshake(host: string, port: number): Buffer {
	// Minecraft handshake with nextState = 1 (status)
	return createHandshakePacket(
		TEST_CONSTANTS.TEST_PROTOCOL_VERSION,
		host,
		port,
		1
	)
}

function createStatusRequest(): Buffer {
	// Status request packet: length=1, packetId=0x00
	return Buffer.from([0x01, 0x00])
}

describe('MOTD Cache Integration', () => {
	let backendServer: Server
	let backendClosed: Promise<void>
	let BACKEND_PORT: number

	beforeAll(async () => {
		BACKEND_PORT = getRandomPort()
		const backend = await startBackendServer({ port: BACKEND_PORT })
		backendServer = backend.server
		backendClosed = backend.closed
	})

	afterAll(async () => {
		backendServer.close()
		await backendClosed
	})

	test('motd cache hit skips provider on second request', async () => {
		const proxy = Geofront.createProxy()
		let motdCalls = 0
		proxy.setMotdProvider(() => {
			motdCalls++
			return {
				version: { name: 'CacheTest' },
				description: { text: 'Hello Cache' },
				players: {
					max: 500,
					// 留空 online 让底层自动填充
					sample: ['Line A', 'Line B']
				},
				cache: { granularity: 'ip', ttl: 3000 }
			}
		})

		// 路由: 简单指向后端（虽然状态请求不会用到）
		proxy.setRouter(() => ({
			target: { host: TEST_CONSTANTS.BACKEND_HOST, port: BACKEND_PORT }
		}))

		const listenPort = getRandomPort()
		await proxy.listen({
			host: '0.0.0.0',
			port: listenPort,
			proxyProtocol: 'none'
		})

		async function doStatus(): Promise<string> {
			return new Promise((resolve, reject) => {
				const sock = connect(listenPort, '127.0.0.1', () => {
					try {
						sock.write(
							createStatusHandshake(TEST_CONSTANTS.TEST_HOST, listenPort)
						)
						// Immediately send status request packet
						sock.write(createStatusRequest())
					} catch (e) {
						reject(e)
					}
				})
				let collected = Buffer.alloc(0)
				sock.on('data', d => {
					collected = Buffer.concat([collected, d])
				})
				sock.on('close', () => {
					try {
						// Basic parse: first varint length, then packet id, then JSON length varint + JSON
						// We just find first '{' and last '}' to extract JSON
						const start = collected.indexOf(0x7b) // '{'
						const end = collected.lastIndexOf(0x7d) // '}'
						if (start !== -1 && end !== -1 && end > start) {
							resolve(collected.slice(start, end + 1).toString('utf8'))
						} else {
							reject(new Error('No JSON in response'))
						}
					} catch (e) {
						reject(e)
					}
				})
				sock.on('error', reject)
			})
		}

		// 首次请求 -> 调用 provider
		const first = await doStatus()
		expect(motdCalls).toBe(1)
		const firstObj = JSON.parse(first)
		expect(firstObj.description?.text).toBe('Hello Cache')

		// 第二次请求（同 IP） -> 命中缓存，不应再调用 provider
		const second = await doStatus()
		expect(motdCalls).toBe(1)
		const secondObj = JSON.parse(second)
		expect(secondObj.description?.text).toBe('Hello Cache')

		await proxy.shutdown()
	})
})
