// 主线程 API：通过 Comlink 与 Worker 通信
import { wrap, proxy, releaseProxy } from 'comlink'
import type { Remote } from 'comlink'
import { existsSync } from 'fs'
import { z } from 'zod'
import type { MotdResult, MotdType } from './motd'
import { MotdSchema, buildMotd } from './motd'

export interface RouteEvent {
	connId: bigint
	peerIpPtr: number
	port: number
	protocol: number
	hostPtr: number
	userPtr: number
}

export type RouterResult =
	| {
			remoteHost: string
			remotePort: number
			proxy?: string
			proxyProtocol?: 1 | 2
			rewriteHost?: string
	  }
	| {
			disconnect: string
	  }

export interface ConnectionMetrics {
	bytes_sent: number
	bytes_recv: number
}

const limitSchema = z
	.object({
		sendAvgBytes: z.number().min(0).default(0),
		sendBurstBytes: z.number().min(0).optional(),
		recvAvgBytes: z.number().min(0).default(0),
		recvBurstBytes: z.number().min(0).optional()
	})
	.partial()

export type LimitOpts = z.infer<typeof limitSchema>

// Geofront 选项的 Zod schema
const geofrontOptionsSchema = z.object({
	proxyProtocolIn: z
		.enum(['optional', 'strict', 'none'])
		.default('none')
		.optional()
})

export type GeofrontOptions = z.infer<typeof geofrontOptionsSchema>

export interface GlobalMetrics {
	total_conn: number
	active_conn: number
	total_bytes_sent: number
	total_bytes_recv: number
}

// Worker API 类型定义
interface GeofrontWorkerAPI {
	initialize(): Promise<{ ok: boolean }>
	setOptions(options: GeofrontOptions): Promise<number>
	startListener(
		addr: string,
		port: number
	): Promise<{ code: number; listenerId: number }>
	stopListener(listenerId: number): Promise<number>
	disconnect(connectionId: number): Promise<number>
	setRateLimit(
		connectionId: number,
		sendAvgBytes: number,
		sendBurstBytes: number,
		recvAvgBytes: number,
		recvBurstBytes: number
	): Promise<number>
	getMetrics(): Promise<GlobalMetrics>
	getConnections(): Promise<{ connections: number[] }>
	getConnectionMetrics(connectionId: number): Promise<ConnectionMetrics>
	kickAll(): Promise<number>
	shutdown(): Promise<number>
	setRouterCallback(
		callback: (
			connId: bigint,
			peerIp: string,
			port: number,
			protocol: number,
			host: string,
			user: string
		) => Promise<RouterResult> // Returns the result object
	): void
	removeRouteCallback(): void
	setMotdCallback(
		callback: (
			connId: bigint,
			peerIp: string,
			port: number,
			protocol: number,
			host: string,
			user: string // For MOTD requests, this will be empty string ""
		) => Promise<any> // Returns the MOTD object
	): void
	removeMotdCallback(): void
	clearRouteCache(): void
}

export class Connection {
	private workerApi: Remote<GeofrontWorkerAPI>
	private _id: number
	public when: number

	constructor(
		workerApi: Remote<GeofrontWorkerAPI>,
		connId: number,
		when: number
	) {
		this.workerApi = workerApi
		this._id = connId
		this.when = when
	}

	get id(): number {
		return this._id
	}

	get metrics(): Promise<ConnectionMetrics> {
		return this.workerApi.getConnectionMetrics(this._id)
	}

	async limit(opts: LimitOpts) {
		const parsed = limitSchema.parse(opts)
		return this.workerApi.setRateLimit(
			this._id,
			parsed.sendAvgBytes ?? 0,
			parsed.sendBurstBytes ?? parsed.sendAvgBytes ?? 0,
			parsed.recvAvgBytes ?? 0,
			parsed.recvBurstBytes ?? parsed.recvAvgBytes ?? 0
		)
	}

	async kick() {
		return this.workerApi.disconnect(this._id)
	}
}

export class Geofront {
	private worker: Worker
	public workerApi: Remote<GeofrontWorkerAPI> // Made public for testing
	private routerCallback?: (
		ip: string,
		host: string,
		player: string,
		protocol: number
	) => RouterResult
	private motdCallback?: (
		ip: string,
		host: string,
		protocol: number
	) => MotdResult
	private listenerId?: number
	private connectionMap = new Map<number, Connection>()
	private globalLimit: LimitOpts = {}
	private initialized = false
	private shutdownInProgress = false
	private workerTerminated = false
	public metrics: GlobalMetrics

