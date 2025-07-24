# 🌍 Geofront

[![npm version](https://img.shields.io/npm/v/geofront-ts.svg)](https://www.npmjs.com/package/geofront-ts)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Ikaleio/geofront/release.yml)](https://github.com/Ikaleio/geofront/actions)
[![License](https://img.shields.io/npm/l/geofront-ts.svg)](./LICENSE)

**Geofront 是一个为 Minecraft 设计的高性能、可编程的入口代理核心，采用 Rust 编写，并通过 Bun FFI 与 TypeScript/JavaScript 无缝集成。**

它就像一个用于 Minecraft 的 `nginx`，允许你用单一的 IP 和端口，根据玩家连接时使用的服务器地址（`host`），将他们智能地路由到不同的后端 Minecraft 服务器。

---

## ✨ 核心特性

- **高性能网络核心**: 基于 Rust 和 Tokio 构建，拥有极低的的 CPU 和内存占用。
- **动态路由**: 通过简单的 JavaScript 回调函数，根据玩家 IP、用户名、连接主机等信息实现复杂的路由逻辑。
- **零拷贝转发**: 在 Linux 系统上自动启用 `splice`，在内核层面直接转发数据，实现极致性能。
- **动态速率限制**: 支持令牌桶算法，可对每个连接设置动态的上传/下载速率和突发流量。
- **上游代理支持**: 支持通过 SOCKS5 代理连接到后端服务器。
- **丰富的 Metrics**: 提供全局和单个连接的实时流量统计。
- **Bun FFI 集成**: 利用 Bun 的 FFI 功能，提供比 WASM 或 N-API 更高效、更简单的原生调用。

## 📦 安装

```bash
bun install geofront-ts
```

## 🚀 快速上手

下面是一个简单的例子，演示如何启动一个代理，将所有到 `mc.mydomain.com` 的连接转发到本地的 Minecraft 服务器 `127.0.0.1:25565`。

```typescript
// server.ts
import { Geofront } from "geofront-ts";

try {
  // 使用工厂方法创建 Geofront 实例
  const proxy = Geofront.create();

  // 设置路由规则
  proxy.setRouter((ip, host, player, protocol) => {
    console.log(
      `New connection from ${player}@${ip} to ${host} (protocol: ${protocol})`
    );

    if (host.toLowerCase() === "mc.mydomain.com") {
      // 允许连接，并路由到本地服务器
      return {
        remoteHost: "127.0.0.1",
        remotePort: 25565,
      };
    } else {
      // 拒绝其他所有连接
      return {
        disconnect: "§cUnknown host! Please connect using mc.mydomain.com",
      };
    }
  });

  // 启动监听
  const { code, listenerId } = proxy.listen("0.0.0.0", 25565);
  if (code === 0) {
    console.log(
      `✅ Geofront proxy listening on 0.0.0.0:25565 (ID: ${listenerId})`
    );
  } else {
    throw new Error(`Failed to start listener: code ${code}`);
  }
} catch (e) {
  console.error(`Failed to start geofront:`, e);
}
```

然后运行它：

```bash
bun run server.ts
```

更常见的用例是作为 Hypixel 代理（加速 IP 后端）：

```typescript
// server.ts
import { Geofront } from "geofront-ts";

try {
  // 使用工厂方法创建 Geofront 实例
  const proxy = Geofront.create();

  // 设置路由规则
  proxy.setRouter((ip, host, player, protocol) => {
    console.log(
      `New connection from ${player}@${ip} to ${host} (protocol: ${protocol})`
    );

    return {
      remoteHost: "mc.hypixel.net",
      remotePort: 25565,
      rewriteHost: "mc.hypixel.net", // 该选项会重写重构握手包的 host 字段以绕过 Hypixel 的直连检测
    };
  });

  // 启动监听
  const { code, listenerId } = proxy.listen("0.0.0.0", 25565);
  if (code === 0) {
    console.log(
      `✅ Geofront proxy listening on 0.0.0.0:25565 (ID: ${listenerId})`
    );
  } else {
    throw new Error(`Failed to start listener: code ${code}`);
  }
} catch (e) {
  console.error(`Failed to start geofront:`, e);
}
```

## 🛠️ 构建

如果你想从源码构建：

1.  确保你已经安装了 [Rust 工具链](https://rustup.rs/) 和 [Bun](https://bun.sh/)。
2.  克隆仓库并安装依赖：
    ```bash
    git clone https://github.com/Ikaleio/geofront.git
    cd geofront
    bun install
    ```
3.  运行构建脚本：
    ```bash
    bun run build
    ```
    构建产物将位于 `dist` 目录。

## 📚 API 文档

### `Geofront`

Geofront 的主类，用于管理代理实例。

#### `Geofront.create(): Geofront`

使用工厂方法创建一个新的 Geofront 实例。这个方法会自动初始化 FFI 库和轮询系统。

```typescript
const geofront = Geofront.create();
```

#### `geofront.listen(host: string, port: number): { code: number, listenerId: number }`

在指定的 `host` 和 `port` 上启动一个新的监听器。

- 返回: `{ code: number, listenerId: number }`
  - `code`: 0 表示成功，非 0 表示错误
  - `listenerId`: 监听器的唯一 ID

#### `geofront.setRouter(callback)`

设置路由回调函数。对于每个新的连接，此回调函数都会被调用以决定如何处理它。

- `callback(ip: string, host: string, player: string, protocol: number): RouterResult`
  - `ip`: 客户端 IP 地址。
  - `host`: 玩家连接时使用的主机名。
  - `player`: 玩家的 Minecraft 用户名 (如果可用)。
  - `protocol`: 玩家使用的 Minecraft 协议版本号。
  - 返回值 `RouterResult`:
    - `{ remoteHost: string, remotePort: number, ... }`: 允许连接并将其路由到指定的后端服务器。
    - `{ disconnect: string }`: 拒绝连接并向玩家显示指定的消息。

#### `geofront.setMotdCallback(callback)`

设置服务器列表 ping (MOTD) 的回调函数。

- `callback(ip: string, host: string, protocol: number): MotdResult`
  - 返回一个 `MotdResult` 对象来动态生成服务器信息。

#### `geofront.setDisconnectionCallback(callback)`

设置一个在连接断开时触发的回调函数。

- `callback(connId: number)`

#### `async geofront.shutdown()`

平滑地关闭 Geofront 实例，断开所有监听器和连接。

#### `geofront.limit(opts: LimitOpts)`

为所有**当前和未来**的连接设置全局速率限制。

- `opts`: `{ sendAvgBytes?: number, sendBurstBytes?: number, recvAvgBytes?: number, recvBurstBytes?: number }`

#### `geofront.kickAll(): number`

断开所有当前活动的连接。

- 返回: 被断开的连接数量

#### `geofront.getMetrics(): GlobalMetrics`

获取全局的流量和连接统计信息。

#### `*geofront.connections(): Generator<Connection>`

一个生成器，可以遍历所有当前活动的 `Connection` 对象。

```typescript
for (const conn of geofront.connections()) {
  console.log(`Active connection: ${conn.id}`);
}
```

#### `geofront.connection(id: number): Connection | undefined`

通过 ID 获取一个特定的 `Connection` 对象。

---

### `Connection`

代表一个单独的客户端连接。

#### `connection.id: number`

连接的唯一数字 ID。

#### `connection.metrics: ConnectionMetrics`

获取此连接的字节发送/接收统计信息。

#### `connection.limit(opts: LimitOpts)`

为此特定连接设置速率限制。

- `opts`: `{ sendAvgBytes?: number, sendBurstBytes?: number, recvAvgBytes?: number, recvBurstBytes?: number }`

#### `connection.kick()`

断开此连接。

## 🤝 贡献

欢迎提交 Pull Requests 和 Issues！
