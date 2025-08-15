---
description: 核心类：GeofrontProxy、Listener、Connection 的职责、管理与生命周期方法详解。
---

# 核心类

## GeofrontProxy

通过 `Geofront.createProxy()` 创建。实例内部会：

- 动态加载 Rust FFI 动态库（依据 `NODE_ENV` 选择 debug / dist）
- 开启事件轮询 (默认 10ms)
- 开启 metrics 轮询 (默认 1000ms)

### 配置方法

> 何时使用：在应用启动或热更新阶段替换回调/策略；这些方法是声明式注册点，不会立即触发网络行为。

| 方法                                              | 描述                                                       |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `setRouter(router: RouterFn): this`               | 设置路由回调（可返回 Promise）。                           |
| `setMotdProvider(provider: MotdFn): this`         | 设置 MOTD 生成器。                                         |
| `setGlobalRateLimit(limit: RateLimit): this`      | 设置全局默认速率限制，自动应用到新连接并立即更新现有连接。 |
| `setEventHandlers(handlers: EventHandlers): this` | 绑定事件。                                                 |

### 监听器管理

> 作用：对外暴露接入点。可以按需开多个端口（如不同 Proxy Protocol / 不同地域入口）。

| 方法                                             | 描述                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `listen(config: ProxyConfig): Promise<Listener>` | 启动监听器并返回 `Listener`。支持 `proxyProtocol` ('none' \| 'optional' \| 'strict')。 |
| `getListeners(): ReadonlyArray<Listener>`        | 获取当前所有监听器。                                                                   |
| `stopAllListeners(): Promise<void>`              | 停止全部监听器。                                                                       |

### 连接管理

> 典型场景：实时封禁、统计在线、按 IP/玩家做限流、运维脚本扫描异常连接。

| 方法                                | 描述                       |
| ----------------------------------- | -------------------------- |
| `getConnections()`                  | 获取活跃连接对象数组。     |
| `getConnection(id)`                 | 获取特定连接。             |
| `getConnectionsByPlayer(player)`    | 按玩家名过滤。             |
| `getConnectionsByIp(ip)`            | 按来源 IP 过滤。           |
| `getConnectionsByHost(host)`        | 按握手主机过滤。           |
| `disconnectAll(reason?)`            | 断开全部（返回断开数量）。 |
| `disconnectPlayer(player, reason?)` | 断开某玩家全部连接。       |
| `disconnectIp(ip, reason?)`         | 断开某 IP 全部连接。       |

### 统计与列表

> 适合低频（秒级）采样输出或上报监控；不是逐包实时计数接口。

| 方法                          | 描述                           |
| ----------------------------- | ------------------------------ |
| `getMetrics(): GlobalMetrics` | 获取一次快照（内部立即 FFI）。 |
| `getConnectionCount()`        | 当前连接数量（Map size）。     |
| `getPlayerCount()`            | 去重玩家数。                   |
| `getActivePlayerList()`       | 返回活跃玩家列表。             |

### 生命周期

> 推荐流程：收到退出信号 -> `disconnectAll` (可选) -> `shutdown` -> 进程退出；确保释放 FFI 资源与监听端口。

| 方法              | 描述                                 |
| ----------------- | ------------------------------------ |
| `shutdown()`      | 停止轮询、关闭监听器、清空内部状态。 |
| `isShutdown()`    | 是否处于关闭流程。                   |
| `cleanupCache()`  | 主动清理过期缓存。                   |
| `getCacheStats()` | `{ totalEntries, expiredEntries }`。 |

### 内部行为（说明性）

- `updateMetrics()` 会刷新全局与每连接缓存指标
- 事件轮询获得：路由请求 / MOTD 请求 / 断开事件
- 新连接成功路由后才创建 `Connection` 对象

## Listener

| 成员 / 方法           | 描述                                   |
| --------------------- | -------------------------------------- |
| `id: number`          | 唯一监听器 ID。                        |
| `config: ProxyConfig` | 启动时配置的 host/port/proxyProtocol。 |
| `stop()`              | 停止当前监听器。                       |
| `isListening()`       | 是否仍存在于 `getListeners()`。        |

## Connection

| 成员 / 方法                                                    | 描述                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| `id` / `player` / `ip` / `host` / `protocol` / `startAt: Date` | 基本元数据。                                                 |
| `getMetrics()`                                                 | 返回累计字节数 `{ bytesSent, bytesReceived }`（来自缓存）。  |
| `setRateLimit(limit)`                                          | 设置独立速率限制。                                           |
| `disconnect(reason?)`                                          | 断开连接（当前未直接传递 reason 到服务端，由路由阶段控制）。 |
| `isActive()`                                                   | 查询是否仍在连接 Map 中。                                    |
| `getDuration()`                                                | 存续毫秒数。                                                 |
| `getDurationString()`                                          | 人类友好持续时间字符串。                                     |

---

继续： [类型与事件](./types-events)
