// FFI Worker: 处理所有 Bun FFI 调用以保证线程安全
// 使用 Comlink 进行通信优化
import { expose } from "comlink";
import { CString, dlopen, FFIType, type Pointer } from "bun:ffi";
import { platform } from "os";
import { join } from "path";

// 路由回调类型
export type RouteCallback = (
  connId: bigint,
  peerIp: string,
  port: number,
  protocol: number,
  host: string,
  user: string
) => Promise<any>; // The handler now returns a promise of the JSON object

// MOTD 回调类型 - 参数与路由回调一致
export type MotdCallback = (
  connId: bigint,
  peerIp: string,
  port: number,
  protocol: number,
  host: string,
  user: string
) => Promise<any>; // The handler now returns a promise of the MOTD object

// 断开连接回调类型 - 只需要连接 ID
export type DisconnectionCallback = (connId: bigint) => void;

let symbols: any = null;

// 路由回调处理器
let asyncRouteCallbackHandler: RouteCallback | null = null;

// MOTD 回调处理器
let asyncMotdCallbackHandler: MotdCallback | null = null;

// 断开连接回调处理器
let asyncDisconnectionCallbackHandler: DisconnectionCallback | null = null;

// 存储连接 ID
const activeConnections = new Set<bigint>();

// Worker API 类
class GeofrontWorkerAPI {
  private initialized = false;
  private pollingInterval: Timer | null = null;
  private pollingEnabled = false;
  private polling = false;

  async initialize() {
    if (this.initialized) {
      return { ok: true };
    }
    try {
      // --- 动态加载 FFI 库 ---
      let libPath: string;
      const libName = "geofront";
      const isDev = process.env.NODE_ENV === "development";
      const rootDir = isDev
        ? join(import.meta.dir, "..", "target", "debug")
        : join(import.meta.dir, "..", "dist");

      switch (platform()) {
        case "darwin":
          libPath = join(rootDir, `lib${libName}.dylib`);
          break;
        case "win32":
          libPath = join(rootDir, `${libName}.dll`);
          break;
        default:
          libPath = join(rootDir, `lib${libName}.so`);
          break;
      }

      if (isDev) {
        console.log(
          `[WARN] Development mode: Loading FFI library from: ${libPath}`
        );
      }

      const { symbols: ffiSymbols } = dlopen(libPath, {
        proxy_set_options: {
          args: [FFIType.cstring],
          returns: FFIType.i32,
        },
        proxy_submit_routing_decision: {
          args: [FFIType.u64, FFIType.cstring],
          returns: FFIType.i32,
        },
        proxy_submit_motd_decision: {
          args: [FFIType.u64, FFIType.cstring],
          returns: FFIType.i32,
        },
        proxy_start_listener: {
          args: [FFIType.cstring, FFIType.u16, FFIType.ptr],
          returns: FFIType.i32,
        },
        proxy_stop_listener: { args: [FFIType.u64], returns: FFIType.i32 },
        proxy_disconnect: { args: [FFIType.u64], returns: FFIType.i32 },
        proxy_set_rate_limit: {
          args: [
            FFIType.u64, // connId
            FFIType.u64, // send_avg_bytes_per_sec
            FFIType.u64, // send_burst_bytes_per_sec
            FFIType.u64, // recv_avg_bytes_per_sec
            FFIType.u64, // recv_burst_bytes_per_sec
          ],
          returns: FFIType.i32,
        },
        proxy_shutdown: { args: [], returns: FFIType.i32 },
        proxy_kick_all: { args: [], returns: FFIType.u32 },
        proxy_get_metrics: {
          args: [],
          returns: FFIType.pointer,
        },
        proxy_get_connection_metrics: {
          args: [FFIType.u64],
          returns: FFIType.pointer,
        },
        proxy_free_string: {
          args: [FFIType.ptr],
          returns: FFIType.void,
        },
        // New polling APIs for thread safety
        proxy_poll_route_request: {
          args: [],
          returns: FFIType.pointer,
        },
        proxy_poll_motd_request: {
          args: [],
          returns: FFIType.pointer,
        },
        proxy_poll_disconnection_event: {
          args: [],
          returns: FFIType.pointer,
        },
      });
      symbols = ffiSymbols;

      // 启动轮询以处理来自 Rust 的事件
      // 这是新的、线程安全的方法
      await this.enablePolling(10); // 10ms 轮询间隔

      this.initialized = true;
      return { ok: true };
    } catch (e) {
      throw e;
    }
  }

