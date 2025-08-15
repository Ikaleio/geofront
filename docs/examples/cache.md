---
description: 缓存策略：路由与 MOTD 共享缓存、拒绝缓存、粒度 (ip / ip+host) 与统计维护示例。
---

# 缓存路由与 MOTD

## 缓存路由结果

```ts
proxy.setRouter(ctx => ({
	target: { host: '10.0.0.5', port: 25565 },
	cache: { granularity: 'ip+host', ttl: 60_000 }
}))
```

## 缓存 MOTD

```ts
proxy.setMotdProvider(ctx => ({
	version: { name: 'Edge Entry' },
	players: { max: 300 },
	description: { text: '§a欢迎' },
	cache: { granularity: 'ip', ttl: 5_000 }
}))
```

## 缓存拒绝策略

```ts
proxy.setRouter(ctx => ({
	target: { host: '10.0.0.9', port: 25565 },
	cache: {
		granularity: 'ip',
		ttl: 120_000,
		reject: true,
		rejectReason: 'Blocked region'
	}
}))
```

> 当 `reject: true` 时，`data` 仍会缓存，并在相同粒度匹配时直接断开，减少回调执行。

## 监控缓存

```ts
proxy.cleanupCache() // 主动清理过期项
const stats = proxy.getCacheStats() // { totalEntries, expiredEntries }
```
