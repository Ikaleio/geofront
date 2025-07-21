# Geofront 示例

这个目录包含了 Geofront 的使用示例，展示了如何使用各种功能。

## 示例列表

### 1. 简单代理 (`simple.ts`)

基本的代理示例，展示：

- 基本路由功能
- 自定义 MOTD
- 条件性连接处理

```bash
bun run example/simple.ts
```

**功能演示：**

- 监听端口 25565
- 将 `example.com` 的连接转发到本地 25566 端口
- 其他连接将被拒绝并显示提示信息
- 自定义 MOTD 显示代理信息

### 2. Hypixel 代理 (`hypixel.ts`)

更高级的示例，连接到 Hypixel 服务器：

- 实时连接转发到 Hypixel
- 精美的 MOTD 设计
- 连接统计显示
- 主机名重写

```bash
bun run example/hypixel.ts
```

**功能演示：**

- 监听端口 32768
- 将所有连接转发到 `mc.hypixel.net:25565`
- 重写主机名确保正确路由
- 显示连接统计信息
- 自定义 Hypixel 主题的 MOTD

## 运行要求

确保您已经安装了依赖：

```bash
bun install
```

## 自定义示例

您可以基于这些示例创建自己的代理配置：

### 基本结构

```typescript
import { Geofront } from '../src/geofront'

const geofront = new Geofront()
await geofront.initialize()

// 设置路由
geofront.setRouter((ip, host, player, protocol) => {
	// 路由逻辑
	return {
		remoteHost: 'target.server.com',
		remotePort: 25565
	}
})

// 设置 MOTD
geofront.setMotdCallback((ip, host, player, protocol) => {
	return {
		version: { name: 'My Server', protocol },
		players: { max: 100, online: 0, sample: [] },
		description: { text: 'Welcome to my server!' },
		favicon: 'data:image/png;base64,...'
	}
})

await geofront.listen('0.0.0.0', 25565)
```

### 路由选项

路由回调可以返回：

1. **转发连接：**

```typescript
return {
	remoteHost: 'backend.server.com',
	remotePort: 25565,
	rewriteHost: 'new.hostname.com', // 可选：重写主机名
	proxy: 'socks5://proxy:1080', // 可选：使用代理
	proxyProtocol: 1 // 可选：PROXY 协议版本
}
```

2. **拒绝连接：**

```typescript
return {
	disconnect: '§c服务器维护中\n§7请稍后再试'
}
```

### MOTD 选项

MOTD 回调返回的对象结构：

```typescript
return {
	version: {
		name: '服务器名称',
		protocol: 758 // 或者使用传入的 protocol 参数
	},
	players: {
		max: 1000,
		online: 500,
		sample: [
			{ name: '§6VIP 玩家', id: 'uuid-here' },
			{ name: '§a在线玩家', id: 'uuid-here' }
		]
	},
	description: {
		text: '§6§l我的服务器 §r\n§7欢迎来玩！'
	},
	favicon: 'data:image/png;base64,...' // 64x64 PNG 图标的 base64 编码
}
```

或者返回断开连接：

```typescript
return {
	disconnect: '§c服务器暂时不可用'
}
```

## 调试技巧

1. **启用详细日志：** 在代码中添加 console.log 来跟踪连接
2. **测试连接：** 使用 Minecraft 客户端或工具如 [mcstatus](https://github.com/py-mine/mcstatus)
3. **检查端口：** 确保指定的端口没有被其他程序占用

## 故障排除

### 常见问题

1. **端口已被占用：**

   - 更改监听端口
   - 检查其他运行的 Minecraft 服务器

2. **无法连接到后端：**

   - 验证后端服务器地址和端口
   - 检查网络连接和防火墙设置

3. **MOTD 不显示：**
   - 确保 MOTD 回调已正确设置
   - 检查 favicon 格式是否正确（64x64 PNG）

需要更多帮助？查看项目的主 README 或提交 issue。
