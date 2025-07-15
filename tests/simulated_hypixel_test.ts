import { connect } from 'net'
import type { Socket } from 'net'
import { strict as assert } from 'assert'
import { Geofront } from '../src/geofront'

// ===== 测试常量 =====
const PROXY_PORT = 20001
const TEST_HOST = 'mc.example.com' // The host client sends
const HYPIXEL_HOST = 'mc.hypixel.net' // The host we want to connect to
const HYPIXEL_PORT = 25565
const TEST_USERNAME = 'geofront_test'
const TEST_PROTOCOL_VERSION = 47 // 1.8.9

// ===== 协议工具函数 =====
function writeVarInt(value: number): Buffer {
	const buffers: Buffer[] = []
	do {
		let temp = value & 0x7f
		value >>>= 7
		if (value !== 0) temp |= 0x80
		buffers.push(Buffer.from([temp]))
	} while (value !== 0)
	return Buffer.concat(buffers)
}

function writeString(str: string): Buffer {
	const strBuf = Buffer.from(str, 'utf8')
	return Buffer.concat([writeVarInt(strBuf.length), strBuf])
}

function readVarInt(buffer: Buffer, offset: number): [number, number] {
	let numRead = 0
	let result = 0
	let read: number
	do {
		if (offset + numRead >= buffer.length) {
			throw new Error('Buffer underflow while reading VarInt')
		}
		read = buffer.readUInt8(offset + numRead)
		const value = read & 0x7f
		result |= value << (7 * numRead)
		numRead++
		if (numRead > 5) {
			throw new Error('VarInt is too big')
		}
	} while ((read & 0x80) !== 0)
	return [result, numRead]
}

function readString(buffer: Buffer, offset: number): [string, number] {
	const [len, lenBytes] = readVarInt(buffer, offset)
	const start = offset + lenBytes
	const end = start + len
	if (end > buffer.length) {
		throw new Error('Buffer underflow while reading String')
	}
	const str = buffer.toString('utf8', start, end)
	return [str, lenBytes + len]
}

function createHandshakePacket(
	protocolVersion: number,
	host: string,
	port: number,
	nextState: number
): Buffer {
	const packetId = writeVarInt(0x00)
	const pv = writeVarInt(protocolVersion)
	const hostBuf = writeString(host)
	const portBuf = Buffer.alloc(2)
	portBuf.writeUInt16BE(port, 0)
	const state = writeVarInt(nextState)
	const data = Buffer.concat([packetId, pv, hostBuf, portBuf, state])
	return Buffer.concat([writeVarInt(data.length), data])
}

function createLoginStartPacket(username: string): Buffer {
	const packetId = writeVarInt(0x00)
	const nameBuf = writeString(username)
	const data = Buffer.concat([packetId, nameBuf])
	return Buffer.concat([writeVarInt(data.length), data])
}

function createLoginSuccessPacket(uuid: string, username: string): Buffer {
	const packetId = writeVarInt(0x02)
	const uuidBuf = writeString(uuid)
	const nameBuf = writeString(username)
	const data = Buffer.concat([packetId, uuidBuf, nameBuf])
	return Buffer.concat([writeVarInt(data.length), data])
}

// ===== 模拟客户端 =====
function runClientTest(): Promise<void> {
	return new Promise((resolve, reject) => {
		const client = connect(PROXY_PORT, '127.0.0.1', () => {
			console.log(`[Client] ✓ 已连接到 Geofront on 127.0.0.1:${PROXY_PORT}`)

			const handshake = createHandshakePacket(
				TEST_PROTOCOL_VERSION,
				TEST_HOST,
				PROXY_PORT,
				2 // Next state: Login
			)
			client.write(handshake)
			console.log(`[Client] ✓ 已发送握手包 (Host: ${TEST_HOST})`)

			const loginStart = createLoginStartPacket(TEST_USERNAME)
			client.write(loginStart)
			console.log('[Client] ✓ 已发送登录包')
		})

		client.on('data', data => {
			console.log(`[Client] 收到来自服务器的数据:`)
			// Try to parse as a disconnect packet
			try {
				const [packetLen, packetLenBytes] = readVarInt(data, 0)
				const packetStart = packetLenBytes
				const [packetId, packetIdBytes] = readVarInt(data, packetStart)

				if (packetId === 0x00) {
					const [reason, _] = readString(data, packetStart + packetIdBytes)
					console.log(`  - 类型: Disconnect`)
					console.log(`  - 原因: ${reason}`)
				} else {
					console.log(`  - 未知包 (ID: 0x${packetId.toString(16)})`)
					console.log('  - Hex:', data.toString('hex'))
				}
			} catch (e) {
				console.log('  - 无法解析包, 原始数据 (Hex):', data.toString('hex'))
			}
			client.end()
		})

		client.on('close', () => {
			console.log('[Client] ✓ 连接已关闭')
			resolve()
		})

		client.on('error', err => {
			reject(new Error(`客户端连接错误: ${err.message}`))
		})
	})
}

// ===== 主测试函数 =====
async function main() {
	console.log('=== 开始 Geofront 模拟 Hypixel 测试 ===')
	let geofront: Geofront | null = null

	try {
		// 1. 创建 Geofront 实例
		console.log('[Geofront] 初始化...')
		geofront = new Geofront()
		console.log('[Geofront] ✓ 实例已创建')

		// 2. 设置路由回调
		geofront.setRouter((ip, host, player, protocol) => {
			console.log(
				`🚀 [Router] 收到新连接: ip=${ip}, host=${host}, player=${player}, protocol=${protocol}`
			)
			// 路由到 Hypixel 并重写 Host
			return {
				remoteHost: HYPIXEL_HOST,
				remotePort: HYPIXEL_PORT,
				rewriteHost: HYPIXEL_HOST
			}
		})
		console.log('[Geofront] ✓ 路由回调已设置')

		// 3. 启动监听器
		await geofront.listen('0.0.0.0', PROXY_PORT)
		console.log(`[Geofront] ✓ 代理监听器已启动在端口 ${PROXY_PORT}`)

		// 4. 运行客户端测试
		await runClientTest()

		console.log('\n✅✅✅ Geofront 模拟 Hypixel 测试完成 ✅✅✅')
	} catch (error) {
		console.error('\n❌❌❌ Geofront 模拟 Hypixel 测试失败! ❌❌❌')
		console.error(error)
		process.exit(1)
	} finally {
		// 5. 清理
		if (geofront) {
			console.log('[Geofront] 关闭...')
			await geofront.shutdown()
			console.log('[Geofront] ✓ 已关闭')
		}
	}
}

main()
