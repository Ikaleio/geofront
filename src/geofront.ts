// Geofront: 高性能 Minecraft 代理核心 - 新 TypeScript 风格 API
import { z } from 'zod'
import {
	MotdSchema,
	MotdInputSchema,
	type MotdResult,
	type MotdInput,
	type MotdType,
	buildMotd
} from './motd'
import {
	CString,
	dlopen,
	FFIType,
	type ConvertFns,
	type Pointer
} from 'bun:ffi'
import { platform } from 'os'
import { join } from 'path'

import process from 'process'

import defaultFavicon from '../assets/default-favicon.txt'

// ===== 核心类型定义 =====
export interface ProxyConfig {
	readonly host: string
	readonly port: number
	readonly proxyProtocol?: 'none' | 'optional' | 'strict'
}

export interface RouteContext {
	readonly ip: string
	readonly host: string
	readonly username: string
	readonly protocol: number
}

export interface RouteResult {
	readonly target: {
		readonly host: string
		readonly port: number
	}
	// 上游 SOCKS5/HTTP 代理配置（仅负责上游连接）
	readonly proxy?: {
		readonly url: string
	}
	// 向后端写入 HAProxy PROXY Protocol 版本；与监听器的 inbound proxyProtocol 配置语义不同
	readonly proxyProtocol?: 1 | 2
	readonly rewrite?: {
		readonly host: string
	}
	readonly cache?: {
		readonly granularity: 'ip' | 'ip+host'
		readonly ttl: number
		readonly reject?: boolean
		readonly rejectReason?: string
	}
}

export interface MotdContext {
	readonly ip: string
	readonly host: string
	readonly protocol: number
}

export interface RateLimit {
	readonly upload?: {
		readonly average: number
		readonly burst?: number
	}
	readonly download?: {
		readonly average: number
		readonly burst?: number
	}
}

export interface ConnectionMetrics {
	readonly bytesSent: number
	readonly bytesReceived: number
}

export interface GlobalMetrics {
	readonly connections: {
		readonly total: number
		readonly active: number
	}
	readonly traffic: {
		readonly totalBytesSent: number
		readonly totalBytesReceived: number
	}
}

// ===== 连接信息接口 =====
export interface ConnectionInfo {
	readonly id: number
	readonly player: string
	readonly ip: string
	readonly host: string
	readonly protocol: number
	readonly startAt: Date
}

// ===== 核心函数类型 =====
export type RouterFn = (
	context: RouteContext
) => RouteResult | Promise<RouteResult>
export type MotdFn = (context: MotdContext) => MotdResult | Promise<MotdResult>
export type ConnectionEstablishedHandler = (connection: Connection) => void
export type ConnectionClosedHandler = (
	connection: Connection,
	info: ConnectionInfo
) => void

// ===== 特殊错误类型 =====
export class DisconnectError extends Error {
	constructor(public readonly reason: string) {
		super(`Connection rejected: ${reason}`)
	}
}

// ===== 内部类型（FFI 兼容） =====
interface RouteRequest {
	connId: number
	peerIp: string
	port: number
	protocol: number
	host: string
	username: string
}

interface MotdRequest {
	connId: number
	peerIp: string
	port: number
	protocol: number
	host: string
}

interface DisconnectionEvent {
	connId: number
}

interface PollEvents {
	routeRequests: RouteRequest[]
	motdRequests: MotdRequest[]
	disconnectionEvents: DisconnectionEvent[]
}

// 内部旧格式兼容
const limitSchema = z
	.object({
		sendAvgBytes: z.number().min(0).default(0),
		sendBurstBytes: z.number().min(0).optional(),
		recvAvgBytes: z.number().min(0).default(0),
		recvBurstBytes: z.number().min(0).optional()
	})
	.partial()

const geofrontOptionsSchema = z.object({
	proxyProtocolIn: z
		.enum(['optional', 'strict', 'none'])
		.default('none')
		.optional()
})

export type GeofrontOptions = z.infer<typeof geofrontOptionsSchema>

