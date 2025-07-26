# 🌍 Geofront

[![npm version](https://img.shields.io/npm/v/geofront-ts.svg)](https://www.npmjs.com/package/geofront-ts)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Ikaleio/geofront/release.yml)](https://github.com/Ikaleio/geofront/actions)
[![License](https://img.shields.io/npm/l/geofront-ts.svg)](./LICENSE)

**Geofront 是一个为 Minecraft 设计的高性能、可编程的入口代理核心，采用 Rust 编写，并通过 Bun FFI 与 TypeScript/JavaScript 无缝集成。**

它就像一个用于 Minecraft 的 `nginx`，允许你用单一的 IP 和端口，根据玩家连接时使用的服务器地址（`host`），将他们智能地路由到不同的后端 Minecraft 服务器。

---

## ✨ 核心特性

- **高性能网络核心**: 基于 Rust 和 Tokio 构建，拥有极低的的 CPU 和内存占用。
- **现代 TypeScript API**: 全新设计的函数式 API，提供完整的类型安全和丰富的连接管理功能。
- **智能连接管理**: 在 JavaScript 侧维护完整的连接信息，支持按玩家、IP、主机等条件查询和管理。
- **动态路由**: 通过简单的 JavaScript 函数，根据玩家 IP、用户名、连接主机等信息实现复杂的路由逻辑。
- **零拷贝转发**: 在 Linux 系统上自动启用 `splice`，在内核层面直接转发数据，实现极致性能。
- **动态速率限制**: 支持令牌桶算法，可对每个连接设置动态的上传/下载速率和突发流量。
- **上游代理支持**: 支持通过 SOCKS5 代理连接到后端服务器。
- **丰富的事件系统**: 完整的连接生命周期事件，包括建立、关闭、错误等。
- **实时流量统计**: 提供全局和单个连接的实时流量统计和性能监控。
- **Bun FFI 集成**: 利用 Bun 的 FFI 功能，提供比 WASM 或 N-API 更高效、更简单的原生调用。

## 📦 安装

```bash
bun install geofront-ts
```

## 🚀 快速上手

### 简单代理示例

下面是一个使用新 API 的简单例子，演示如何创建一个功能完整的代理服务器：

```typescript
// server.ts
import { Geofront, type RouteContext, type MotdContext } from "geofront-ts";

async function main() {
  // 使用新的工厂方法创建代理
  const proxy = Geofront.createProxy();

  // 设置路由函数
  proxy.setRouter((context: RouteContext) => {
    console.log(`[路由] ${context.username}@${context.ip} -> ${context.host}`);

    // 检查连接限制
    const existingConnections = proxy.getConnectionsByPlayer(context.username);
    if (existingConnections.length >= 2) {
      return Geofront.disconnect('§c你已有多个连接，请先断开其他连接');
    }

    // 根据主机名路由
    if (context.host.toLowerCase().includes("example.com")) {
      return {
        target: {
          host: "127.0.0.1",
          port: 25565
        }
      };
    }

    return Geofront.disconnect("§c未知的服务器地址！\n§7请使用 example.com 连接");
  });

  // 设置 MOTD 生成器
  proxy.setMotdProvider((context: MotdContext) => {
    const onlineCount = proxy.getConnectionCount();
    const playerCount = proxy.getPlayerCount();

    return {
      version: { name: "Geofront Proxy", protocol: context.protocol },
      players: {
        max: 100,
        online: onlineCount,
        sample: [
          { name: `§a在线连接: §6${onlineCount}`, id: "00000000-0000-0000-0000-000000000000" },
          { name: `§a玩家数量: §6${playerCount}`, id: "00000000-0000-0000-0000-000000000001" }
        ]
      },
      description: {
        text: `§6§lGeofront 代理服务器 §r\n§7在线: §a${onlineCount} §7玩家: §a${playerCount}`
      }
    };
  });

  // 设置事件处理器
  proxy.setEventHandlers({
    onConnectionEstablished: (connection) => {
      console.log(`✅ [连接建立] ${connection.player}@${connection.ip}`);
      
      // 根据用户设置不同限速
      if (connection.player.endsWith('_VIP')) {
        connection.setRateLimit(Geofront.rateLimit(50, 50)); // 50MB/s
        console.log(`🌟 [VIP] ${connection.player} 获得 VIP 速度`);
      }
    },

    onConnectionClosed: (connection, info) => {
      const metrics = connection.getMetrics();
      console.log(`❌ [连接关闭] ${info.player} 持续时间: ${connection.getDurationString()}`);
      console.log(`   流量: ↑${(metrics.bytesSent / 1024 / 1024).toFixed(2)}MB ↓${(metrics.bytesReceived / 1024 / 1024).toFixed(2)}MB`);
    },

    onError: (error) => {
      console.error(`🚨 [错误] ${error.message}`);
    }
  });

  // 设置全局速率限制
  proxy.setGlobalRateLimit(Geofront.rateLimit(10, 10)); // 10MB/s

  // 启动监听器
  const listener = await proxy.listen({
    host: "0.0.0.0",
    port: 25565,
    proxyProtocol: 'optional'
  });

  console.log(`✅ 代理已启动: ${listener.config.host}:${listener.config.port}`);

  // 监控循环
  setInterval(() => {
    const metrics = proxy.getMetrics();
    const connections = proxy.getConnections();
    
    console.log(`📊 活跃连接: ${metrics.connections.active}, 玩家: ${proxy.getPlayerCount()}`);
    
    // 连接管理示例
    connections.forEach(conn => {
      const connMetrics = conn.getMetrics();
      const totalTraffic = connMetrics.bytesSent + connMetrics.bytesReceived;
      
      // 限制大流量连接
      if (totalTraffic > 100 * 1024 * 1024) { // 超过 100MB
        conn.setRateLimit(Geofront.rateLimit(1, 1)); // 限制到 1MB/s
      }
    });
  }, 10000);

  // 优雅关闭
  process.on('SIGINT', async () => {
    console.log('\n🛑 正在关闭代理...');
    await proxy.disconnectAll('§e服务器正在重启');
    await proxy.shutdown();
    process.exit(0);
  });
}

main().catch(console.error);
```

### Hypixel 加速代理示例

```typescript
// hypixel-proxy.ts
import { Geofront, type RouteContext } from "geofront-ts";

async function createHypixelProxy() {
  const proxy = Geofront.createProxy();

  // 高级路由逻辑
  proxy.setRouter(async (context: RouteContext) => {
    // 检查用户权限
    const isVip = context.username.endsWith('_VIP');
    const ipConnections = proxy.getConnectionsByIp(context.ip);
    
    if (ipConnections.length >= 5) {
      return Geofront.disconnect('§c此 IP 连接数过多');
    }

    // VIP 用户使用代理加速
    return {
      target: {
        host: "mc.hypixel.net",
        port: 25565
      },
      rewrite: {
        host: "mc.hypixel.net" // 绕过直连检测
      },
      proxy: isVip ? {
        url: "socks5://proxy.example.com:1080",
        protocol: 1 as const
      } : undefined
    };
  });

  // 动态 MOTD
  proxy.setMotdProvider((context) => {
    const onlineCount = proxy.getConnectionCount();
    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';

    return {
      version: { name: "Hypixel 加速代理", protocol: context.protocol },
      players: {
        max: 100000,
        online: 45000 + Math.floor(Math.random() * 15000),
        sample: [
          { name: `§6${timeGreeting}！`, id: "00000000-0000-0000-0000-000000000000" },
          { name: `§a当前用户: §6${onlineCount} 人`, id: "00000000-0000-0000-0000-000000000001" },
          { name: `§a§l低延迟 §8| §b§l稳定连接`, id: "00000000-0000-0000-0000-000000000002" }
        ]
      },
      description: {
        text: `§6§lHYPIXEL 加速代理 §r\n§7${timeGreeting}，代理状态：§a流畅`
      }
    };
  });

  // 启动代理
  await proxy.listen({ host: "0.0.0.0", port: 25565 });
  console.log("🚀 Hypixel 加速代理已启动！");

  return proxy;
}
```

## 📚 API 文档

### 主要类和接口

#### `Geofront.createProxy(): GeofrontProxy`
创建一个新的代理实例。

#### `GeofrontProxy` 类

**配置方法：**
- `setRouter(router: RouterFn): this` - 设置路由函数
- `setMotdProvider(provider: MotdFn): this` - 设置 MOTD 生成器
- `setGlobalRateLimit(limit: RateLimit): this` - 设置全局速率限制
- `setEventHandlers(handlers: EventHandlers): this` - 设置事件处理器

**监听器管理：**
- `listen(config: ProxyConfig): Promise<Listener>` - 启动监听器
- `getListeners(): ReadonlyArray<Listener>` - 获取所有监听器
- `stopAllListeners(): Promise<void>` - 停止所有监听器

**连接管理：**
- `getConnections(): ReadonlyArray<Connection>` - 获取所有活跃连接
- `getConnection(id: number): Connection | undefined` - 获取指定连接
- `getConnectionsByPlayer(player: string): ReadonlyArray<Connection>` - 按玩家查询连接
- `getConnectionsByIp(ip: string): ReadonlyArray<Connection>` - 按 IP 查询连接
- `getConnectionsByHost(host: string): ReadonlyArray<Connection>` - 按主机查询连接
- `disconnectAll(reason?: string): Promise<number>` - 断开所有连接
- `disconnectPlayer(player: string, reason?: string): Promise<number>` - 断开指定玩家
- `disconnectIp(ip: string, reason?: string): Promise<number>` - 断开指定 IP

**统计信息：**
- `getMetrics(): GlobalMetrics` - 获取全局统计
- `getConnectionCount(): number` - 获取连接数
- `getPlayerCount(): number` - 获取不重复玩家数
- `getActivePlayerList(): ReadonlyArray<string>` - 获取活跃玩家列表

**生命周期：**
- `shutdown(): Promise<void>` - 关闭代理
- `isShutdown(): boolean` - 检查是否已关闭

#### `Connection` 类

每个连接实例包含完整的连接信息：

**属性：**
- `id: number` - 连接 ID
- `player: string` - 玩家名
- `ip: string` - IP 地址
- `host: string` - 连接主机
- `protocol: number` - 协议版本
- `startAt: Date` - 连接开始时间

**方法：**
- `getMetrics(): ConnectionMetrics` - 获取连接统计
- `setRateLimit(limit: RateLimit): void` - 设置速率限制
- `disconnect(reason?: string): void` - 断开连接
- `isActive(): boolean` - 检查是否活跃
- `getDuration(): number` - 获取连接时长（毫秒）
- `getDurationString(): string` - 获取可读的连接时长

### 类型定义

#### `RouteContext`
路由上下文信息：
```typescript
interface RouteContext {
  readonly ip: string        // 客户端 IP
  readonly host: string      // 连接主机名
  readonly username: string  // 玩家用户名
  readonly protocol: number  // 协议版本
}
```

#### `RouteResult`
路由结果：
```typescript
interface RouteResult {
  readonly target: {
    readonly host: string    // 目标服务器主机
    readonly port: number    // 目标服务器端口
  }
  readonly proxy?: {
    readonly url: string     // 上游代理 URL (如 socks5://...)
    readonly protocol?: 1 | 2 // 代理协议版本
  }
  readonly rewrite?: {
    readonly host: string    // 重写握手包中的主机名
  }
}
```

#### `MotdContext`
MOTD 上下文信息：
```typescript
interface MotdContext {
  readonly ip: string        // 客户端 IP
  readonly host: string      // 查询主机名
  readonly protocol: number  // 协议版本
}
```

#### `RateLimit`
速率限制配置：
```typescript
interface RateLimit {
  readonly upload?: {
    readonly average: number  // 平均上传速度 (字节/秒)
    readonly burst?: number   // 突发上传速度 (字节/秒)
  }
  readonly download?: {
    readonly average: number  // 平均下载速度 (字节/秒)
    readonly burst?: number   // 突发下载速度 (字节/秒)
  }
}
```

### 事件系统

```typescript
interface EventHandlers {
  onConnectionEstablished?: (connection: Connection) => void
  onConnectionClosed?: (connection: Connection, info: ConnectionInfo) => void
  onListenerStarted?: (listener: Listener) => void
  onListenerStopped?: (listener: Listener) => void
  onError?: (error: Error) => void
}
```

### 工具函数

#### `Geofront.disconnect(reason: string): never`
断开连接的便利函数，在路由函数中使用。

#### `Geofront.rateLimit(uploadMBps?, downloadMBps?, burstMultiplier?): RateLimit`
创建速率限制配置的便利函数。

```typescript
// 10MB/s 上传下载，2倍突发
const limit = Geofront.rateLimit(10, 10, 2);

// 仅限制上传
const uploadOnly = Geofront.rateLimit(5);
```

## 🛠️ 构建

### 开发环境

```bash
git clone https://github.com/Ikaleio/geofront.git
cd geofront
bun install

# 构建 Rust 开发版本
cargo build

# 运行示例（开发模式）
bun dev example/simple.ts

# 运行测试（开发模式）
bun dev:test
```

### 生产环境

```bash
# 构建生产版本
bun run build

# 运行示例（生产模式）
bun run example/simple.ts

# 运行测试（生产模式）
bun test
```

## 🧪 测试

项目包含完整的测试套件：

```bash
# 运行所有测试
bun dev:test

# 运行特定测试
bun dev:test tests/simulated_proxy_test.ts

# 运行生产模式测试
bun test
```

测试覆盖：
- 基本代理功能
- 大数据包转发 (8MB)
- 连接管理和生命周期
- 速率限制功能
- SOCKS5 上游代理
- Proxy Protocol 支持
- 压力测试

## 🔧 高级用法

### 连接管理策略

```typescript
// 自动管理闲置连接
setInterval(() => {
  for (const conn of proxy.getConnections()) {
    const metrics = conn.getMetrics();
    const duration = conn.getDuration();
    
    // 断开长时间无流量的连接
    if (duration > 30 * 60 * 1000 && metrics.bytesSent + metrics.bytesReceived < 1024) {
      conn.disconnect('§e由于长时间无活动，连接已断开');
    }
  }
}, 60000);
```

### IP 连接数管理

```typescript
proxy.setRouter((context) => {
  const ipConnections = proxy.getConnectionsByIp(context.ip);
  
  if (ipConnections.length >= 5) {
    return Geofront.disconnect('§c此 IP 连接数过多');
  }
  
  // 正常路由逻辑...
});
```

### 动态速率限制

```typescript
proxy.setEventHandlers({
  onConnectionEstablished: (connection) => {
    // 根据用户类型设置不同速率
    if (connection.player.startsWith('premium_')) {
      connection.setRateLimit(Geofront.rateLimit(100, 100)); // 100MB/s
    } else if (connection.player.startsWith('vip_')) {
      connection.setRateLimit(Geofront.rateLimit(50, 50)); // 50MB/s
    } else {
      connection.setRateLimit(Geofront.rateLimit(10, 10)); // 10MB/s
    }
  }
});
```

## 🤝 贡献

欢迎提交 Pull Requests 和 Issues！

## 📄 许可证

MIT License - 详见 [LICENSE](./LICENSE) 文件。