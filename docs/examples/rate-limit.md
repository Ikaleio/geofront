---
description: 速率限制：全局默认、按玩家分级与基于实时传输量的动态降速策略示例。
---

# 速率限制策略

## 全局默认限速

```ts
proxy.setGlobalRateLimit(Geofront.rateLimit(10, 10))
```

## 按用户分级

```ts
proxy.setEventHandlers({
	onConnectionEstablished: c => {
		if (c.player.startsWith('vip_')) {
			c.setRateLimit(Geofront.rateLimit(50, 50))
		} else if (c.player.startsWith('premium_')) {
			c.setRateLimit(Geofront.rateLimit(100, 100))
		} else {
			c.setRateLimit(Geofront.rateLimit(10, 10))
		}
		// ⚠️ 提示：基于名字前缀 (vip_/premium_) 的等级判定易被伪造，仅用于示例。
		// 生产：外部会员/订单系统 -> 缓存 (60s) -> 设置限速；失败回退基础档。
	}
})
```

## 动态调节大流量连接

```ts
setInterval(() => {
	for (const c of proxy.getConnections()) {
		const m = c.getMetrics()
		const total = m.bytesSent + m.bytesReceived
		if (total > 100 * 1024 * 1024) {
			c.setRateLimit(Geofront.rateLimit(1, 1))
		}
	}
}, 10_000)
```