  async setRouterCallback(cb: RouteCallback) {
    asyncRouteCallbackHandler = cb;
  }


  async setMotdCallback(cb: MotdCallback) {
    asyncMotdCallbackHandler = cb;
  }


  async setDisconnectionCallback(cb: DisconnectionCallback) {
    asyncDisconnectionCallbackHandler = cb;
  }


  async startListener(addr: string, port: number) {
    const buf = new ArrayBuffer(8);
    const code = symbols.proxy_start_listener(
      Buffer.from(addr + "\0"),
      port,
      buf as any
    );
    const listenerId = new DataView(buf).getBigUint64(0, true);
    return { code, listenerId: Number(listenerId) };
  }

  async stopListener(listenerId: number) {
    return symbols.proxy_stop_listener(BigInt(listenerId));
  }

  async disconnect(connectionId: number) {
    activeConnections.delete(BigInt(connectionId));
    return symbols.proxy_disconnect(BigInt(connectionId));
  }

  async setRateLimit(
    connectionId: number,
    sendAvgBytes: number,
    sendBurstBytes: number,
    recvAvgBytes: number,
    recvBurstBytes: number
  ) {
    return symbols.proxy_set_rate_limit(
      BigInt(connectionId),
      BigInt(sendAvgBytes),
      BigInt(sendBurstBytes),
      BigInt(recvAvgBytes),
      BigInt(recvBurstBytes)
    );
  }

  async shutdown() {
    return symbols.proxy_shutdown();
  }

  async getMetrics() {
    let metricsPtr;
    try {
      metricsPtr = symbols.proxy_get_metrics();
      if (metricsPtr === 0) {
        return null;
      }
      const metricsJson = new CString(metricsPtr);
      return JSON.parse(metricsJson.toString());
    } catch (e) {
      return null;
    } finally {
      if (metricsPtr !== 0) {
        symbols.proxy_free_string(metricsPtr);
      }
    }
  }

  getConnections() {
    return {
      connections: Array.from(activeConnections).map((id) => Number(id)),
    };
  }

  async getConnectionMetrics(connectionId: number) {
    let metricsPtr;
    try {
      metricsPtr = symbols.proxy_get_connection_metrics(BigInt(connectionId));
      if (metricsPtr === 0) {
        return null;
      }
      const metricsJson = new CString(metricsPtr);
      return JSON.parse(metricsJson.toString());
    } catch (e) {
      return null;
    } finally {
      if (metricsPtr !== 0) {
        symbols.proxy_free_string(metricsPtr);
      }
    }
  }

  async kickAll() {
    const kickedCount = symbols.proxy_kick_all();
    activeConnections.clear();
    return kickedCount;
  }

  async setOptions(options: any) {
    const jsonOptions = JSON.stringify(options);
    return symbols.proxy_set_options(Buffer.from(jsonOptions + "\0"));
  }

  // New thread-safe polling methods
  async enablePolling(intervalMs: number = 10) {
    if (this.pollingEnabled) {
      return;
    }
    
    this.pollingEnabled = true;
    this.pollingInterval = setInterval(() => {
      this.pollRequests();
    }, intervalMs);
    
    console.log(`[INFO] Enabled thread-safe polling mode with ${intervalMs}ms interval`);
  }

