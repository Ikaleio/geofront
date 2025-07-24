// Geofront: 主 API 和 FFI 实现
import { z } from "zod";
import {
  MotdSchema,
  MotdInputSchema,
  type MotdResult,
  type MotdInput,
  type MotdType,
  buildMotd,
} from "./motd";
import {
  CString,
  dlopen,
  FFIType,
  type ConvertFns,
  type Pointer,
} from "bun:ffi";
import { platform } from "os";
import { join } from "path";

import process from "process"; // https://github.com/oven-sh/bun/issues/3835

import defaultFavicon from "../assets/default-favicon.txt";

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

export const FFISymbols = {
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
};

// FFI 符号 - 在 initialize 中加载
let symbols: ConvertFns<typeof FFISymbols>;

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

  get metrics(): ConnectionMetrics {
    return this.geofront.getConnectionMetrics(this._id);
  }

  limit(opts: LimitOpts) {
    const parsed = limitSchema.parse(opts);
    return this.geofront.setRateLimit(
      this._id,
      parsed.sendAvgBytes ?? 0,
      parsed.sendBurstBytes ?? parsed.sendAvgBytes ?? 0,
      parsed.recvAvgBytes ?? 0,
      parsed.recvBurstBytes ?? parsed.recvAvgBytes ?? 0
    );
  }

  kick() {
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
  private onlinePlayerConnSet = new Set<number>();
  private globalLimit: LimitOpts = {};
  private shutdownInProgress = false;
  public metrics: GlobalMetrics;

  private pollingInterval: Timer | null = null;
  private pollingEnabled = false;
  private polling = false;

  private constructor() {
    this.metrics = {
      total_conn: 0,
      active_conn: 0,
      total_bytes_sent: 0,
      total_bytes_recv: 0,
      connections: {},
    };
  }

  static create(): Geofront {
    const instance = new Geofront();

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

      const lib = dlopen(libPath, FFISymbols);
      symbols = lib.symbols;

      // 启动轮询
      instance.enablePolling(10);

      return instance;
    } catch (e) {
      console.error("Failed to initialize Geofront:", e);
      throw e;
    }
  }

  private handleRoute(
    connId: bigint,
    peerIp: string,
    protocol: number,
    host: string,
    user: string
  ): RouterResult {
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

  private handleMotd(
    connId: bigint,
    peerIp: string,
    protocol: number,
    host: string,
    user: string
  ): MotdType | { disconnect: string } {
    if (!this.motdCallback) {
      // 创建默认 MOTD
      const defaultInput: MotdInput = {
        version: { name: "Geofront", protocol: protocol },
        description: { text: "Geofront Proxy - No MOTD callback configured" },
        favicon: defaultFavicon,
      };
      const validatedInput = MotdInputSchema.parse(defaultInput);
      const defaultMotd = this.createMotdFromInput(validatedInput);
      return buildMotd(defaultMotd, this.onlinePlayerConnSet.size, protocol);
    } else {
      const result = this.motdCallback(peerIp, host, protocol);
      if ("disconnect" in result) {
        return result;
      }

      // 验证输入并转换为完整的 MOTD
      const validatedInput = MotdInputSchema.parse(result);
      const motd = this.createMotdFromInput(validatedInput);
      return buildMotd(motd, this.onlinePlayerConnSet.size, protocol);
    }
  }

  // 从输入创建完整的 MOTD 对象，填入默认值
  private createMotdFromInput(input: MotdInput): MotdType {
    const defaultMotd = {
      version: {
        name: "Geofront",
        protocol: "auto" as const,
      },
      players: {
        max: 20,
        online: "auto" as const,
        sample: [],
      },
      description: { text: "Geofront Proxy" },
      favicon: defaultFavicon,
    };

    // 深度合并输入数据
    const merged = {
      version: {
        ...defaultMotd.version,
        ...input.version,
      },
      players: {
        ...defaultMotd.players,
        ...input.players,
      },
      description: input.description ?? defaultMotd.description,
      favicon: input.favicon ?? defaultMotd.favicon,
    };

    // 使用输出 schema 验证并转换
    return MotdSchema.parse(merged);
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

  listen(host: string, port: number) {
    const buf = new ArrayBuffer(8);
    const code = symbols.proxy_start_listener(
      Buffer.from(host + "\0"),
      port,
      buf as any
    );
    const listenerId = new DataView(buf).getBigUint64(0, true);
    this.listenerId = Number(listenerId);
    this.updateMetrics();
    return { code, listenerId: this.listenerId };
  }

  updateMetrics() {
    try {
      this.metrics = this.getMetrics();
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
    this.routerCallback = callback;
  }

  setMotdCallback(
    callback: (ip: string, host: string, protocol: number) => MotdResult
  ) {
    this.motdCallback = callback;
  }

  setDisconnectionCallback(callback: (connId: number) => void) {
    this.disconnectionCallback = callback;
  }

  stopListener(listenerId: number) {
    return symbols.proxy_stop_listener(BigInt(listenerId));
  }

  disconnect(connectionId: number) {
    activeConnections.delete(BigInt(connectionId));
    return symbols.proxy_disconnect(BigInt(connectionId));
  }

  setRateLimit(
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

  getMetrics(): GlobalMetrics {
    let metricsPtr: Pointer | null = null;
    try {
      metricsPtr = symbols.proxy_get_metrics() as Pointer;
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
    return {
      connections: Array.from(activeConnections).map((id) => Number(id)),
    };
  }

  getConnectionMetrics(connectionId: number): ConnectionMetrics {
    let metricsPtr;
    try {
      metricsPtr = symbols.proxy_get_connection_metrics(
        BigInt(connectionId)
      ) as Pointer;
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

  kickAll() {
    const kickedCount = symbols.proxy_kick_all();
    activeConnections.clear();
    return kickedCount;
  }

  async limit(opts: LimitOpts) {
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

  setOptions(options: GeofrontOptions): number {
    const validatedOptions = geofrontOptionsSchema.parse(options);
    const jsonOptions = JSON.stringify(validatedOptions);
    return symbols.proxy_set_options(Buffer.from(jsonOptions + "\0")) as number;
  }

  *connections(): Generator<Connection> {
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
    return this.connectionMap.get(id);
  }

  async shutdown() {
    if (this.shutdownInProgress) {
      return;
    }
    this.shutdownInProgress = true;

    this.disablePolling();

    if (this.listenerId !== undefined) {
      this.stopListener(this.listenerId);
    }

    await symbols.proxy_shutdown();

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
      requestPtr = symbols.proxy_poll_route_request() as Pointer;
      if (requestPtr === 0) return;

      const requestJson = new CString(requestPtr).toString();
      if (!requestJson) return;
      const request = JSON.parse(requestJson);

      activeConnections.add(BigInt(request.connId));

      if (!this.routerCallback) {
        const errResult = JSON.stringify({
          disconnect: "No router configured",
        });
        symbols.proxy_submit_routing_decision(
          BigInt(request.connId),
          Buffer.from(errResult + "\0")
        );
        return;
      }

      (async () => {
        try {
          const result = this.handleRoute(
            BigInt(request.connId),
            request.peerIp,
            request.protocol,
            request.host,
            request.username
          );
          if (!("disconnect" in result)) {
            this.onlinePlayerConnSet.add(request.connId);
          }
          const jsonResult = JSON.stringify(result);
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
      requestPtr = symbols.proxy_poll_motd_request() as Pointer;
      if (requestPtr === 0) return;

      const requestJson = new CString(requestPtr).toString();
      if (!requestJson) return;
      const request = JSON.parse(requestJson);

      (async () => {
        try {
          const result = this.handleMotd(
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
      eventPtr = symbols.proxy_poll_disconnection_event() as Pointer;
      if (eventPtr === 0) return;

      const eventJson = new CString(eventPtr).toString();
      if (!eventJson) return;
      const event = JSON.parse(eventJson);

      if (this.onlinePlayerConnSet.has(event.connId)) {
        this.onlinePlayerConnSet.delete(event.connId);
      }

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
