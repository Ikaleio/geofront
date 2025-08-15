import { defineConfig } from 'vitepress'
import llmstxt, { copyOrDownloadAsMarkdownButtons } from 'vitepress-plugin-llms'

// 临时修补：dev 下 vitepress-plugin-llms 对 .md 纯文本请求在已写入响应后仍可能继续 next()，
// 触发 ERR_HTTP_HEADERS_SENT。这里包一层自定义插件，替换其 configureServer，确保只写一次并返回。
function patchedLlmstxt(options: Parameters<typeof llmstxt>[0]) {
	const [pre, post] = llmstxt(options)
	const origConfigure = (post as any).configureServer
	;(post as any).configureServer = async (server: any) => {
		// 不调用原 configureServer，完全自定义安全中间件
		server.middlewares.use(async (req: any, res: any, next: any) => {
			if (!req.url) return next()
			// 仅处理 .md / llms*.txt 原始文本请求
			if (req.url.endsWith('.md') || req.url.endsWith('.txt')) {
				try {
					const urlPath = req.url.replace(/^\//, '')
					const fs = await import('node:fs/promises')
					// 若请求 llms-full.txt 且 dist 中不存在，尝试触发一次构建（利用已收集的 mdFiles 不方便，这里简单读取根 llms-full.txt 失败则回退合并基础文件）
					if (urlPath === 'llms-full.txt') {
						const distLLMS = new URL(
							`../.vitepress/dist/llms-full.txt`,
							import.meta.url
						).pathname
						let contentLLM: string | undefined
						try {
							contentLLM = await fs.readFile(distLLMS, 'utf-8')
						} catch {}
						if (!contentLLM) {
							const pathMod = await import('node:path')
							const root = new URL('..', import.meta.url).pathname
							const parts: string[] = []
							async function walk(dir: string) {
								const entries = await fs.readdir(dir, { withFileTypes: true })
								for (const e of entries) {
									if (e.name === '.vitepress') continue
									const full = pathMod.join(dir, e.name)
									if (e.isDirectory()) await walk(full)
									else if (e.isFile() && e.name.endsWith('.md')) {
										parts.push(await fs.readFile(full, 'utf-8'))
									}
								}
							}
							await walk(root)
							contentLLM = parts.join('\n---\n')
						}
						res.setHeader('Content-Type', 'text/plain; charset=utf-8')
						return res.end(contentLLM)
					}
					// 优先生成过的 dist 版本（防止 frontmatter 处理差异）
					const distPath = new URL(
						`../.vitepress/dist/${urlPath}`,
						import.meta.url
					).pathname
					let content: string | undefined
					try {
						content = await fs.readFile(distPath, 'utf-8')
					} catch {}
					if (!content && req.url.endsWith('.md')) {
						// 回落到源码 docs
						const srcPath = new URL(`../${urlPath}`, import.meta.url).pathname
						try {
							content = await fs.readFile(srcPath, 'utf-8')
						} catch {}
					}
					if (content) {
						if (!res.headersSent) {
							res.setHeader('Content-Type', 'text/plain; charset=utf-8')
						}
						return res.end(content)
					}
				} catch {}
			}
			return next()
		})
	}
	return [pre, post] as [any, any]
}

export default defineConfig({
	lang: 'zh-CN',
	title: 'Geofront',
	description: '高性能可编程 Minecraft 入口代理核心',
	lastUpdated: true,
	cleanUrls: true,
	themeConfig: {
		logo: '/logo.svg',
		outline: 'deep',
		nav: [
			{ text: '简介', link: '/' },
			{ text: '架构', link: '/guide/architecture' },
			{ text: 'API', link: '/api/' },
			{ text: '示例', link: '/examples/' },
			{ text: 'LLM', link: '/llms-full.txt' }
		],
		sidebar: {
			'/guide/': [{ text: '架构设计', link: '/guide/architecture' }],
			'/api/': [
				{ text: 'API 总览', link: '/api/' },
				{ text: '核心类', link: '/api/core' },
				{ text: '类型与事件', link: '/api/types-events' },
				{ text: '工具函数', link: '/api/utils' }
			],
			'/examples/': [
				{ text: '快速示例', link: '/examples/' },
				{ text: 'Hypixel 加速', link: '/examples/hypixel' },
				{ text: '速率限制策略', link: '/examples/rate-limit' },
				{ text: '缓存路由与 MOTD', link: '/examples/cache' }
			]
		},
		socialLinks: [
			{ icon: 'github', link: 'https://github.com/Ikaleio/geofront' }
		],
		editLink: {
			pattern: 'https://github.com/Ikaleio/geofront/edit/main/docs/:path',
			text: '在 GitHub 上编辑此页'
		},
		footer: {
			message: 'Released under the MIT License.',
			copyright: 'Copyright © 2024-present Ikaleio'
		},
		search: {
			provider: 'local'
		}
	},
	head: [
		['meta', { name: 'theme-color', content: '#151515' }],
		['link', { rel: 'icon', href: '/favicon.ico' }]
	],
	vite: {
		plugins: [
			patchedLlmstxt({
				title: 'Geofront Documentation'
			})
		]
	},
	markdown: {
		config(md) {
			md.use(copyOrDownloadAsMarkdownButtons)
		}
	}
})