  async disablePolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.pollingEnabled = false;
    console.log("[INFO] Disabled polling mode");
  }

  private pollRequests() {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      // Poll route requests
      this.pollRouteRequests();

      // Poll MOTD requests
      this.pollMotdRequests();

      // Poll disconnection events
      this.pollDisconnectionEvents();
    } catch (e) {
      console.error("[ERROR] Error during polling:", e);
    } finally {
      this.polling = false;
    }
  }

  private pollRouteRequests() {
    let requestPtr;
    try {
      requestPtr = symbols.proxy_poll_route_request();
      if (requestPtr === 0) {
        return; // No pending requests
      }

      const requestJson = new CString(requestPtr).toString();
      if (!requestJson) return; // 如果字符串为空则跳过
      const request = JSON.parse(requestJson);
      
      // Add connection to our set
      activeConnections.add(BigInt(request.connId));

      if (!asyncRouteCallbackHandler) {
        const errResult = JSON.stringify({
          disconnect: "No router configured",
        });
        symbols.proxy_submit_routing_decision(
          BigInt(request.connId),
          Buffer.from(errResult + "\0")
        );
        return;
      }

      // Handle the request asynchronously
      (async () => {
        try {
          const result = await asyncRouteCallbackHandler(
            BigInt(request.connId),
            request.peerIp,
            request.port,
            request.protocol,
            request.host,
            request.username
          );

          // Serialize result to JSON
          const jsonResult = JSON.stringify(result);

          // Submit decision back to Rust
          symbols.proxy_submit_routing_decision(
            BigInt(request.connId),
            Buffer.from(jsonResult + "\0")
          );
        } catch (e) {
          const errResult = JSON.stringify({
            disconnect: "Internal router error",
          });
          symbols.proxy_submit_routing_decision(
            BigInt(request.connId),
            Buffer.from(errResult + "\0")
          );
        }
      })();
    } catch (e) {
      console.error("[ERROR] Error polling route requests:", e);
    } finally {
      if (requestPtr) {
        symbols.proxy_free_string(requestPtr);
      }
    }
  }

  private pollMotdRequests() {
    let requestPtr;
    try {
      requestPtr = symbols.proxy_poll_motd_request();
      if (requestPtr === 0) {
        return; // No pending requests
      }

      const requestJson = new CString(requestPtr).toString();
      if (!requestJson) return; // 如果字符串为空则跳过
      const request = JSON.parse(requestJson);

      if (!asyncMotdCallbackHandler) {
        const errResult = JSON.stringify({
          version: { name: "Geofront", protocol: request.protocol },
          players: { max: 20, online: 0, sample: [] },
          description: {
            text: "Geofront Proxy - No MOTD callback configured",
          },
          favicon: null,
        });
        symbols.proxy_submit_motd_decision(
          BigInt(request.connId),
          Buffer.from(errResult + "\0")
        );
        return;
      }

      // Handle the request asynchronously
      (async () => {
        try {
          const result = await asyncMotdCallbackHandler(
            BigInt(request.connId),
            request.peerIp,
            request.port,
            request.protocol,
            request.host,
            "" // username is empty for MOTD requests
          );

          // Serialize result to JSON
          const jsonResult = JSON.stringify(result);

          // Submit decision back to Rust
          symbols.proxy_submit_motd_decision(
            BigInt(request.connId),
            Buffer.from(jsonResult + "\0")
          );
        } catch (e) {
          const errResult = JSON.stringify({
            disconnect: "Internal MOTD error",
          });
          symbols.proxy_submit_motd_decision(
            BigInt(request.connId),
            Buffer.from(errResult + "\0")
          );
        }
      })();
    } catch (e) {
      console.error("[ERROR] Error polling MOTD requests:", e);
    } finally {
      if (requestPtr) {
        symbols.proxy_free_string(requestPtr);
      }
    }
  }

  private pollDisconnectionEvents() {
    let eventPtr;
    try {
      eventPtr = symbols.proxy_poll_disconnection_event();
      if (eventPtr === 0) {
        return; // No pending events
      }

      const eventJson = new CString(eventPtr).toString();
      if (!eventJson) return; // 如果字符串为空则跳过
      const event = JSON.parse(eventJson);
      
      // Remove connection from our set
      activeConnections.delete(BigInt(event.connId));

      // Call disconnection handler if registered
      if (asyncDisconnectionCallbackHandler) {
        try {
          asyncDisconnectionCallbackHandler(BigInt(event.connId));
        } catch (e) {
          console.error("Error in disconnection callback:", e);
        }
      }
    } catch (e) {
      console.error("[ERROR] Error polling disconnection events:", e);
    } finally {
      if (eventPtr) {
        symbols.proxy_free_string(eventPtr);
      }
    }
  }
}

expose(new GeofrontWorkerAPI());