// FFI 符号定义
export const FFISymbols = {
	proxy_set_options: {
		args: [FFIType.cstring],
		returns: FFIType.i32
	},
	proxy_submit_routing_decision: {
		args: [FFIType.u64, FFIType.cstring],
		returns: FFIType.i32
	},
	proxy_submit_motd_decision: {
		args: [FFIType.u64, FFIType.cstring],
		returns: FFIType.i32
	},
	proxy_start_listener: {
		args: [FFIType.cstring, FFIType.u16, FFIType.ptr],
		returns: FFIType.i32
	},
	proxy_stop_listener: { args: [FFIType.u64], returns: FFIType.i32 },
	proxy_disconnect: { args: [FFIType.u64], returns: FFIType.i32 },
	proxy_set_rate_limit: {
		args: [
			FFIType.u64, // connId
			FFIType.u64, // send_avg_bytes_per_sec
			FFIType.u64, // send_burst_bytes_per_sec
			FFIType.u64, // recv_avg_bytes_per_sec
			FFIType.u64 // recv_burst_bytes_per_sec
		],
		returns: FFIType.i32
	},
	proxy_shutdown: { args: [], returns: FFIType.i32 },
	proxy_kick_all: { args: [], returns: FFIType.u32 },
	proxy_get_metrics: {
		args: [],
		returns: FFIType.pointer
	},
	proxy_get_connection_metrics: {
		args: [FFIType.u64],
		returns: FFIType.pointer
	},
	proxy_free_string: {
		args: [FFIType.ptr],
		returns: FFIType.void
	},
	proxy_poll_events: {
		args: [],
		returns: FFIType.pointer
	},
	proxy_cleanup_cache: {
		args: [],
		returns: FFIType.i32
	},
	proxy_get_cache_stats: {
		args: [],
		returns: FFIType.pointer
	}
}

// FFI 符号实例
let symbols: ConvertFns<typeof FFISymbols>

// ===== 连接类 =====
export class Connection {
	readonly id: number
	readonly player: string
	readonly ip: string
	readonly host: string
	readonly protocol: number
	readonly startAt: Date

	private proxy: GeofrontProxy
	private lastKnownMetrics: ConnectionMetrics = {
		bytesSent: 0,
		bytesReceived: 0
	}

	constructor(proxy: GeofrontProxy, info: ConnectionInfo) {
		this.id = info.id
		this.player = info.player
		this.ip = info.ip
		this.host = info.host
		this.protocol = info.protocol
		this.startAt = info.startAt
		this.proxy = proxy
	}

	getMetrics(): ConnectionMetrics {
		const cached = this.proxy.getCachedConnectionMetrics(this.id)
		if (cached.bytesSent > 0 || cached.bytesReceived > 0) {
			this.lastKnownMetrics = cached
			return cached
		}
		return this.lastKnownMetrics
	}

	setRateLimit(limit: RateLimit): void {
		const uploadAvg = limit.upload?.average ?? 0
		const uploadBurst = limit.upload?.burst ?? uploadAvg
		const downloadAvg = limit.download?.average ?? 0
		const downloadBurst = limit.download?.burst ?? downloadAvg

		this.proxy.setRateLimit(
			this.id,
			uploadAvg,
			uploadBurst,
			downloadAvg,
			downloadBurst
		)
	}

	disconnect(reason?: string): void {
		this.proxy.disconnect(this.id)
	}

	isActive(): boolean {
		return this.proxy.getConnection(this.id) !== undefined
	}

	getDuration(): number {
		return Date.now() - this.startAt.getTime()
	}

	getDurationString(): string {
		const duration = this.getDuration()
		const seconds = Math.floor(duration / 1000)
		const minutes = Math.floor(seconds / 60)
		const hours = Math.floor(minutes / 60)

		if (hours > 0) {
			return `${hours}h ${minutes % 60}m ${seconds % 60}s`
		} else if (minutes > 0) {
			return `${minutes}m ${seconds % 60}s`
		} else {
			return `${seconds}s`
		}
	}
}

// ===== 监听器类 =====
export class Listener {
	readonly id: number
	readonly config: ProxyConfig

