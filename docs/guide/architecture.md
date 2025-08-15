---
description: Geofront 内部架构：Rust 核心、FFI 轮询、路由与 MOTD 缓存、速率限制、零拷贝与指标系统详解。
---

# 架构设计

## 总览

Geofront 分为三层：

1. Rust 核心 (I/O + 协议 + 性能)
2. FFI 桥接 (Bun FFI 符号，JSON 交互)
3. TypeScript API (面向用户的对象与回调模型)

```text
Client ──▶ [Rust Listener] ──▶ Handshake 解析 ──┬─▶ (状态请求) MOTD 流程
                                             │
                                             └─▶ (登录) 路由流程 → 后端连接 → 数据转发
```

## Rust 核心模块

| 模块            | 职责                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `connection.rs` | 连接生命周期、握手解析、路由调用、MOTD、上游代理、数据转发、PROXY protocol、速率限制应用、零拷贝 (Linux) |
| `protocol.rs`   | Minecraft 协议最小解析工具：握手、登录开始、VarInt、状态/延迟回复、断开包写入                            |
| `splice.rs`     | Linux 下基于 `splice()` 的零拷贝双向转发，减少用户态缓冲复制                                             |
| `cache.rs`      | 路由与 MOTD 统一缓存；支持 IP / IP+Host 粒度、拒绝缓存、TTL、统计                                        |
| `state.rs`      | 全局状态：连接计数、速率限制器、事件队列、挂起回调、异步运行时、缓存实例                                 |
| `types.rs`      | 序列化结构、枚举、缓存配置、Metrics 快照、FFI JSON 模型                                                  |
| `ffi.rs`        | Bun 侧 dlopen 的符号导出与 JSON 数据传递接口                                                             |
| `logging.rs`    | tracing 初始化，支持环境过滤与动态重载                                                                   |

## 连接处理流水线

1. 接受 TCP 连接 → 分配 `conn_id`
2. 可选解析 PROXY protocol v1/v2（严格模式下失败即断开）
3. 读取握手包 → 判定 next_state：
   - `1` → 状态 / MOTD 流程
   - `2` → 登录 / 需要继续读取登录开始与用户名
4. 状态请求：进入 MOTD 决策（缓存 → 回调 → 构建 JSON → 发送）
5. 登录：路由缓存检查 → 提交路由请求（队列）→ 等待 JS 决策 → 可选重写 host → 建立后端连接（支持 SOCKS5）
6. 可选写入 PROXY protocol 头到后端（路由结果决定）
7. 回放握手+登录开始到后端
8. 进入双向转发阶段：
   - Linux: `splice::copy_bidirectional` 优先
   - 其他平台: 自定义 `copy_bidirectional_fallback`
9. 循环中分块读写 + 令牌桶速率限制 + Metrics 原子累加
10. 关闭时写入断开事件队列，由 TS 轮询抽取触发 `onConnectionClosed`

## 事件与轮询模型

Rust 不直接回调 JS，而是采用“批量轮询”模式以减少跨语言边界频率：

- Rust 收集：`ROUTE_REQUEST_QUEUE` / `MOTD_REQUEST_QUEUE` / `DISCONNECTION_EVENT_QUEUE`
- TypeScript 定时 `proxy_poll_events` (默认 10ms) 获取批量 JSON：
  ```json
  {
    "routeRequests": [ { "connId": 1, "peerIp": "...", ... } ],
    "motdRequests": [ ... ],
    "disconnectionEvents": [ { "connId": 1 } ]
  }
  ```
- TS 逐条处理：
  - 路由：执行用户设置的 `routerCallback`，建立 `Connection` 对象，提交决策 JSON
  - MOTD：执行 `motdCallback` 或默认构造
  - 断开：移除缓存连接对象，触发关闭事件

这种模式的优势：

- 减少 FFI 调用开销
- 无需在 Rust 持有 JS 函数指针，避免生命周期/GC 问题
- 批量处理 + JSON 内存复用

## 路由与 MOTD 决策结构

TS 回调返回的新式结构：

```ts
interface RouteResult {
	target: { host: string; port: number }
	proxy?: { url: string; protocol?: 1 | 2 }
	rewrite?: { host: string }
	cache?: {
		granularity: 'ip' | 'ip+host'
		ttl: number
		reject?: boolean
		rejectReason?: string
	}
}
```

