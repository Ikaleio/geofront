// FFI Worker: 处理所有 Bun FFI 调用以保证线程安全
// 使用 Comlink 进行通信优化
import { expose } from 'comlink'
import { CString, dlopen, FFIType, JSCallback, type Pointer } from 'bun:ffi'
import { platform } from 'os'
import { join } from 'path'

// 路由回调类型
export type RouteCallback = (
	connId: bigint,
	peerIp: string,
	port: number,
	protocol: number,
	host: string,
	user: string
) => Promise<any> // The handler now returns a promise of the JSON object

let symbols: any = null

// 路由回调处理器
let asyncRouteCallbackHandler: RouteCallback | null = null

// 存储连接 ID
const activeConnections = new Set<bigint>()

// Worker API 类
class GeofrontWorkerAPI {
	private initialized = false

	async initialize() {
		if (this.initialized) {
			return { ok: true }
		}
		try {
			// --- 动态加载 FFI 库 ---
			let libPath: string
			const libName = 'libgeofront'
			const root = join(import.meta.dir, '..', 'dist') // 假设 'dist' 目录和 'package.json' 在同一级

			switch (platform()) {
				case 'darwin':
					libPath = join(root, `${libName}.dylib`)
					break
				case 'win32':
					libPath = join(root, `${libName}.dll`)
					break
				default:
					libPath = join(root, `${libName}.so`)
					break
			}

			const { symbols: ffiSymbols } = dlopen(libPath, {
				proxy_register_router: {
					args: [FFIType.function],
					returns: FFIType.i32
				},
				proxy_submit_routing_decision: {
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
					args: [FFIType.u64, FFIType.u64, FFIType.u64],
					returns: FFIType.i32
				},
				proxy_shutdown: { args: [], returns: FFIType.i32 },
				proxy_get_metrics: {
					args: [],
					returns: FFIType.pointer
				},
				proxy_free_string: {
					args: [FFIType.ptr],
					returns: FFIType.void
				}
			})
			symbols = ffiSymbols

			// JSCallback for router
			const routerCallback = new JSCallback(
				(
					connId: bigint,
					peerIpPtr: Pointer,
					port: number,
					protocol: number,
					hostPtr: Pointer,
					userPtr: Pointer
				) => {
					// This callback is now fully async.
					// It doesn't return anything to Rust directly.
					// It will call another FFI function to submit the result.
					;(async () => {
						// Decode strings immediately
						const peerIp = new CString(peerIpPtr).toString()
						const host = new CString(hostPtr).toString()
						const user = new CString(userPtr).toString()

						// Free the strings Rust allocated for us
						symbols.proxy_free_string(peerIpPtr)
						symbols.proxy_free_string(hostPtr)
						symbols.proxy_free_string(userPtr)

						// Add connection to our set
						activeConnections.add(connId)

						if (!asyncRouteCallbackHandler) {
							const errResult = JSON.stringify({
								disconnect: 'No router configured'
							})
							symbols.proxy_submit_routing_decision(
								connId,
								Buffer.from(errResult + '\0')
							)
							return
						}

						try {
							// Get routing decision object from the main thread
							const result = await asyncRouteCallbackHandler(
								connId,
								peerIp,
								port,
								protocol,
								host,
								user
							)

							// Serialize result to JSON
							const jsonResult = JSON.stringify(result)

							// Submit decision back to Rust
							symbols.proxy_submit_routing_decision(
								connId,
								Buffer.from(jsonResult + '\0')
							)
						} catch (e) {
							const errResult = JSON.stringify({
								disconnect: 'Internal router error'
							})
							symbols.proxy_submit_routing_decision(
								connId,
								Buffer.from(errResult + '\0')
							)
						}
					})()
				},
				{
					args: [
						FFIType.u64, // connId
						FFIType.ptr, // peerIp
						FFIType.u16, // port
						FFIType.u32, // protocol
						FFIType.ptr, // host
						FFIType.ptr // user
					],
					returns: FFIType.void,
					threadsafe: true
				}
			)

			// 注册路由回调
			symbols.proxy_register_router(routerCallback)

			this.initialized = true
			return { ok: true }
		} catch (e) {
			throw e
		}
	}

	async setRouterCallback(cb: RouteCallback) {
		asyncRouteCallbackHandler = cb
	}

	removeRouteCallback() {
		asyncRouteCallbackHandler = null
	}

	async startListener(addr: string, port: number) {
		const buf = new ArrayBuffer(8)
		const code = symbols.proxy_start_listener(
			Buffer.from(addr + '\0'),
			port,
			buf as any
		)
		const listenerId = new DataView(buf).getBigUint64(0, true)
		return { code, listenerId: Number(listenerId) }
	}

	async stopListener(listenerId: number) {
		return symbols.proxy_stop_listener(BigInt(listenerId))
	}

	async disconnect(connectionId: number) {
		activeConnections.delete(BigInt(connectionId))
		return symbols.proxy_disconnect(BigInt(connectionId))
	}

	async setRateLimit(connectionId: number, sendBps: number, recvBps: number) {
		return symbols.proxy_set_rate_limit(
			BigInt(connectionId),
			BigInt(sendBps),
			BigInt(recvBps)
		)
	}

	async shutdown() {
		return symbols.proxy_shutdown()
	}

	async getMetrics() {
		let metricsPtr
		try {
			metricsPtr = symbols.proxy_get_metrics()
			if (metricsPtr === 0) {
				return null
			}
			const metricsJson = new CString(metricsPtr)
			return JSON.parse(metricsJson.toString())
		} catch (e) {
			return null
		} finally {
			if (metricsPtr !== 0) {
				symbols.proxy_free_string(metricsPtr)
			}
		}
	}

	// --- 新增方法 ---

	getConnections() {
		return { connections: Array.from(activeConnections).map(id => Number(id)) }
	}

	getConnectionMetrics(connectionId: number) {
		// 注意：此功能需要 Rust 端实现
		// 目前返回一个模拟的响应
		return { bytes_sent: 0, bytes_recv: 0 }
	}

	async kickAll() {
		const promises = Array.from(activeConnections).map(connId =>
			this.disconnect(Number(connId))
		)
		await Promise.all(promises)
		activeConnections.clear()
		return promises.length
	}

	clearRouteCache() {
		// 注意：此功能需要 Rust 端实现
	}
}

expose(new GeofrontWorkerAPI())
