// Geofront: 主 API 和 FFI 实现
import { z } from "zod";
import type { MotdResult, MotdType } from "./motd";
import { buildMotd } from "./motd";
import { CString, dlopen, FFIType, type Pointer } from "bun:ffi";
import { platform } from "os";
import { join } from "path";

export type RouterResult =
  | {
      remoteHost: string;
      remotePort: number;
      proxy?: string;
      proxyProtocol?: 1 | 2;
      rewriteHost?: string;
    }
  | {
      disconnect: string;
    };

export interface ConnectionMetrics {
  bytes_sent: number;
  bytes_recv: number;
}

const limitSchema = z
  .object({
    sendAvgBytes: z.number().min(0).default(0),
    sendBurstBytes: z.number().min(0).optional(),
    recvAvgBytes: z.number().min(0).default(0),
    recvBurstBytes: z.number().min(0).optional(),
  })
  .partial();

export type LimitOpts = z.infer<typeof limitSchema>;

// Geofront 选项的 Zod schema
const geofrontOptionsSchema = z.object({
  proxyProtocolIn: z
    .enum(["optional", "strict", "none"])
    .default("none")
    .optional(),
});

export type GeofrontOptions = z.infer<typeof geofrontOptionsSchema>;

export interface GlobalMetrics {
  total_conn: number;
  active_conn: number;
  total_bytes_sent: number;
  total_bytes_recv: number;
  connections: Record<string, ConnectionMetrics>;
}

// FFI 符号 - 在 initialize 中加载
let symbols: any = null;

// 存储活动连接 ID
const activeConnections = new Set<bigint>();

export class Connection {
  private geofront: Geofront;
  private _id: number;
  public when: number;

  constructor(geofront: Geofront, connId: number, when: number) {
    this.geofront = geofront;
    this._id = connId;
    this.when = when;
  }

  get id(): number {
    return this._id;
  }

  get metrics(): Promise<ConnectionMetrics> {
    return this.geofront.getConnectionMetrics(this._id);
  }

  async limit(opts: LimitOpts) {
    const parsed = limitSchema.parse(opts);
    return this.geofront.setRateLimit(
      this._id,
      parsed.sendAvgBytes ?? 0,
      parsed.sendBurstBytes ?? parsed.sendAvgBytes ?? 0,
      parsed.recvAvgBytes ?? 0,
      parsed.recvBurstBytes ?? parsed.recvAvgBytes ?? 0
    );
  }

  async kick() {
    return this.geofront.disconnect(this._id);
  }
}

export class Geofront {
  private routerCallback?: (
    ip: string,
    host: string,
    player: string,
    protocol: number
  ) => RouterResult;
  private motdCallback?: (
    ip: string,
    host: string,
    protocol: number
  ) => MotdResult;
  private disconnectionCallback?: (connId: number) => void;
  private listenerId?: number;
  private connectionMap = new Map<number, Connection>();
  private globalLimit: LimitOpts = {};
  private initialized = false;
  private shutdownInProgress = false;
  public metrics: GlobalMetrics;

  private pollingInterval: Timer | null = null;
  private pollingEnabled = false;
  private polling = false;

  constructor() {
    this.metrics = {
      total_conn: 0,
      active_conn: 0,
      total_bytes_sent: 0,
      total_bytes_recv: 0,
      connections: {},
    };
  }

  async initialize() {
    if (this.initialized) {
      return;
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

      // 启动轮询
      this.enablePolling(10);

      this.initialized = true;
    } catch (e) {
      console.error("Failed to initialize Geofront:", e);
      throw e;
    }
  }

  private async handleRoute(
    connId: bigint,
    peerIp: string,
    protocol: number,
    host: string,
    user: string
  ): Promise<RouterResult> {
    let result: RouterResult;
    if (!this.routerCallback) {
      result = { disconnect: "No router configured" };
    } else {
      result = this.routerCallback(peerIp, host, user, protocol);

      if (!("disconnect" in result)) {
        const conn = new Connection(this, Number(connId), Date.now());
        this.connectionMap.set(Number(connId), conn);
        if (Object.keys(this.globalLimit).length > 0) {
          conn.limit(this.globalLimit);
        }
      }
    }
    return result;
  }

