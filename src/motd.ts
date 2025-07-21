// MOTD 组件和构建函数
// 基于 https://github.com/Ikaleio/transit/blob/main/src/motd.ts

import { z } from 'zod'

// 文本组件类型定义
export const Component = z
	.union([
		z.object({
			text: z.string(),
			bold: z.boolean().optional(),
			italic: z.boolean().optional(),
			underlined: z.boolean().optional(),
			strikethrough: z.boolean().optional(),
			obfuscated: z.boolean().optional(),
			color: z.string().optional(),
			insertion: z.string().optional(),
			extra: z.array(z.lazy((): z.ZodTypeAny => Component)).optional()
		}),
		z.string()
	])
	.transform(value => {
		if (typeof value === 'string') {
			// 简单字符串转换为组件格式
			return { text: value }
		}
		return value
	})

// 默认 MOTD favicon (1.8.9 style)
const DEFAULT_MOTD_FAVICON =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAAC6aXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAMAUExURQAAAP///wAAAPDw8NDQ0KCgoHBwcEBAQBAQEICAgGBgYJCQkLCwsODg4PAwMIAwMGAwMKAwMOAwMEAwMJAwMLAwMOAwQIAwQGAwQKAwQOAwQEAwQLAwQOAwUIAwUIAwYGAwYKAwYOAwYEAwYLAwYOAwcIAwcGAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcKAwcOAwcEAwcLAwcOAwgIAwgGAwgKAwgOAwgEAwgLAwgOAwkIAwkGAwkKAwkOAwkEAwkLAwkOAwoCAwoCAwcAAAAO3Q8MAAAA/3RSTlMAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl9gYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1+f4CBgoOEhYaHiImKi4yNjo+QkZKTlJWWl5iZmpucnZ6foKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr/AwcLDxMXGx8jJysvMzc7P0NHS09TV1tfY2drb3N3e3+Dh4uPk5ebn6Onq6+zt7u/w8fLz9PX29/j5+vv8/f7rCNvbAAAABklEQVRYw+2X'

// MOTD Schema 定义
export const MotdSchema = z
	.object({
		version: z
			.object({
				name: z.string().default('Geofront'),
				protocol: z.union([z.number(), z.literal('auto')]).default('auto')
			})
			.default(() => ({ name: 'Geofront', protocol: 'auto' as const })),
		players: z
			.object({
				max: z.number().default(20),
				online: z.union([z.number(), z.literal('auto')]).default('auto'),
				sample: z
					.array(
						z.union([
							z.object({
								name: z.string(),
								id: z.string()
							}),
							z.string()
						])
					)
					.transform(sample => {
						return sample.map(player => {
							if (typeof player === 'string') {
								return {
									name: player,
									id: '00000000-0000-0000-0000-000000000000'
								}
							}
							return player
						})
					})
					.default([
						{
							name: 'd',
							id: '00000000-0000-0000-0000-000000000000'
						},
						{
							name: 'Made by Ikaleio',
							id: '00000000-0000-0000-0000-000000000000'
						}
					])
			})
			.default(() => ({
				max: 20,
				online: 'auto' as const,
				sample: [
					{
						name: 'd',
						id: '00000000-0000-0000-0000-000000000000'
					},
					{
						name: 'Made by Ikaleio',
						id: '00000000-0000-0000-0000-000000000000'
					}
				]
			})),
		description: Component.default(() => ({
			text: 'd - High Performance Minecraft Proxy'
		})),
		favicon: z.string().default(DEFAULT_MOTD_FAVICON)
	})
	.default(() => ({
		version: { name: 'Geofront', protocol: 'auto' as const },
		players: {
			max: 20,
			online: 'auto' as const,
			sample: [
				{ name: 'd', id: '00000000-0000-0000-0000-000000000000' },
				{ name: 'Made by Ikaleio', id: '00000000-0000-0000-0000-000000000000' }
			]
		},
		description: { text: 'd - High Performance Minecraft Proxy' },
		favicon: DEFAULT_MOTD_FAVICON
	}))

export type MotdType = z.infer<typeof MotdSchema>

// 构建最终的 MOTD 对象，处理 'auto' 值
export const buildMotd = (
	motd: MotdType,
	onlinePlayers: number,
	protocol: number
): MotdType => {
	// 克隆 motd 避免修改原对象
	const result = JSON.parse(JSON.stringify(motd)) as MotdType

	// 处理 auto 值
	if (result.players.online === 'auto') {
		result.players.online = onlinePlayers
	}
	if (result.version.protocol === 'auto') {
		result.version.protocol = protocol
	}

	return result
}

// MOTD 回调返回结果类型
export type MotdResult = MotdType | { disconnect: string }