	private proxy: GeofrontProxy

	constructor(proxy: GeofrontProxy, id: number, config: ProxyConfig) {
		this.id = id
		this.config = config
		this.proxy = proxy
	}

	async stop(): Promise<void> {
		this.proxy.stopListener(this.id)
	}

	isListening(): boolean {
		return this.proxy.getListeners().some(l => l.id === this.id)
	}
}

// ===== 事件处理器配置 =====
export interface EventHandlers {
	onConnectionEstablished?: ConnectionEstablishedHandler
	onConnectionClosed?: ConnectionClosedHandler
	onListenerStarted?: (listener: Listener) => void
	onListenerStopped?: (listener: Listener) => void
	onError?: (error: Error) => void
}

// ===== 主代理类 =====
export class GeofrontProxy {
	private connections = new Map<number, Connection>()
	private listeners = new Map<number, Listener>()
	private connectionMetricsCache = new Map<number, ConnectionMetrics>()

	private routerCallback?: RouterFn
	private motdCallback?: MotdFn
	private eventHandlers: EventHandlers = {}
	private globalLimit: RateLimit = {}
	private shutdownInProgress = false

	public metrics: GlobalMetrics = {
		connections: { total: 0, active: 0 },
		traffic: { totalBytesSent: 0, totalBytesReceived: 0 }
	}

	private pollingInterval: ReturnType<typeof setInterval> | null = null
	private metricsInterval: ReturnType<typeof setInterval> | null = null
	private pollingEnabled = false
	private polling = false

	constructor() {
		this.initializeFFI()
		this.enablePolling(10)
		this.enableMetricsPolling(1000)
	}

	private initializeFFI() {
		try {
			// 动态加载 FFI 库
			let libPath: string
			const libName = 'geofront'
			const isDev = process.env.NODE_ENV === 'development'
			const rootDir = isDev
				? join(import.meta.dir, '..', 'target', 'debug')
				: join(import.meta.dir, '..', 'dist')

			switch (platform()) {
				case 'darwin':
					libPath = join(rootDir, `lib${libName}.dylib`)
					break
				case 'win32':
					libPath = join(rootDir, `${libName}.dll`)
					break
				default:
					libPath = join(rootDir, `lib${libName}.so`)
					break
			}

			if (isDev) {
				console.warn(
					`[WARN] Development mode: Loading FFI library from: ${libPath}`
				)
			}

			// 加载 FFI 库
			symbols = dlopen(libPath, FFISymbols).symbols

			console.log('✓ Geofront FFI library loaded successfully')
		} catch (error) {
			throw new Error(`Failed to load Geofront FFI library: ${error}`)
		}
	}

	// ===== 配置方法 =====
	setRouter(router: RouterFn): this {
		this.routerCallback = router
		return this
	}

	setMotdProvider(provider: MotdFn): this {
		this.motdCallback = provider
		return this
	}

	setGlobalRateLimit(limit: RateLimit): this {
		this.globalLimit = limit

		// 应用到所有现有连接
		for (const conn of this.connections.values()) {
			conn.setRateLimit(limit)
		}

		return this
	}

	setEventHandlers(handlers: EventHandlers): this {
		this.eventHandlers = handlers
		return this
	}

	// ===== 监听器管理 =====
	async listen(config: ProxyConfig): Promise<Listener> {
		// 转换 proxyProtocol 格式
		const options: GeofrontOptions = {
			proxyProtocolIn: config.proxyProtocol ?? 'none'
		}
		this.setOptions(options)

		const buf = new ArrayBuffer(8)
		const code = symbols.proxy_start_listener(
			Buffer.from(config.host + '\0'),
			config.port,
			buf as any
		)

		if (code !== 0) {
			throw new Error(`Failed to start listener: code ${code}`)
		}

		const listenerId = Number(new DataView(buf).getBigUint64(0, true))
		const listener = new Listener(this, listenerId, config)
		this.listeners.set(listenerId, listener)

		this.updateMetrics()

		if (this.eventHandlers.onListenerStarted) {
			this.eventHandlers.onListenerStarted(listener)
		}

		return listener
	}