内部兼容旧格式并序列化为：

```json
{
	"remoteHost": "1.2.3.4",
	"remotePort": 25565,
	"proxy": "socks5://...",
	"proxyProtocol": 1,
	"rewriteHost": "backend.internal",
	"cache": { "granularity": "IpHost", "ttl": 60000 }
}
```

MOTD 回调返回：

```ts
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

`online` / `protocol` 支持自动填充 (`auto` 语义在内部处理)。

## 缓存层设计

- 基于 `DashMap`（多线程安全），键格式：
  - IP: `ip:<ip>`
  - IP+Host: `ip:<ip>:host:<host>`
- 条目：`{ data: Value, is_rejection, reject_reason, expires_at }`
- TTL 以毫秒存储，过期访问时懒删除
- 路由与 MOTD 使用同一缓存：减少重复逻辑，提高命中
- 拒绝决策可缓存，防止重复高频恶意访问

### 典型缓存策略举例

```ts
proxy.setRouter(ctx => ({
	target: { host: '10.0.0.5', port: 25565 },
	cache: { granularity: 'ip+host', ttl: 30_000 }
}))

proxy.setMotdProvider(ctx => ({
	version: { name: 'Edge Entry' },
	players: { max: 200 },
	description: { text: '§a欢迎' },
	cache: { granularity: 'ip', ttl: 5_000 }
}))
```

## 速率限制

- 使用 `governor` 提供两个独立令牌桶（发送/接收）
- `Geofront.rateLimit(uploadMBps, downloadMBps, burstMultiplier)` 返回平均/突发字节速率
- 设置顺序：
  1. 全局：`setGlobalRateLimit`（应用到后续每个新连接）
  2. 单连接：`connection.setRateLimit`
- 转发循环中按 4096 字节块申请令牌

### 示例

```ts
proxy.setEventHandlers({
	onConnectionEstablished: c => {
		if (c.player.endsWith('_VIP')) {
			c.setRateLimit(Geofront.rateLimit(50, 50))
		} else {
			c.setRateLimit(Geofront.rateLimit(10, 10))
		}
	}
})

