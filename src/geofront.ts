// 主线程 API：通过 Comlink 与 Worker 通信
import { wrap, proxy } from 'comlink'
import type { Remote } from 'comlink'
import { CString, type Pointer } from 'bun:ffi'

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

export interface GlobalMetrics {
	total_conn: number
	active_conn: number
	total_bytes_sent: number
	total_bytes_recv: number
}

// Worker API 类型定义
interface GeofrontWorkerAPI {
	initialize(): Promise<{ ok: boolean }>
	startListener(
		addr: string,
		port: number
	): Promise<{ code: number; listenerId: number }>
	stopListener(listenerId: number): Promise<number>
	disconnect(connectionId: number): Promise<number>
	setRateLimit(
		connectionId: number,
		sendBps: number,
		recvBps: number
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

	async limit(avg: number, burst?: number) {
		const burstVal = burst || avg
		return this.workerApi.setRateLimit(this._id, avg, burstVal)
	}

	async kick() {
		return this.workerApi.disconnect(this._id)
	}
}

export class Geofront {
	private worker: Worker
	private workerApi: Remote<GeofrontWorkerAPI>
	private routerCallback?: (
		ip: string,
		host: string,
		player: string,
		protocol: number
	) => RouterResult
	private listenerId?: number
	private connectionMap = new Map<number, Connection>()
	public metrics: GlobalMetrics

	constructor() {
		// 创建 Worker 并用 Comlink 包装
		const workerUrl = new URL('./ffi_worker.ts', import.meta.url).pathname
		this.worker = new Worker(workerUrl, { type: 'module' })
		this.workerApi = wrap<GeofrontWorkerAPI>(this.worker)

		this.metrics = {
			total_conn: 0,
			active_conn: 0,
			total_bytes_sent: 0,
			total_bytes_recv: 0
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
			}
		}
		return result
	}

	async listen(host: string, port: number) {
		await this.workerApi.initialize()
		const result = await this.workerApi.startListener(host, port)
		this.listenerId = result.listenerId
		await this.updateMetrics()
		return result
	}

	async updateMetrics() {
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

	async limit(avg: number, burst?: number) {
		const connections = await this.workerApi.getConnections()
		const promises = []
		for (const connId of connections.connections) {
			promises.push(this.workerApi.setRateLimit(connId, avg, burst || avg))
		}
		await Promise.all(promises)
	}

	async kickall() {
		await this.workerApi.kickAll()
		this.connectionMap.clear()
		await this.updateMetrics()
	}

	async *connections(): AsyncGenerator<Connection> {
		const result = await this.workerApi.getConnections()

		for (const connId of result.connections) {
			if (!this.connectionMap.has(connId)) {
				const conn = new Connection(this.workerApi, connId, Date.now())
				this.connectionMap.set(connId, conn)
			}
			yield this.connectionMap.get(connId)!
		}
	}

	connection(id: number): Connection | undefined {
		return this.connectionMap.get(id)
	}

	async shutdown() {
		if (this.listenerId !== undefined) {
			await this.workerApi.stopListener(this.listenerId)
		}
		this.workerApi.removeRouteCallback()
		await this.workerApi.shutdown()
		this.worker.terminate()
	}
}