	getListeners(): ReadonlyArray<Listener> {
		return Array.from(this.listeners.values())
	}

	async stopAllListeners(): Promise<void> {
		const stopPromises = Array.from(this.listeners.values()).map(listener =>
			listener.stop()
		)
		await Promise.all(stopPromises)
		this.listeners.clear()
	}

	// ===== 连接管理 =====
	getConnections(): ReadonlyArray<Connection> {
		return Array.from(this.connections.values())
	}

	getConnection(id: number): Connection | undefined {
		return this.connections.get(id)
	}

	getConnectionsByPlayer(player: string): ReadonlyArray<Connection> {
		return Array.from(this.connections.values()).filter(
			conn => conn.player === player
		)
	}

	getConnectionsByIp(ip: string): ReadonlyArray<Connection> {
		return Array.from(this.connections.values()).filter(conn => conn.ip === ip)
	}

	getConnectionsByHost(host: string): ReadonlyArray<Connection> {
		return Array.from(this.connections.values()).filter(
			conn => conn.host === host
		)
	}

	async disconnectAll(reason?: string): Promise<number> {
		const count = Number(symbols.proxy_kick_all())
		this.connections.clear()
		return count
	}

	async disconnectPlayer(player: string, reason?: string): Promise<number> {
		const connections = this.getConnectionsByPlayer(player)
		connections.forEach(conn => conn.disconnect(reason))
		return connections.length
	}

	async disconnectIp(ip: string, reason?: string): Promise<number> {
		const connections = this.getConnectionsByIp(ip)
		connections.forEach(conn => conn.disconnect(reason))
		return connections.length
	}

	// ===== 统计信息 =====
	getMetrics(): GlobalMetrics {
		let metricsPtr: Pointer | null = null
		try {
			metricsPtr = symbols.proxy_get_metrics() as Pointer
			if (metricsPtr === 0) {
				return {
					connections: { total: 0, active: 0 },
					traffic: { totalBytesSent: 0, totalBytesReceived: 0 }
				}
			}
			const metricsJson = new CString(metricsPtr)
			const rawMetrics = JSON.parse(metricsJson.toString())

			// 转换为新格式
			return {
				connections: {
					total: rawMetrics.total_conn,
					active: rawMetrics.active_conn
				},
				traffic: {
					totalBytesSent: rawMetrics.total_bytes_sent,
					totalBytesReceived: rawMetrics.total_bytes_recv
				}
			}
		} finally {
			if (metricsPtr) {
				symbols.proxy_free_string(metricsPtr)
			}
		}
	}

	getConnectionCount(): number {
		return this.connections.size
	}

	getPlayerCount(): number {
		const players = new Set(
			Array.from(this.connections.values()).map(conn => conn.player)
		)
		return players.size
	}

	getActivePlayerList(): ReadonlyArray<string> {
		const players = new Set(
			Array.from(this.connections.values()).map(conn => conn.player)
		)
		return Array.from(players)
	}

	// ===== 生命周期 =====
	async shutdown(): Promise<void> {
		if (this.shutdownInProgress) {
			return
		}
		this.shutdownInProgress = true

		this.disablePolling()
		this.disableMetricsPolling()

		await this.stopAllListeners()
		await symbols.proxy_shutdown()

		this.connections.clear()
		this.listeners.clear()
		this.connectionMetricsCache.clear()

		this.shutdownInProgress = false
	}

	isShutdown(): boolean {
		return this.shutdownInProgress
	}

	// ===== 缓存管理 =====
	cleanupCache(): void {
		symbols.proxy_cleanup_cache()
	}

	getCacheStats(): { totalEntries: number; expiredEntries: number } {
		let statsPtr: Pointer | null = null
		try {
			statsPtr = symbols.proxy_get_cache_stats() as Pointer
			if (statsPtr === 0) {
				return { totalEntries: 0, expiredEntries: 0 }
			}
			const statsJson = new CString(statsPtr)
			const stats = JSON.parse(statsJson.toString())
			return {
				totalEntries: stats.total_entries || 0,
				expiredEntries: stats.expired_entries || 0
			}
		} finally {
			if (statsPtr) {
				symbols.proxy_free_string(statsPtr)
			}
		}
	}

