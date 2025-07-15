import { createServer, connect } from 'net'
import type { Socket } from 'net'
import { randomBytes } from 'crypto'
import { strict as assert } from 'assert'
import { Geofront } from '../src/geofront'

// ===== 测试常量 =====
const PROXY_PORT = 20004
const BACKEND_PORT = 20005
const BACKEND_HOST = '127.0.0.1'
const TEST_HOST = 'mc.example.com'
const TEST_USERNAME = 'geofront_test'
const TEST_PROTOCOL_VERSION = 47 // 1.8.9
const DATA_SIZE = 8 * 1024 * 1024 // 8MB

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

// ===== 模拟后端服务器 =====
function startBackendServer(): Promise<{
	server: import('net').Server
	closed: Promise<void>
}> {
	return new Promise((resolve, reject) => {
		let server: import('net').Server
		const closedPromise = new Promise<void>((resolveClosed, rejectClosed) => {
			server = createServer(socket => {
				console.log('[Backend] 收到来自 Geofront 的连接')
				let receivedData = Buffer.alloc(0)
				let state = 'PROXY_PROTOCOL' // 新增状态
				let receivedDownstreamBytes = 0
				const serverUploadData = randomBytes(DATA_SIZE)

				socket.on('data', data => {
					try {
						receivedData = Buffer.concat([receivedData, data])

						if (state === 'PROXY_PROTOCOL') {
							const crlfIndex = receivedData.indexOf('\r\n')
							if (crlfIndex === -1) return // 等待完整头部

							const header = receivedData.toString('ascii', 0, crlfIndex)
							console.log(`[Backend] 收到 PROXY Protocol 头部: ${header}`)
							const parts = header.split(' ')
							assert.equal(parts[0], 'PROXY', '无效的 PROXY protocol 标志')
							assert.equal(parts[1], 'TCP4', '非预期的协议族')
							const clientIp = parts[2]
							console.log(`[Backend] ✓ 从头部解析出客户端 IP: ${clientIp}`)
							assert.equal(
								clientIp,
								'127.0.0.1',
								'PROXY protocol 传递的 IP 不正确'
							)
							console.log('[Backend] ✓ PROXY Protocol 头部验证通过')

							receivedData = receivedData.subarray(crlfIndex + 2)
							state = 'HANDSHAKE'
						}

						if (state === 'HANDSHAKE') {
							if (receivedData.length === 0) return
							const [packetLen, packetLenBytes] = readVarInt(receivedData, 0)
							if (receivedData.length < packetLen + packetLenBytes) return

							const packetStart = packetLenBytes
							const [packetId, packetIdBytes] = readVarInt(
								receivedData,
								packetStart
							)
							assert.equal(packetId, 0x00, '后端收到的握手包 ID 不正确')

							let offset = packetStart + packetIdBytes
							const [protoVer, protoVerBytes] = readVarInt(receivedData, offset)
							offset += protoVerBytes
							const [host, hostBytes] = readString(receivedData, offset)
							offset += hostBytes
							const port = receivedData.readUInt16BE(offset)
							offset += 2
							const [nextState, _] = readVarInt(receivedData, offset)

							console.log('[Backend] ✓ 验证握手包...')
							assert.equal(protoVer, TEST_PROTOCOL_VERSION, '协议版本不匹配')
							assert.equal(nextState, 2, '下一个状态不匹配')
							console.log('[Backend] ✓ 握手包验证通过')

							receivedData = receivedData.subarray(packetLen + packetLenBytes)
							state = 'LOGIN'
						}

						if (state === 'LOGIN') {
							if (receivedData.length === 0) return
							const [packetLen, packetLenBytes] = readVarInt(receivedData, 0)
							if (receivedData.length < packetLen + packetLenBytes) return

							const packetStart = packetLenBytes
							const [packetId, packetIdBytes] = readVarInt(
								receivedData,
								packetStart
							)
							assert.equal(packetId, 0x00, '后端收到的登录包 ID 不正确')

							let offset = packetStart + packetIdBytes
							const [username, _] = readString(receivedData, offset)

							console.log('[Backend] ✓ 验证登录包...')
							assert.equal(username, TEST_USERNAME, '用户名不匹配')
							console.log('[Backend] ✓ 登录包验证通过')

							const loginSuccessPacket = createLoginSuccessPacket(
								'00000000-0000-0000-0000-000000000000',
								username
							)
							socket.write(loginSuccessPacket)
							console.log('[Backend] ✓ 已发送登录成功包')

							receivedData = receivedData.subarray(packetLen + packetLenBytes)
							state = 'TRANSFER'
							console.log(
								`[Backend] 开始接收 ${DATA_SIZE / 1024 / 1024}MB 下行数据...`
							)
						}

						if (state === 'TRANSFER') {
							receivedDownstreamBytes += data.length
							if (receivedDownstreamBytes === data.length) {
								receivedDownstreamBytes = receivedData.length
							}

							if (receivedDownstreamBytes >= DATA_SIZE) {
								console.log(
									`[Backend] ✓ 下行数据接收完毕 (${receivedDownstreamBytes} 字节)`
								)
								assert.equal(
									receivedDownstreamBytes,
									DATA_SIZE,
									'下行数据大小不匹配'
								)
								console.log(
									`[Backend] 开始发送 ${DATA_SIZE / 1024 / 1024}MB 上行数据...`
								)
								socket.write(serverUploadData)
								state = 'DONE'
							}
						}
					} catch (e) {
						rejectClosed(e)
						socket.destroy()
					}
				})

				socket.on('close', () => {
					console.log('[Backend] 连接已关闭')
					if (state === 'DONE') {
						resolveClosed()
					} else {
						rejectClosed(new Error(`后端连接在非预期状态下关闭: ${state}`))
					}
				})

				socket.on('error', err => {
					rejectClosed(new Error(`后端 Socket 错误: ${err.message}`))
				})
			})

			server.listen(BACKEND_PORT, BACKEND_HOST, () => {
				console.log(
					`[Backend] 模拟服务器已在 ${BACKEND_HOST}:${BACKEND_PORT} 上启动`
				)
				resolve({ server, closed: closedPromise })
			})

			server.on('error', err => {
				reject(err)
			})
		})
	})
}

