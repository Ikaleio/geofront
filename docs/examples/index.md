---
description: 示例总览：最小代理、动态拒绝与限流、缓存策略、SOCKS5 与 PROXY Protocol 组合用法。
---

# 快速示例

## 简单入口代理

```ts
import { Geofront } from 'geofront-ts'

const proxy = Geofront.createProxy()

proxy.setRouter(ctx => ({
	target: { host: '127.0.0.1', port: 25565 }
}))

proxy.setMotdProvider(ctx => ({
	version: { name: 'Geofront Demo', protocol: ctx.protocol },
	players: { max: 100 },
	description: { text: '§6Demo Proxy' }
}))

await proxy.listen({ host: '0.0.0.0', port: 25565 })
```

## 动态拒绝与限流

```ts
proxy.setRouter(ctx => {
	const sameIp = proxy.getConnectionsByIp(ctx.ip)
	if (sameIp.length > 5) return Geofront.disconnect('§c该 IP 连接过多')
	return { target: { host: '10.0.0.10', port: 25565 } }
})

proxy.setEventHandlers({
	onConnectionEstablished: c => {
		if (!c.player.endsWith('_VIP')) {
			c.setRateLimit(Geofront.rateLimit(5, 5))
		}
		// ⚠️ 提醒：以玩家名后缀 _VIP 判定仅为演示。生产请使用外部权限查询 + 缓存。
	}
})
```

## 缓存路由与 MOTD

```ts
proxy.setRouter(ctx => ({
	target: { host: '10.0.0.5', port: 25565 },
	cache: { granularity: 'ip+host', ttl: 60_000 }
}))

proxy.setMotdProvider(ctx => ({
	version: { name: 'Edge Entry' },
	players: { max: 500 },
	description: { text: '§a高速接入' },
	cache: { granularity: 'ip', ttl: 5_000 }
}))
```

## SOCKS5 + PROXY Protocol

```ts
proxy.setRouter(ctx => ({
	target: { host: 'mc.hypixel.net', port: 25565 },
	proxy: { url: 'socks5://proxy.example.com:1080' },
	proxyProtocol: 1,
	rewrite: { host: 'mc.hypixel.net' }
}))
```

更多： [Hypixel 加速](./hypixel) · [速率限制策略](./rate-limit) · [缓存路由与 MOTD](./cache)
