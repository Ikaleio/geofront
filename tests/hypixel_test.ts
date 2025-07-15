import { Geofront } from '../src/geofront'

// ===== 测试常量 =====
const PROXY_HOST = '0.0.0.0'
const PROXY_PORT = 32767
const HYPIXEL_HOST = 'mc.hypixel.net'
const HYPIXEL_PORT = 25565

// ===== 主测试函数 =====
async function main() {
	console.log('=== 启动 Geofront Hypixel 代理 ===')
	let geofront: Geofront | null = null

	try {
		geofront = new Geofront()

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
		console.log('Press Ctrl+C to shut down.')

		// Keep the process alive
		process.stdin.resume()
		process.on('SIGINT', async () => {
			console.log('\nGracefully shutting down...')
			if (geofront) {
				await geofront.shutdown()
			}
			process.exit(0)
		})
	} catch (error) {
		console.error('Failed to start Geofront proxy:', error)
		process.exit(1)
	}
}

main()