	constructor() {
		// 创建 Worker 并用 Comlink 包装
		const tsUrl = new URL('./ffi_worker.ts', import.meta.url)
		const jsUrl = new URL('./ffi_worker.js', import.meta.url)

		// 使用 fileURLToPath 或直接使用 URL 对象来处理跨平台路径
		const tsPath =
			tsUrl.pathname.startsWith('/') && process.platform === 'win32'
				? tsUrl.pathname.slice(1)
				: tsUrl.pathname
		const jsPath =
			jsUrl.pathname.startsWith('/') && process.platform === 'win32'
				? jsUrl.pathname.slice(1)
				: jsUrl.pathname

		// 先检查 .ts 文件是否存在，否则回落到 .js
		const workerUrl = existsSync(tsPath) ? tsPath : jsPath

		if (!existsSync(workerUrl)) {
			// 如果什么都不干，它会静默退出难以调试
			throw new Error(`Worker file not found: ${workerUrl}`)
		}

		this.worker = new Worker(workerUrl, { type: 'module' })
		this.workerApi = wrap<GeofrontWorkerAPI>(this.worker)

		this.metrics = {
			total_conn: 0,
			active_conn: 0,
			total_bytes_sent: 0,
			total_bytes_recv: 0
		}
	}

	async initialize() {
		if (this.initialized) {
			throw new Error('Geofront worker is already initialized')
		}
		const result = await this.workerApi.initialize()
		this.initialized = result.ok
		if (!result.ok) {
			throw new Error('Failed to initialize Geofront worker')
		}
	}

	private async handleRoute(
		connId: bigint,
		peerIp: string,
		protocol: number,
		host: string,
		user: string
	): Promise<RouterResult> {
		let result: RouterResult
		if (!this.routerCallback) {
			result = { disconnect: 'No router configured' }
		} else {
			result = this.routerCallback(peerIp, host, user, protocol)

			// Only create a connection object if the decision is NOT to disconnect
			if (!('disconnect' in result)) {
				const conn = new Connection(this.workerApi, Number(connId), Date.now())
				this.connectionMap.set(Number(connId), conn)
				// Apply global limit to new connection
				if (Object.keys(this.globalLimit).length > 0) {
					conn.limit(this.globalLimit)
				}
			}
		}
		return result
	}

	private async handleMotd(
		connId: bigint,
		peerIp: string,
		protocol: number,
		host: string,
		user: string
	): Promise<MotdResult> {
		let result: MotdResult
		if (!this.motdCallback) {
			// Default MOTD when no callback is configured
			const defaultMotd: MotdType = {
				version: { name: 'Geofront', protocol: protocol },
				players: { max: 20, online: 0, sample: [] },
				description: { text: 'Geofront Proxy - No MOTD callback configured' },
				favicon:
					'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
			}
			result = buildMotd(defaultMotd, 0, protocol)
		} else {
			result = this.motdCallback(peerIp, host, protocol)
		}
		return result
	}

	async listen(host: string, port: number) {
		if (!this.initialized) {
			throw new Error('Geofront worker is not initialized')
		}
		const result = await this.workerApi.startListener(host, port)
		this.listenerId = result.listenerId
		await this.updateMetrics()
		return result
	}

	async updateMetrics() {
		if (!this.initialized) {
			throw new Error('Geofront worker is not initialized')
		}
		try {
			this.metrics = await this.workerApi.getMetrics()
		} catch (error) {
			throw new Error(`Failed to update metrics: ${error}`)
		}
	}

	setRouter(
		callback: (
			ip: string,
			host: string,
			player: string,
			protocol: number
		) => RouterResult
	) {
		if (!this.initialized) {
			throw new Error('Geofront worker is not initialized')
		}
		this.routerCallback = callback

		// Use Comlink.proxy to pass the callback function
		const proxyCallback = proxy(
			async (
				connId: bigint,
				peerIp: string,
				_port: number,
				protocol: number,
				host: string,
				user: string
			): Promise<RouterResult> => {
				return this.handleRoute(connId, peerIp, protocol, host, user)
			}
		)

		this.workerApi.setRouterCallback(proxyCallback as any)
	}