	// ===== 内部方法 =====
	getCachedConnectionMetrics(connectionId: number): ConnectionMetrics {
		return (
			this.connectionMetricsCache.get(connectionId) || {
				bytesSent: 0,
				bytesReceived: 0
			}
		)
	}

	stopListener(listenerId: number): void {
		symbols.proxy_stop_listener(BigInt(listenerId))
		const listener = this.listeners.get(listenerId)
		if (listener && this.eventHandlers.onListenerStopped) {
			this.eventHandlers.onListenerStopped(listener)
		}
		this.listeners.delete(listenerId)
	}

	disconnect(connectionId: number): void {
		symbols.proxy_disconnect(BigInt(connectionId))
	}

	setRateLimit(
		connectionId: number,
		sendAvgBytes: number,
		sendBurstBytes: number,
		recvAvgBytes: number,
		recvBurstBytes: number
	): void {
		symbols.proxy_set_rate_limit(
			BigInt(connectionId),
			BigInt(sendAvgBytes),
			BigInt(sendBurstBytes),
			BigInt(recvAvgBytes),
			BigInt(recvBurstBytes)
		)
	}

	setOptions(options: GeofrontOptions): number {
		const validatedOptions = geofrontOptionsSchema.parse(options)
		const jsonOptions = JSON.stringify(validatedOptions)
		return symbols.proxy_set_options(Buffer.from(jsonOptions + '\0')) as number
	}

	updateMetrics(): void {
		try {
			this.metrics = this.getMetrics()
			// 更新连接 metrics 缓存
			this.connectionMetricsCache.clear()
			const rawMetrics = this.getRawMetrics()
			for (const [connId, connMetrics] of Object.entries(
				rawMetrics.connections || {}
			)) {
				this.connectionMetricsCache.set(Number(connId), {
					bytesSent: (connMetrics as any).bytes_sent || 0,
					bytesReceived: (connMetrics as any).bytes_recv || 0
				})
			}
		} catch (error) {
			if (this.eventHandlers.onError) {
				this.eventHandlers.onError(
					new Error(`Failed to update metrics: ${error}`)
				)
			}
		}
	}

	private getRawMetrics(): any {
		let metricsPtr: Pointer | null = null
		try {
			metricsPtr = symbols.proxy_get_metrics() as Pointer
			if (metricsPtr === 0) {
				return { connections: {} }
			}
			const metricsJson = new CString(metricsPtr)
			return JSON.parse(metricsJson.toString())
		} finally {
			if (metricsPtr) {
				symbols.proxy_free_string(metricsPtr)
			}
		}
	}

	private enablePolling(intervalMs: number = 10): void {
		if (this.pollingEnabled) {
			return
		}
		this.pollingEnabled = true
		this.pollingInterval = setInterval(() => {
			this.pollRequests()
		}, intervalMs)
	}

	private disablePolling(): void {
		if (this.pollingInterval) {
			clearInterval(this.pollingInterval)
			this.pollingInterval = null
		}
		this.pollingEnabled = false
	}

	private enableMetricsPolling(intervalMs: number = 1000): void {
		if (this.metricsInterval) {
			return
		}
		this.metricsInterval = setInterval(() => {
			this.updateMetrics()
		}, intervalMs)
	}

	private disableMetricsPolling(): void {
		if (this.metricsInterval) {
			clearInterval(this.metricsInterval)
			this.metricsInterval = null
		}
	}

	private pollRequests(): void {
		if (this.polling) {
			return
		}
		this.polling = true
		try {
			this.pollBatchEvents()
		} catch (e) {
			if (this.eventHandlers.onError) {
				this.eventHandlers.onError(new Error(`Error during polling: ${e}`))
			}
		} finally {
			this.polling = false
		}
	}

