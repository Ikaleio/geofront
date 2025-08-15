---
description: Geofront TypeScript API 总览：命名空间、核心类、类型分类及快速入门示例导航。
---

# API 总览

Geofront 的 TypeScript API 通过命名空间 `Geofront` 与类 `GeofrontProxy` 暴露。

## 快速导航

- [核心类](./core)
- [类型与事件](./types-events)
- [工具函数与工厂](./utils)

## 最小示例

```ts
import { Geofront } from 'geofront-ts'

const proxy = Geofront.createProxy()
proxy.setRouter(ctx => ({ target: { host: '127.0.0.1', port: 25565 } }))
await proxy.listen({ host: '0.0.0.0', port: 25565 })
```

---

继续阅读： [核心类](./core) | [类型与事件](./types-events) | [工具函数](./utils)