	setMotdCallback(
		callback: (ip: string, host: string, protocol: number) => MotdResult
	) {
		if (!this.initialized) {
			throw new Error('Geofront worker is not initialized')
		}
		this.motdCallback = callback

		// Use Comlink.proxy to pass the callback function
		const proxyCallback = proxy(
			async (
				connId: bigint,
				peerIp: string,
				_port: number,
				protocol: number,
				host: string,
				user: string
			): Promise<MotdResult> => {
				return this.handleMotd(connId, peerIp, protocol, host, user)
			}
		)

		this.workerApi.setMotdCallback(proxyCallback as any)
	}

	async limit(opts: LimitOpts) {
		if (!this.initialized) {
			throw new Error('Geofront worker is not initialized')
		}
		const parsed = limitSchema.parse(opts)
		this.globalLimit = parsed

		const connections = await this.workerApi.getConnections()
		const promises = []
		for (const connId of connections.connections) {
			promises.push(
				this.workerApi.setRateLimit(
					connId,
					parsed.sendAvgBytes ?? 0,
					parsed.sendBurstBytes ?? parsed.sendAvgBytes ?? 0,
					parsed.recvAvgBytes ?? 0,
					parsed.recvBurstBytes ?? parsed.recvAvgBytes ?? 0
				)
			)
		}
		await Promise.all(promises)
	}

	async kickall() {
		if (!this.initialized) {
			throw new Error('Geofront worker is not initialized')
		}
		await this.workerApi.kickAll()
		this.connectionMap.clear()
		await this.updateMetrics()
	}

	/**
	 * 设置 Geofront 全局选项
	 * @param options 选项配置对象
	 * @returns 操作结果状态码 (0 表示成功)
	 */
	async setOptions(options: GeofrontOptions): Promise<number> {
		if (!this.initialized || this.workerTerminated) {
			throw new Error(
				'Geofront worker is not initialized or has been terminated'
			)
		}

		// 使用 Zod 验证和标准化选项
		const validatedOptions = geofrontOptionsSchema.parse(options)

		// 调用 worker API 设置选项
		try {
			return await Promise.race([
				this.workerApi.setOptions(validatedOptions),
				new Promise<number>((_, reject) =>
					setTimeout(() => reject(new Error('setOptions 操作超时')), 5000)
				)
			])
		} catch (err: any) {
			const isWorkerError =
				err?.message?.includes('Worker has been terminated') ||
				err?.message?.includes('InvalidStateError') ||
				err?.message?.includes('Worker is terminated')

			if (isWorkerError) {
				this.workerTerminated = true
				throw new Error('Worker has been terminated')
			}
			throw err
		}
	}

	async *connections(): AsyncGenerator<Connection> {
		if (!this.initialized || this.workerTerminated) {
			throw new Error(
				'Geofront worker is not initialized or has been terminated'
			)
		}
		try {
			const result = await Promise.race([
				this.workerApi.getConnections(),
				new Promise<{ connections: number[] }>((_, reject) =>
					setTimeout(() => reject(new Error('getConnections 操作超时')), 3000)
				)
			])

			for (const connId of result.connections) {
				if (!this.connectionMap.has(connId)) {
					const conn = new Connection(this.workerApi, connId, Date.now())
					this.connectionMap.set(connId, conn)
				}
				yield this.connectionMap.get(connId)!
			}
		} catch (err: any) {
			const isWorkerError =
				err?.message?.includes('Worker has been terminated') ||
				err?.message?.includes('InvalidStateError') ||
				err?.message?.includes('Worker is terminated')

			if (isWorkerError) {
				this.workerTerminated = true
				throw new Error('Worker has been terminated')
			}
			throw err
		}
	}

	connection(id: number): Connection | undefined {
		if (!this.initialized || this.workerTerminated) {
			throw new Error(
				'Geofront worker is not initialized or has been terminated'
			)
		}
		return this.connectionMap.get(id)
	}