	private pollBatchEvents(): void {
		let eventsPtr: Pointer | null = null
		try {
			eventsPtr = symbols.proxy_poll_events() as Pointer
			if (eventsPtr === 0) return

			const eventsJson = new CString(eventsPtr).toString()
			if (!eventsJson) return
			const events: PollEvents = JSON.parse(eventsJson)

			// Process route requests
			for (const request of events.routeRequests) {
				this.handleRouteRequest(request)
			}

			// Process MOTD requests
			for (const request of events.motdRequests) {
				this.handleMotdRequest(request)
			}

			// Process disconnection events
			for (const event of events.disconnectionEvents) {
				this.handleDisconnectionEvent(event)
			}
		} catch (e) {
			if (this.eventHandlers.onError) {
				this.eventHandlers.onError(
					new Error(`Error polling batch events: ${e}`)
				)
			}
		} finally {
			if (eventsPtr) {
				symbols.proxy_free_string(eventsPtr)
			}
		}
	}

	private async handleRouteRequest(request: RouteRequest): Promise<void> {
		try {
			if (!this.routerCallback) {
				const errResult = JSON.stringify({
					disconnect: 'No router configured'
				})
				symbols.proxy_submit_routing_decision(
					BigInt(request.connId),
					Buffer.from(errResult + '\0')
				)
				return
			}

			const context: RouteContext = {
				ip: request.peerIp,
				host: request.host,
				username: request.username,
				protocol: request.protocol
			}

			const result = await this.routerCallback(context)

			// 如果成功路由，创建连接对象
			if (!('disconnect' in (result as any))) {
				const connectionInfo: ConnectionInfo = {
					id: request.connId,
					player: request.username,
					ip: request.peerIp,
					host: request.host,
					protocol: request.protocol,
					startAt: new Date()
				}

				const connection = new Connection(this, connectionInfo)
				this.connections.set(request.connId, connection)

				// 应用全局速率限制
				if (Object.keys(this.globalLimit).length > 0) {
					connection.setRateLimit(this.globalLimit)
				}

				// 触发连接建立事件
				if (this.eventHandlers.onConnectionEstablished) {
					this.eventHandlers.onConnectionEstablished(connection)
				}
			}

			// 转换为旧格式并提交决策
			const legacyResult = this.convertRouteResult(result)
			const jsonResult = JSON.stringify(legacyResult)
			symbols.proxy_submit_routing_decision(
				BigInt(request.connId),
				Buffer.from(jsonResult + '\0')
			)
		} catch (e) {
			let errorMessage = 'Internal router error'
			if (e instanceof DisconnectError) {
				errorMessage = e.reason
			}

			const errResult = JSON.stringify({
				disconnect: errorMessage
			})
			symbols.proxy_submit_routing_decision(
				BigInt(request.connId),
				Buffer.from(errResult + '\0')
			)
		}
	}

	private async handleMotdRequest(request: MotdRequest): Promise<void> {
		try {
			const context: MotdContext = {
				ip: request.peerIp,
				host: request.host,
				protocol: request.protocol
			}

			let result: MotdResult
			if (!this.motdCallback) {
				// 默认 MOTD
				result = {
					version: { name: 'Geofront', protocol: request.protocol },
					description: { text: 'Geofront Proxy - No MOTD callback configured' },
					players: { max: 20 },
					favicon: defaultFavicon
				}
			} else {
				result = await this.motdCallback(context)
			}

			// 转换为完整的 MOTD 格式
			const validatedInput = MotdInputSchema.parse(result)
			const motd = this.createMotdFromInput(validatedInput)
			const builtMotd = buildMotd(
				motd,
				this.getConnectionCount(),
				request.protocol
			)

			// 添加缓存配置到最终结果
			const finalResult = {
				...builtMotd,
				cache: result.cache
					? {
							granularity:
								result.cache.granularity === 'ip+host' ? 'IpHost' : 'Ip',
							ttl: result.cache.ttl,
							reject: result.cache.reject,
							rejectReason: result.cache.rejectReason
					  }
					: undefined
			}

			const jsonResult = JSON.stringify(finalResult)
			symbols.proxy_submit_motd_decision(
				BigInt(request.connId),
				Buffer.from(jsonResult + '\0')
			)
		} catch (e) {
			const errResult = JSON.stringify({
				disconnect: 'Internal MOTD error'
			})
			symbols.proxy_submit_motd_decision(
				BigInt(request.connId),
				Buffer.from(errResult + '\0')
			)
		}
	}

