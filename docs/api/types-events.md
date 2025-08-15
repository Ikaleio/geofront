---
description: API 类型与事件：配置、路由/MOTD 上下文与结果、限速、指标、回调与事件处理器定义。
---

# 类型与事件

## 基础类型

### ProxyConfig

```ts
interface ProxyConfig {
	host: string
	port: number
	proxyProtocol?: 'none' | 'optional' | 'strict'
}
// 用途：listen() 的配置；可通过 multiple listen 启动多入口。
```

### RouteContext & RouteResult

```ts
interface RouteContext {
	ip: string
	host: string
	username: string
	protocol: number
}
// 用途：只包含决定路由所需最小信息；可以基于 host / ip / username 做分流与限流判定。
interface RouteResult {
	target: { host: string; port: number }
	proxy?: { url: string }
	proxyProtocol?: 1 | 2
	rewrite?: { host: string }
	cache?: {
		granularity: 'ip' | 'ip+host'
		ttl: number
		reject?: boolean
		rejectReason?: string
	}
}
// 用途：返回给底层核心的转发表达；cache 字段可短暂记忆相同条件决策减少 JS 往返。
```

### MotdContext & MotdResult

```ts
interface MotdContext {
	ip: string
	host: string
	protocol: number
}
// 用途：查询阶段（未握手玩家名），用于生成 MOTD 与伪在线信息。
interface MotdResult {
	version: { name: string; protocol?: number }
	players: {
		max: number
		online?: number
		sample?: Array<{ name: string; id: string } | string>
	}
	description: { text: string }
	favicon?: string
	cache?: {
		granularity: 'ip' | 'ip+host'
		ttl: number
		reject?: boolean
		rejectReason?: string
	}
}
```

### RateLimit

```ts
interface RateLimit {
	upload?: { average: number; burst?: number }
	download?: { average: number; burst?: number }
}
```

字节/秒单位；`Geofront.rateLimit` 提供 MB/s 转换简化调用。

### Metrics

```ts
interface ConnectionMetrics {
	bytesSent: number
	bytesReceived: number
}
interface GlobalMetrics {
	connections: { total: number; active: number }
	traffic: { totalBytesSent: number; totalBytesReceived: number }
}
```

### ConnectionInfo

```ts
interface ConnectionInfo {
	id: number
	player: string
	ip: string
	host: string
	protocol: number
	startAt: Date
}
```

## 回调函数类型

```ts
type RouterFn = (ctx: RouteContext) => RouteResult | Promise<RouteResult>
type MotdFn = (ctx: MotdContext) => MotdResult | Promise<MotdResult>
```

## 事件处理器

```ts
interface EventHandlers {
	onConnectionEstablished?: (c: Connection) => void
	onConnectionClosed?: (c: Connection, info: ConnectionInfo) => void
	onListenerStarted?: (l: Listener) => void
	onListenerStopped?: (l: Listener) => void
	onError?: (err: Error) => void
}
```

## 错误类型

`DisconnectError`：内部用于路由阶段中断流程；由 `Geofront.disconnect()` 抛出并被捕获转换为 `{ disconnect: reason }`。

---

继续： [工具函数](./utils)