// ⚠️ 注意：以上依据玩家名后缀判断 VIP 仅为教学示意。
// 正确实践：外部权限/会员系统 -> 短 TTL 缓存 -> 失败回退默认限速。
```

## 零拷贝转发

- 仅 Linux：尝试把 outbound downcast 为 `TcpStream`，若成功 → `splice::copy_bidirectional`
- 其他平台或非 TCP → 回退自定义复制循环
- Metrics 在零拷贝路径结束后统一加总

## 指标 (Metrics)

Rust 层维护：

- 全局：`TOTAL_CONN`, `ACTIVE_CONN`, `TOTAL_BYTES_SENT`, `TOTAL_BYTES_RECV`
- 单连接：`ConnMetrics { bytes_sent, bytes_recv }`

TS 层：

- 通过 `proxy_get_metrics` 获取 JSON → 转换为：

```ts
interface GlobalMetrics {
	connections: { total: number; active: number }
	traffic: { totalBytesSent: number; totalBytesReceived: number }
}
```

- 连接级指标采用轮询缓存 `connectionMetricsCache`

## FFI 设计要点

- 所有跨语言复杂对象 → JSON 字符串 + C 字符串指针
- 统一释放：`proxy_free_string`
- 批量事件：`proxy_poll_events` → 减少 syscall/FFI 调用
- 关键导出符号（节选）：
  - `proxy_start_listener(host, port)`
  - `proxy_submit_routing_decision(connId, json)`
  - `proxy_submit_motd_decision(connId, json)`
  - `proxy_get_metrics()`
  - `proxy_set_rate_limit(connId, sendAvg, sendBurst, recvAvg, recvBurst)`
  - `proxy_cleanup_cache()` / `proxy_get_cache_stats()`

## TypeScript API 层对象模型

| 对象                   | 说明                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `GeofrontProxy`        | 主控制器：管理监听器、连接、回调、全局限速、缓存、事件轮询                             |
| `Listener`             | 监听实例；`stop()` 停止；`isListening()` 查询状态                                      |
| `Connection`           | 活跃连接的快照与操作：断开、限速、Metrics、存续时间                                    |
| `Geofront` (namespace) | 工厂与工具：`createProxy` / `disconnect` / `rateLimit` / `simpleRouter` / `staticMotd` |

## 事件生命周期

| 事件                          | 触发时机                                        |
| ----------------------------- | ----------------------------------------------- |
| `onConnectionEstablished`     | 路由决策成功并已加入连接表                      |
| `onConnectionClosed`          | Rust 记录断开 → 队列 → TS 轮询处理并从 Map 移除 |
| `onListenerStarted / Stopped` | 监听器启动/停止操作成功后                       |
| `onError`                     | 轮询解析、metrics 更新或内部异常捕获时          |

## 错误与断开策略

- 路由中抛出 `Geofront.disconnect(reason)` → 转换为 `DisconnectError` → 生成 `{ disconnect: reason }`
- MOTD / Route 若异常：返回统一 `Internal ... error` 文案
- 可缓存拒绝：`cache.reject = true` + `rejectReason`

## 设计取舍

| 场景           | 选择             | 原因                           |
| -------------- | ---------------- | ------------------------------ |
| Rust ↔ JS 通信 | 批量轮询 + JSON  | 简化生命周期，避免持久回调句柄 |
| 限速实现       | 用户态令牌桶     | 精细控制 + 跨平台一致性        |
| 零拷贝         | Linux `splice()` | 最大化常见部署环境性能         |
| 缓存粒度       | IP / IP+Host     | 平衡命中率与内存               |
| 拒绝缓存       | 支持             | 过滤恶意或非法请求成本下降     |

## 未来可拓展方向

- Web UI / Prometheus 指标导出
- 动态热更新 Router（无需重启）
- 多监听器多端口协同调度策略
- 多层次限速（全局 / group / 每 IP）
- QUIC / Bedrock 支持 (实验性)

---

<llm-only>
<details>
<summary>LLM 回答指导（仅供模型索引，不在普通渲染显示）</summary>

### 术语速览

- GeofrontProxy: 用户主控制器。不要臆造其不存在的方法。
- Listener: 由 `listen()` 返回的对象，负责特定 host/port 监听。
- Connection: 已成功路由并处于转发阶段的连接抽象。
- RouteContext / MotdContext: 回调输入；包含 ip / host / username / protocol。
- RouteResult: 路由决策；必须包含 target，其他字段可选。
- Cache granularity: 'ip' 或 'ip+host'；决定缓存 key 组成。
- Reject cache: 带 `cache.reject=true` 的路由/MOTD 结果，用于缓存拒绝原因。
- RateLimit: 上传/下载两组令牌桶字节速率与可选突发。
- Metrics: 全局或连接级字节累加统计。
- DisconnectError: 由 `Geofront.disconnect()` 抛出用于优雅拒绝。

### 回答策略

1. 若用户询问 API，优先引用已存在的公开方法或接口定义；不要创造新字段。
2. 涉及路由或 MOTD 返回结构时，列出 `target` / `proxy` / `rewrite` / `cache` / `reject` 相关真实字段。
3. 速率限制回答须说明上传与下载分别可配；使用 `Geofront.rateLimit()` 生成字节速率对象。
4. 缓存问题回答需指出路由与 MOTD 共用同一缓存实现，支持拒绝缓存与 TTL、粒度。
5. 不要引用 README 过时描述；一切以源码 / 本文档定义为准。
6. 如问题含糊，先澄清所指对象（路由? MOTD? 连接?）再给出具体 API。
7. 性能相关回答可提示 Linux 使用 splice 零拷贝，其它平台走回退复制。
8. 若用户尝试获取玩家数量，推荐 `getPlayerCount()`；获取活跃连接用 `getConnectionCount()`。
9. 错误处理：说明 `Geofront.disconnect()` 只在路由阶段生效，并被转为断开响应。
10. Vercel 部署触发条件：只有 commit message 以 `docs:` 开头才应构建（来自脚本）。

### 禁止项

- 不要发明协议版本处理逻辑之外的字段。
- 不要建议直接操作内部 FFI 符号；使用封装 API。
- 不要将缓存粒度扩展为未定义的枚举，例如 'player'。

</details>
</llm-only>

---

返回：[首页](/) · [API 文档](/api/) · [示例](/examples/)