	private handleDisconnectionEvent(event: DisconnectionEvent): void {
		const connection = this.connections.get(event.connId)
		if (connection) {
			const info: ConnectionInfo = {
				id: connection.id,
				player: connection.player,
				ip: connection.ip,
				host: connection.host,
				protocol: connection.protocol,
				startAt: connection.startAt
			}

			this.connections.delete(event.connId)

			if (this.eventHandlers.onConnectionClosed) {
				this.eventHandlers.onConnectionClosed(connection, info)
			}
		}
	}

	private convertRouteResult(result: RouteResult): any {
		if ('target' in result) {
			// 兼容旧格式：允许用户仍使用 proxy: { url, protocol } 写法
			const legacyProxyProtocol: 1 | 2 | undefined = (result as any)?.proxy
				?.protocol
			return {
				remoteHost: result.target.host,
				remotePort: result.target.port,
				proxy: result.proxy?.url,
				proxyProtocol: result.proxyProtocol ?? legacyProxyProtocol,
				rewriteHost: result.rewrite?.host,
				cache: result.cache
					? {
							granularity:
								result.cache.granularity === 'ip+host' ? 'IpHost' : 'Ip',
							ttl: result.cache.ttl,
							reject: result.cache.reject,
							rejectReason: result.cache.rejectReason
					  }
					: undefined
			}
		}
		return result
	}

	private createMotdFromInput(input: MotdInput): MotdType {
		const defaultMotd = {
			version: {
				name: 'Geofront',
				protocol: 'auto' as const
			},
			players: {
				max: 20,
				online: 'auto' as const,
				sample: []
			},
			description: { text: 'Geofront Proxy' },
			favicon: defaultFavicon
		}

		const merged = {
			version: {
				...defaultMotd.version,
				...input.version
			},
			players: {
				...defaultMotd.players,
				...input.players
			},
			description: input.description ?? defaultMotd.description,
			favicon: input.favicon ?? defaultMotd.favicon
		}

		return MotdSchema.parse(merged)
	}
}

// ===== 工具函数命名空间 =====
export namespace Geofront {
	export function createProxy(): GeofrontProxy {
		return new GeofrontProxy()
	}

	export function disconnect(reason: string): never {
		throw new DisconnectError(reason)
	}

	export function rateLimit(
		uploadMBps?: number,
		downloadMBps?: number,
		burstMultiplier: number = 2
	): RateLimit {
		return {
			upload: uploadMBps
				? {
						average: uploadMBps * 1024 * 1024,
						burst: uploadMBps * 1024 * 1024 * burstMultiplier
				  }
				: undefined,
			download: downloadMBps
				? {
						average: downloadMBps * 1024 * 1024,
						burst: downloadMBps * 1024 * 1024 * burstMultiplier
				  }
				: undefined
		}
	}

	// ===== 便利工厂函数 =====
	export function simpleRouter(
		routes: Record<string, { host: string; port: number }>
	): RouterFn {
		return context => {
			const route = routes[context.host.toLowerCase()]
			if (!route) {
				throw new DisconnectError(`Unknown host: ${context.host}`)
			}
			return { target: route }
		}
	}

	export function staticMotd(motd: {
		version: { name: string; protocol?: number }
		players: {
			max: number
			sample?: ReadonlyArray<{ name: string; id: string }>
		}
		description: { text: string }
		favicon?: string
	}): MotdFn {
		return context => ({
			version: {
				name: motd.version.name,
				protocol: motd.version.protocol ?? context.protocol
			},
			players: {
				max: motd.players.max,
				sample: motd.players.sample ?? []
			},
			description: motd.description,
			favicon: motd.favicon
		})
	}
}

// 额外的类型导出（用于那些需要直接导入类型的用例）
export type { MotdResult }