  private async handleMotd(
    connId: bigint,
    peerIp: string,
    protocol: number,
    host: string,
    user: string
  ): Promise<MotdResult> {
    if (!this.motdCallback) {
      const defaultMotd: MotdType = {
        version: { name: "Geofront", protocol: protocol },
        players: { max: 20, online: 0, sample: [] },
        description: { text: "Geofront Proxy - No MOTD callback configured" },
        favicon:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      };
      return buildMotd(defaultMotd, 0, protocol);
    } else {
      return this.motdCallback(peerIp, host, protocol);
    }
  }

  private handleDisconnection(connId: bigint): void {
    const numConnId = Number(connId);
    this.connectionMap.delete(numConnId);
    if (this.disconnectionCallback) {
      try {
        this.disconnectionCallback(numConnId);
      } catch (error) {
        console.error("Error in user disconnection callback:", error);
      }
    }
  }

  async listen(host: string, port: number) {
    if (!this.initialized) {
      throw new Error("Geofront is not initialized");
    }
    const buf = new ArrayBuffer(8);
    const code = symbols.proxy_start_listener(
      Buffer.from(host + "\0"),
      port,
      buf as any
    );
    const listenerId = new DataView(buf).getBigUint64(0, true);
    this.listenerId = Number(listenerId);
    await this.updateMetrics();
    return { code, listenerId: this.listenerId };
  }

  async updateMetrics() {
    if (!this.initialized) {
      throw new Error("Geofront is not initialized");
    }
    try {
      this.metrics = await this.getMetrics();
    } catch (error) {
      throw new Error(`Failed to update metrics: ${error}`);
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
      throw new Error("Geofront is not initialized");
    }
    this.routerCallback = callback;
  }

  setMotdCallback(
    callback: (ip: string, host: string, protocol: number) => MotdResult
  ) {
    if (!this.initialized) {
      throw new Error("Geofront is not initialized");
    }
    this.motdCallback = callback;
  }

  setDisconnectionCallback(callback: (connId: number) => void) {
    if (!this.initialized) {
      throw new Error("Geofront is not initialized");
    }
    this.disconnectionCallback = callback;
  }

  async stopListener(listenerId: number) {
    if (!this.initialized) throw new Error("Geofront is not initialized");
    return symbols.proxy_stop_listener(BigInt(listenerId));
  }

  async disconnect(connectionId: number) {
    if (!this.initialized) throw new Error("Geofront is not initialized");
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
    if (!this.initialized) throw new Error("Geofront is not initialized");
    return symbols.proxy_set_rate_limit(
      BigInt(connectionId),
      BigInt(sendAvgBytes),
      BigInt(sendBurstBytes),
      BigInt(recvAvgBytes),
      BigInt(recvBurstBytes)
    );
  }

  async getMetrics(): Promise<GlobalMetrics> {
    if (!this.initialized) throw new Error("Geofront is not initialized");
    let metricsPtr;
    try {
      metricsPtr = symbols.proxy_get_metrics();
      if (metricsPtr === 0) {
        return {
          total_conn: 0,
          active_conn: 0,
          total_bytes_sent: 0,
          total_bytes_recv: 0,
          connections: {},
        };
      }
      const metricsJson = new CString(metricsPtr);
      return JSON.parse(metricsJson.toString());
    } finally {
      if (metricsPtr) {
        symbols.proxy_free_string(metricsPtr);
      }
    }
  }

  getConnections() {
    if (!this.initialized) throw new Error("Geofront is not initialized");
    return {
      connections: Array.from(activeConnections).map((id) => Number(id)),
    };
  }

  async getConnectionMetrics(connectionId: number): Promise<ConnectionMetrics> {
    if (!this.initialized) throw new Error("Geofront is not initialized");
    let metricsPtr;
    try {
      metricsPtr = symbols.proxy_get_connection_metrics(BigInt(connectionId));
      if (metricsPtr === 0) {
        return { bytes_sent: 0, bytes_recv: 0 };
      }
      const metricsJson = new CString(metricsPtr);
      return JSON.parse(metricsJson.toString());
    } finally {
      if (metricsPtr) {
        symbols.proxy_free_string(metricsPtr);
      }
    }
  }

  async kickAll() {
    if (!this.initialized) throw new Error("Geofront is not initialized");
    const kickedCount = symbols.proxy_kick_all();
    activeConnections.clear();
    return kickedCount;
  }