	async shutdown() {
		// 防止重复关闭
		if (!this.initialized || this.shutdownInProgress || this.workerTerminated) {
			return
		}

		this.shutdownInProgress = true

		try {
			// 首先检查 Worker 是否仍然活跃
			let workerAlive = true
			try {
				// 尝试一个简单的调用来检查 Worker 状态
				await Promise.race([
					this.workerApi.getMetrics(),
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error('Worker 状态检查超时')), 1000)
					)
				])
			} catch (err: any) {
				const isWorkerError =
					err?.message?.includes('Worker has been terminated') ||
					err?.message?.includes('InvalidStateError') ||
					err?.message?.includes('Worker is terminated') ||
					err?.message?.includes('Worker 状态检查超时')

				if (isWorkerError) {
					workerAlive = false
					this.workerTerminated = true
				}
			}

			// 如果 Worker 仍然活跃，尝试正常关闭
			if (workerAlive && !this.workerTerminated) {
				// 停止监听器
				if (this.listenerId !== undefined) {
					try {
						await Promise.race([
							this.workerApi.stopListener(this.listenerId),
							new Promise((_, reject) =>
								setTimeout(() => reject(new Error('停止监听器超时')), 2000)
							)
						])
					} catch (err: any) {
						const isWorkerError =
							err?.message?.includes('Worker has been terminated') ||
							err?.message?.includes('InvalidStateError') ||
							err?.message?.includes('Worker is terminated')

						if (isWorkerError) {
							this.workerTerminated = true
						} else {
							console.warn('停止监听器时出错:', err?.message)
						}
					}
				}

				// 移除路由回调
				if (!this.workerTerminated) {
					try {
						await Promise.race([
							this.workerApi.removeRouteCallback(),
							new Promise((_, reject) =>
								setTimeout(() => reject(new Error('移除路由回调超时')), 1000)
							)
						])
					} catch (err: any) {
						const isWorkerError =
							err?.message?.includes('Worker has been terminated') ||
							err?.message?.includes('InvalidStateError') ||
							err?.message?.includes('Worker is terminated')

						if (isWorkerError) {
							this.workerTerminated = true
						} else {
							console.warn('移除路由回调时出错:', err?.message)
						}
					}
				}

				// 移除 MOTD 回调
				if (!this.workerTerminated) {
					try {
						await Promise.race([
							this.workerApi.removeMotdCallback(),
							new Promise((_, reject) =>
								setTimeout(() => reject(new Error('移除 MOTD 回调超时')), 1000)
							)
						])
					} catch (err: any) {
						const isWorkerError =
							err?.message?.includes('Worker has been terminated') ||
							err?.message?.includes('InvalidStateError') ||
							err?.message?.includes('Worker is terminated')

						if (isWorkerError) {
							this.workerTerminated = true
						} else {
							console.warn('移除 MOTD 回调时出错:', err?.message)
						}
					}
				}

				// 调用 Worker 的 shutdown
				if (!this.workerTerminated) {
					try {
						await Promise.race([
							this.workerApi.shutdown(),
							new Promise((_, reject) =>
								setTimeout(
									() => reject(new Error('Worker shutdown 超时')),
									3000
								)
							)
						])
					} catch (err: any) {
						const isWorkerError =
							err?.message?.includes('Worker has been terminated') ||
							err?.message?.includes('InvalidStateError') ||
							err?.message?.includes('Worker is terminated')

						if (isWorkerError) {
							this.workerTerminated = true
						} else {
							console.warn('Worker shutdown时出错:', err?.message)
						}
					}
				}
			}

			// 释放 Comlink 代理，防止在 Worker 终止后尝试通信
			try {
				if (
					this.workerApi &&
					typeof this.workerApi[releaseProxy] === 'function'
				) {
					this.workerApi[releaseProxy]()
				}
			} catch (err: any) {
				// 忽略释放代理时的错误，这是预期的清理过程
				console.debug('释放 Comlink 代理时出错 (这通常是正常的):', err?.message)
			}

			// 给 Comlink 清理操作一些时间完成
			await new Promise(resolve => setTimeout(resolve, 100))
		} catch (err: any) {
			console.warn('shutdown过程中出现意外错误:', err?.message)
		} finally {
			// 无论如何都要清理状态和终止 Worker
			this.workerTerminated = true
			this.initialized = false
			this.shutdownInProgress = false

			try {
				// 在终止 Worker 之前，再次尝试释放任何剩余的资源
				if (this.worker && this.worker.terminate) {
					this.worker.terminate()
				}
			} catch (err: any) {
				// 忽略终止 Worker 时的错误
				console.debug('终止 Worker 时出错 (这通常是正常的):', err?.message)
			}
		}
	}
}