// ===== 模拟客户端 =====
function runClientTest(): Promise<void> {
	return new Promise((resolve, reject) => {
		const clientUploadData = randomBytes(DATA_SIZE)
		let receivedUpstreamBytes = 0
		let state = 'LOGIN'
		let receivedData = Buffer.alloc(0)

		const client = connect(PROXY_PORT, '127.0.0.1', () => {
			console.log(`[Client] ✓ 已连接到 Geofront on 127.0.0.1:${PROXY_PORT}`)

			const handshake = createHandshakePacket(
				TEST_PROTOCOL_VERSION,
				TEST_HOST,
				PROXY_PORT,
				2
			)
			client.write(handshake)
			console.log('[Client] ✓ 已发送握手包')

			const loginStart = createLoginStartPacket(TEST_USERNAME)
			client.write(loginStart)
			console.log('[Client] ✓ 已发送登录包')
		})

		client.on('data', data => {
			try {
				receivedData = Buffer.concat([receivedData, data])

				if (state === 'LOGIN') {
					const [packetLen, packetLenBytes] = readVarInt(receivedData, 0)
					if (receivedData.length < packetLen + packetLenBytes) return

					const packetStart = packetLenBytes
					const [packetId, _] = readVarInt(receivedData, packetStart)

					if (packetId === 0x02) {
						console.log('[Client] ✓ 收到登录成功包')
						state = 'TRANSFER'
						receivedData = receivedData.subarray(packetLen + packetLenBytes)

						console.log(
							`[Client] 开始发送 ${DATA_SIZE / 1024 / 1024}MB 下行数据...`
						)
						client.write(clientUploadData)
						console.log('[Client] ✓ 下行数据已发送')
					} else {
						throw new Error(`收到非预期的包，ID: 0x${packetId.toString(16)}`)
					}
				}

				if (state === 'TRANSFER' && receivedData.length > 0) {
					receivedUpstreamBytes += receivedData.length
					console.log(
						`[Client] 收到上行数据: ${receivedData.length} 字节 (总计: ${receivedUpstreamBytes})`
					)
					receivedData = Buffer.alloc(0)

					if (receivedUpstreamBytes >= DATA_SIZE) {
						console.log(
							`[Client] ✓ 上行数据接收完毕 (${receivedUpstreamBytes} 字节)`
						)
						assert.equal(receivedUpstreamBytes, DATA_SIZE, '上行数据大小不匹配')
						client.end()
					}
				}
			} catch (e) {
				reject(e)
				client.destroy()
			}
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
	console.log('=== 开始 Geofront PROXY Protocol 端到端测试 ===')
	let geofront: Geofront | null = null
	let backendServer: import('net').Server | null = null

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
			// 路由到后端服务器，并启用 PROXY protocol v1
			return {
				remoteHost: BACKEND_HOST,
				remotePort: BACKEND_PORT,
				proxyProtocol: 1
			}
		})
		console.log('[Geofront] ✓ 路由回调已设置')

		// 3. 启动监听器
		await geofront.listen('0.0.0.0', PROXY_PORT)
		console.log(`[Geofront] ✓ 代理监听器已启动在端口 ${PROXY_PORT}`)

		// 4. 启动后端服务器
		const { server, closed: backendPromise } = await startBackendServer()
		backendServer = server

		// 5. 运行客户端测试
		const clientPromise = runClientTest()

		// 6. 等待所有部分完成
		await Promise.all([backendPromise, clientPromise])

		console.log('\n✅✅✅ Geofront PROXY Protocol 端到端测试成功! ✅✅✅')
	} catch (error) {
		console.error('\n❌❌❌ Geofront PROXY Protocol 端到端测试失败! ❌❌❌')
		console.error(error)
		process.exit(1)
	} finally {
		// 7. 清理
		if (geofront) {
			console.log('[Geofront] 关闭...')
			await geofront.shutdown()
			console.log('[Geofront] ✓ 已关闭')
		}
		if (backendServer) {
			backendServer.close(() => {
				console.log('[Backend] ✓ 已关闭')
			})
		}
	}
}

main()
