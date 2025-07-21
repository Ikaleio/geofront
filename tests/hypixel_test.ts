import { describe, test } from 'bun:test'
import { Geofront } from '../src/geofront'

const PROXY_HOST = '0.0.0.0'
const PROXY_PORT = 32767
const HYPIXEL_HOST = 'mc.hypixel.net'
const HYPIXEL_PORT = 25565

describe.skip('Manual Test: Hypixel Proxy', () => {
	test('should run a proxy server for manual testing with a Minecraft client', async () => {
		console.log('=== 启动 Geofront Hypixel 代理 (手动测试) ===')
		const geofront = new Geofront()
		await geofront.initialize()
		geofront.setRouter((ip, host, player, protocol) => {
			console.log(
				`[Router] New connection: ip=${ip}, host=${host}, player=${player}, protocol=${protocol}`
			)
			return {
				remoteHost: HYPIXEL_HOST,
				remotePort: HYPIXEL_PORT,
				rewriteHost: HYPIXEL_HOST
			}
		})

		await geofront.listen(PROXY_HOST, PROXY_PORT)
		console.log(
			`✓ Geofront proxy for Hypixel is running on ${PROXY_HOST}:${PROXY_PORT}`
		)
		console.log('Connect to it with your Minecraft client.')
		console.log('Press Ctrl+C in the terminal to shut down.')

		// Keep the test running until manually stopped
		await new Promise(resolve => {
			process.on('SIGINT', () => {
				console.log('\nGracefully shutting down...')
				geofront.shutdown().then(resolve)
			})
		})
	})
})
