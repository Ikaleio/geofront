import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { Server } from 'net'
import { Geofront } from '../src/geofront'
import {
	startBackendServer,
	runClientTest,
	TEST_CONSTANTS,
	getRandomPort
} from './helpers'

const CLIENT_COUNT = 100

describe('Geofront Stress Test', () => {
	let geofront: Geofront
	let backendServer: Server
	let backendClosed: Promise<void>
	let PROXY_PORT: number
	let BACKEND_PORT: number

	beforeAll(async () => {
		PROXY_PORT = getRandomPort()
		BACKEND_PORT = getRandomPort()
		const backend = await startBackendServer({ port: BACKEND_PORT })
		backendServer = backend.server
		backendClosed = backend.closed

		geofront = new Geofront()
		await geofront.initialize()
		geofront.setRouter(() => ({
			remoteHost: TEST_CONSTANTS.BACKEND_HOST,
			remotePort: BACKEND_PORT
		}))
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

		// 清理后端服务器
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

	test(`should handle ${CLIENT_COUNT} concurrent connections`, async () => {
		const clientPromises: Promise<void>[] = []
		for (let i = 0; i < CLIENT_COUNT; i++) {
			const clientPromise = new Promise<void>((resolve, reject) => {
				runClientTest({
					port: PROXY_PORT,
					onData: (data, client) => {
						client.end()
						resolve()
					}
				}).catch(reject)
			})
			clientPromises.push(clientPromise)
		}

		const results = await Promise.allSettled(clientPromises)
		const failed = results.filter(r => r.status === 'rejected')

		expect(failed.length).toBe(0)
		if (failed.length > 0) {
			console.error('Failed clients:', failed)
		}
	}, 20000) // Increase timeout for stress test
})
