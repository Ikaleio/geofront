---
description: Hypixel 加速：基于 SOCKS5 上游、连接并发控制与 VIP 动态代理策略的示例。
---

# Hypixel 加速示例

静态白名单 + Host 重写 + MOTD 处理。

```ts
import { Geofront, type RouteContext, type MotdContext } from 'geofront-ts'

// 静态白名单：真实生产可换为数据库/HTTP 服务 + 定时刷新
const WHITELIST = new Set<string>(['PlayerOne', 'PlayerTwo', 'Ikaleio'])

const proxy = Geofront.createProxy()

// 路由：只允许白名单玩家建立游戏连接；重写 host 绕过直连检测
proxy.setRouter((ctx: RouteContext) => {
	if (!WHITELIST.has(ctx.username)) {
		return Geofront.disconnect('§c未授权用户无法接入')
	}

	// 简易并发控制：同 IP 超过 5 条连接拒绝
	if (proxy.getConnectionsByIp(ctx.ip).length > 5) {
		return Geofront.disconnect('§c该 IP 连接数过多')
	}

	return {
		target: { host: 'mc.hypixel.net', port: 25565 },
		rewrite: { host: 'mc.hypixel.net' }
	}
})

// MOTD：展示当前在线与白名单剩余名额；未握手用户名阶段，只能显示全局信息
proxy.setMotdProvider((ctx: MotdContext) => {
	const active = proxy.getConnectionCount()
	const maxSlots = WHITELIST.size
	return {
		version: { name: 'Hypixel 加速 (WH)' },
		players: {
			max: maxSlots,
			online: active,
			sample: [
				`§a白名单名额: §e${active}/${maxSlots}`,
				`§a白名单名额: §e${active}/${maxSlots}`
			]
		},
		description: { text: '§6Hypixel 加速代理 §7(Geofront)' }
	}
})

await proxy.listen({ host: '0.0.0.0', port: 25565 })

console.log('Hypixel 加速代理已启动，监听 25565，白名单人数:', WHITELIST.size)

// 可选：定期输出简单指标
setInterval(() => {
	const m = proxy.getMetrics()
	console.log(
		'[metrics] active:',
		m.connections.active,
		'totalBytesSent:',
		m.traffic.totalBytesSent
	)
}, 10000)
```
