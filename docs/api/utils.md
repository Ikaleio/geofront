---
description: 工具函数与工厂：快速创建代理、断开、限速转换、简单路由与静态 MOTD 构造器。
---

# 工具函数与工厂

## Geofront 命名空间

### createProxy()

创建并返回新的 `GeofrontProxy` 实例。
// 用途：程序主入口处初始化；一个进程通常 1 个实例即可。

### disconnect(reason: string): never

在 Router 中调用以拒绝玩家：

```ts
proxy.setRouter(ctx => {
	if (!allow(ctx)) return Geofront.disconnect('§c拒绝访问')
	return { target: { host: '1.2.3.4', port: 25565 } }
})
```

### rateLimit(uploadMBps?, downloadMBps?, burstMultiplier=2): RateLimit

将 MB/s 转换为字节速率：

```ts
Geofront.rateLimit(10, 10) // => { upload:{average:10485760, burst:20971520}, download:{...} }
```

### simpleRouter(routes: Record<string, { host: string; port: number }>): RouterFn

按 host 精确匹配：

```ts
proxy.setRouter(
	Geofront.simpleRouter({
		'lobby.example.com': { host: '10.0.0.1', port: 25565 },
		'pvp.example.com': { host: '10.0.0.2', port: 25565 }
	})
)
```

未知 host 自动抛出断开。

### staticMotd(motd): MotdFn

快速构造固定 MOTD：

```ts
proxy.setMotdProvider(
	Geofront.staticMotd({
		version: { name: 'Geofront Edge' },
		players: { max: 500 },
		description: { text: '§aWelcome' }
	})
)
```

`protocol` 自动填充为客户端版本。

---

返回： [API 总览](./) · [核心类](./core) · [类型与事件](./types-events)
