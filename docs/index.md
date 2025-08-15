---
layout: home
description: 高性能可编程 Minecraft 入口代理：Rust + Bun FFI，支持动态路由、零拷贝、速率限制与缓存。
hero:
  name: Geofront
  text: 高性能 · 可编程 · Minecraft 入口代理
  tagline: Rust + Bun FFI 驱动，提供极致性能、动态路由、零拷贝转发、速率限制与丰富事件。
  actions:
    - theme: brand
      text: 快速开始
      link: /#快速开始
    - theme: alt
      text: 架构设计
      link: /guide/architecture
    - theme: alt
      text: API 文档
      link: /api/
features:
  - title: 高性能核心
    details: 基于 Tokio 与零拷贝 splice()，低延迟、高吞吐、低资源占用。
  - title: 动态路由
    details: 使用函数式 Router，根据 host / IP / 玩家名 / 协议版本灵活决策。
  - title: 高级速率限制
    details: 每连接上传/下载独立令牌桶，支持动态调整与全局默认值。
  - title: 缓存加速
    details: 路由与 MOTD 原生缓存（IP / IP+Host 粒度），支持拒绝缓存与 TTL 控制。
  - title: 上游代理
    details: 支持 SOCKS5 链接下游服务器，可用于加速或出口策略控制。
  - title: 事件与指标
    details: 连接生命周期事件 + 实时全局/单连接流量统计。
---

# 介绍

Geofront 是一个面向高并发 Minecraft 网络入口的代理核心，你可以把它视为面向 Minecraft 协议的 _可编程 L7 入口网关_。相比传统 Java 代理 (Velocity/BungeeCord)，它具有：

- 更低的内存开销与更高吞吐
- 通过 TypeScript Router 精确控制路由与拒绝策略
- Rust 层实现核心 I/O、缓存、速率限制、统计与零拷贝
- Bun FFI 直接调用，不需要 N-API / WASM 封装层

## 快速开始

```bash
bun install geofront-ts
```

```ts
import { Geofront } from 'geofront-ts'

async function main() {
	const proxy = Geofront.createProxy()

	proxy.setRouter(ctx => {
		if (ctx.host.endsWith('example.com')) {
			return { target: { host: '127.0.0.1', port: 25565 } }
		}
		return Geofront.disconnect('§c未知服务器')
	})

	proxy.setMotdProvider(ctx => ({
		version: { name: 'Geofront Proxy', protocol: ctx.protocol },
		players: { max: 100 },
		description: { text: '§6Geofront 示例代理' }
	}))

	await proxy.listen({ host: '0.0.0.0', port: 25565 })
}
main()
```

## 核心能力速览

| 能力       | 说明                                                             |
| ---------- | ---------------------------------------------------------------- |
| 路由       | 同步/异步函数，返回目标 / 代理 / 重写 host / 缓存策略 / 断开信息 |
| MOTD       | 动态生成 + 自动填充在线人数 + 缓存与拒绝控制                     |
| 速率限制   | 每连接上下行平均 + 突发；全局默认自动套用新连接                  |
| 缓存       | 路由 与 MOTD 统一缓存，IP 与 IP+Host 粒度，支持拒绝缓存          |
| 上游代理   | SOCKS5 + 可选 PROXY protocol 头注入下游                          |
| 事件       | 连接建立 / 关闭 / 监听器启动 / 停止 / 错误                       |
| 指标       | 全局连接数、总流量、单连接累计字节数                             |
| 零拷贝转发 | Linux 下自动使用 splice()                                        |

## 下一步

- 阅读架构: [/guide/architecture](/guide/architecture)
- 查看 API: [/api/](/api/)
- 直接看示例: [/examples/](/examples/)