  async limit(opts: LimitOpts) {
    if (!this.initialized) throw new Error("Geofront is not initialized");
    const parsed = limitSchema.parse(opts);
    this.globalLimit = parsed;

    const connections = this.getConnections();
    const promises = [];
    for (const connId of connections.connections) {
      promises.push(
        this.setRateLimit(
          connId,
          parsed.sendAvgBytes ?? 0,
          parsed.sendBurstBytes ?? parsed.sendAvgBytes ?? 0,
          parsed.recvAvgBytes ?? 0,
          parsed.recvBurstBytes ?? parsed.recvAvgBytes ?? 0
        )
      );
    }
    await Promise.all(promises);
  }

  async setOptions(options: GeofrontOptions): Promise<number> {
    if (!this.initialized) throw new Error("Geofront is not initialized");
    const validatedOptions = geofrontOptionsSchema.parse(options);
    const jsonOptions = JSON.stringify(validatedOptions);
    return symbols.proxy_set_options(Buffer.from(jsonOptions + "\0"));
  }

  async *connections(): AsyncGenerator<Connection> {
    if (!this.initialized) throw new Error("Geofront is not initialized");
    const result = this.getConnections();
    for (const connId of result.connections) {
      if (!this.connectionMap.has(connId)) {
        const conn = new Connection(this, connId, Date.now());
        this.connectionMap.set(connId, conn);
      }
      yield this.connectionMap.get(connId)!;
    }
  }

  connection(id: number): Connection | undefined {
    if (!this.initialized) throw new Error("Geofront is not initialized");
    return this.connectionMap.get(id);
  }

  async shutdown() {
    if (!this.initialized || this.shutdownInProgress) {
      return;
    }
    this.shutdownInProgress = true;

    this.disablePolling();

    if (this.listenerId !== undefined) {
      await this.stopListener(this.listenerId);
    }

    await symbols.proxy_shutdown();

    this.initialized = false;
    this.shutdownInProgress = false;
  }

  private enablePolling(intervalMs: number = 10) {
    if (this.pollingEnabled) {
      return;
    }
    this.pollingEnabled = true;
    this.pollingInterval = setInterval(() => {
      this.pollRequests();
    }, intervalMs);
  }

  private disablePolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.pollingEnabled = false;
  }

  private pollRequests() {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      this.pollRouteRequests();
      this.pollMotdRequests();
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
      if (requestPtr === 0) return;

      const requestJson = new CString(requestPtr).toString();
      if (!requestJson) return;
      const request = JSON.parse(requestJson);

      activeConnections.add(BigInt(request.connId));

      if (!this.routerCallback) {
        const errResult = JSON.stringify({ disconnect: "No router configured" });
        symbols.proxy_submit_routing_decision(
          BigInt(request.connId),
          Buffer.from(errResult + "\0")
        );
        return;
      }

      (async () => {
        try {
          const result = await this.handleRoute(
            BigInt(request.connId),
            request.peerIp,
            request.protocol,
            request.host,
            request.username
          );
          const jsonResult = JSON.stringify(result);
          symbols.proxy_submit_routing_decision(
            BigInt(request.connId),
            Buffer.from(jsonResult + "\0")
          );
        } catch (e) {
          const errResult = JSON.stringify({ disconnect: "Internal router error" });
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
      if (requestPtr === 0) return;

      const requestJson = new CString(requestPtr).toString();
      if (!requestJson) return;
      const request = JSON.parse(requestJson);

      if (!this.motdCallback) {
        const errResult = JSON.stringify({
          version: { name: "Geofront", protocol: request.protocol },
          players: { max: 20, online: 0, sample: [] },
          description: { text: "Geofront Proxy - No MOTD callback configured" },
          favicon: null,
        });
        symbols.proxy_submit_motd_decision(
          BigInt(request.connId),
          Buffer.from(errResult + "\0")
        );
        return;
      }

      (async () => {
        try {
          const result = await this.handleMotd(
            BigInt(request.connId),
            request.peerIp,
            request.protocol,
            request.host,
            ""
          );
          const jsonResult = JSON.stringify(result);
          symbols.proxy_submit_motd_decision(
            BigInt(request.connId),
            Buffer.from(jsonResult + "\0")
          );
        } catch (e) {
          const errResult = JSON.stringify({ disconnect: "Internal MOTD error" });
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
      if (eventPtr === 0) return;

      const eventJson = new CString(eventPtr).toString();
      if (!eventJson) return;
      const event = JSON.parse(eventJson);

      this.handleDisconnection(BigInt(event.connId));
    } catch (e) {
      console.error("[ERROR] Error polling disconnection events:", e);
    } finally {
      if (eventPtr) {
        symbols.proxy_free_string(eventPtr);
      }
    }
  }
}
