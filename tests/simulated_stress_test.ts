import { createServer, connect } from 'net'
import type { Socket } from 'net'
import { randomBytes } from 'crypto'
import { strict as assert } from 'assert'
import { Geofront } from '../src/geofront'

// ===== 测试常量 =====
const PROXY_PORT = 20001
const BACKEND_PORT = 20000
const BACKEND_HOST = '127.0.0.1'
const TEST_HOST = 'mc.example.com'
const TEST_USERNAME_PREFIX = 'stress_test_'
const TEST_PROTOCOL_VERSION = 47 // 1.8.9
const DATA_SIZE = 100 * 1024 * 1024 // 1MB
const CONCURRENT_CLIENTS = 10

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

function startBackendServer(expectedConnections: number): Promise<{
	server: import('net').Server
	closed: Promise<void[]>
}> {
	return new Promise((resolve, reject) => {
		let server: import('net').Server
		const connectionPromises: Promise<void>[] = []
		let connectionsHandled = 0

		const allClosedPromise = new Promise<void[]>((resolveAll, rejectAll) => {
			server = createServer(socket => {
				const connectionId = connectionsHandled++
				const logPrefix = `[Backend-${connectionId}]`
				console.log(`${logPrefix} 收到来自 Geofront 的连接`)

				const connectionPromise = new Promise<void>(
					(resolveConn, rejectConn) => {
						let receivedData = Buffer.alloc(0)
						let state = 'HANDSHAKE'
						let receivedDownstreamBytes = 0
						const serverUploadData = randomBytes(DATA_SIZE)

						socket.on('data', data => {
							try {
								receivedData = Buffer.concat([receivedData, data])

								if (state === 'HANDSHAKE') {
									const [packetLen, packetLenBytes] = readVarInt(
										receivedData,
										0
									)
									if (receivedData.length < packetLen + packetLenBytes) return

									const packetStart = packetLenBytes
									const [packetId, packetIdBytes] = readVarInt(
										receivedData,
										packetStart
									)
									assert.equal(
										packetId,
										0x00,
										`${logPrefix} 后端收到的握手包 ID 不正确`
									)

									let offset = packetStart + packetIdBytes
									const [protoVer, protoVerBytes] = readVarInt(
										receivedData,
										offset
									)
									offset += protoVerBytes
									const [host, hostBytes] = readString(receivedData, offset)
									offset += hostBytes
									const port = receivedData.readUInt16BE(offset)
									offset += 2
									const [nextState, _] = readVarInt(receivedData, offset)

									assert.equal(
										protoVer,
										TEST_PROTOCOL_VERSION,
										`${logPrefix} 协议版本不匹配`
									)
									assert.equal(nextState, 2, `${logPrefix} 下一个状态不匹配`)

									receivedData = receivedData.subarray(
										packetLen + packetLenBytes
									)
									state = 'LOGIN'
								}

								if (state === 'LOGIN') {
									if (receivedData.length === 0) return
									const [packetLen, packetLenBytes] = readVarInt(
										receivedData,
										0
									)
									if (receivedData.length < packetLen + packetLenBytes) return

									const packetStart = packetLenBytes
									const [packetId, packetIdBytes] = readVarInt(
										receivedData,
										packetStart
									)
									assert.equal(
										packetId,
										0x00,
										`${logPrefix} 后端收到的登录包 ID 不正确`
									)

									let offset = packetStart + packetIdBytes
									const [username, _] = readString(receivedData, offset)

									// assert.ok(
									// 	username.startsWith(TEST_USERNAME_PREFIX),
									// 	`${logPrefix} 用户名不匹配`
									// )

									const loginSuccessPacket = createLoginSuccessPacket(
										'00000000-0000-0000-0000-000000000000',
										username
									)
									socket.write(loginSuccessPacket)

									receivedData = receivedData.subarray(
										packetLen + packetLenBytes
									)
									state = 'TRANSFER'
								}

								if (state === 'TRANSFER') {
									receivedDownstreamBytes += data.length
									if (receivedDownstreamBytes === data.length) {
										receivedDownstreamBytes = receivedData.length
									}

									if (receivedDownstreamBytes >= DATA_SIZE) {
										assert.equal(
											receivedDownstreamBytes,
											DATA_SIZE,
											`${logPrefix} 下行数据大小不匹配`
										)
										socket.write(serverUploadData)
										state = 'DONE'
									}
								}
							} catch (e) {
								rejectConn(e)
								socket.destroy()
							}
						})

						socket.on('close', () => {
							if (state === 'DONE') {
								console.log(`${logPrefix} ✓ 连接已成功关闭`)
								resolveConn()
							} else {
								rejectConn(
									new Error(`${logPrefix} 后端连接在非预期状态下关闭: ${state}`)
								)
							}
						})

						socket.on('error', err => {
							rejectConn(
								new Error(`${logPrefix} 后端 Socket 错误: ${err.message}`)
							)
						})
					}
				)
				connectionPromises.push(connectionPromise)

				if (connectionPromises.length === expectedConnections) {
					Promise.all(connectionPromises).then(resolveAll).catch(rejectAll)
				}
			})

			server.listen(BACKEND_PORT, BACKEND_HOST, () => {
				console.log(
					`[Backend] 模拟服务器已在 ${BACKEND_HOST}:${BACKEND_PORT} 上启动, 等待 ${expectedConnections} 个连接...`
				)
				resolve({ server, closed: allClosedPromise })
			})

			server.on('error', err => {
				reject(err)
			})
		})
	})
}

// ===== 模拟客户端 =====
function runClientTest(id: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const logPrefix = `[Client-${id}]`
		const clientUploadData = randomBytes(DATA_SIZE)
		let receivedUpstreamBytes = 0
		let state = 'LOGIN'
		let receivedData = Buffer.alloc(0)
		const username = `${TEST_USERNAME_PREFIX}${id}`

		const client = connect(PROXY_PORT, '127.0.0.1', () => {
			const handshake = createHandshakePacket(
				TEST_PROTOCOL_VERSION,
				TEST_HOST,
				PROXY_PORT,
				2
			)
			client.write(handshake)

			const loginStart = createLoginStartPacket(username)
			client.write(loginStart)
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
						state = 'TRANSFER'
						receivedData = receivedData.subarray(packetLen + packetLenBytes)
						client.write(clientUploadData)
					} else {
						throw new Error(
							`${logPrefix} 收到非预期的包，ID: 0x${packetId.toString(16)}`
						)
					}
				}

				if (state === 'TRANSFER' && receivedData.length > 0) {
					receivedUpstreamBytes += receivedData.length
					receivedData = Buffer.alloc(0)

					if (receivedUpstreamBytes >= DATA_SIZE) {
						assert.equal(
							receivedUpstreamBytes,
							DATA_SIZE,
							`${logPrefix} 上行数据大小不匹配`
						)
						client.end()
					}
				}
			} catch (e) {
				reject(e)
				client.destroy()
			}
		})

		client.on('close', () => {
			console.log(`${logPrefix} ✓ 连接已关闭`)
			resolve()
		})

		client.on('error', err => {
			reject(new Error(`${logPrefix} 客户端连接错误: ${err.message}`))
		})
	})
}

// ===== 主测试函数 =====
async function main() {
	console.log(`=== 开始 Geofront 压力测试 (${CONCURRENT_CLIENTS} 个客户端) ===`)
	let geofront: Geofront | null = null
	let backendServer: import('net').Server | null = null

	try {
		geofront = new Geofront()

		geofront.setRouter((ip, host, player, protocol) => {
			return {
				remoteHost: BACKEND_HOST,
				remotePort: BACKEND_PORT
			}
		})

		await geofront.listen('0.0.0.0', PROXY_PORT)
		console.log(`[Geofront] ✓ 代理监听器已启动在端口 ${PROXY_PORT}`)

		const { server, closed: backendPromise } = await startBackendServer(
			CONCURRENT_CLIENTS
		)
		backendServer = server

		console.log(`[Test] 启动 ${CONCURRENT_CLIENTS} 个并发客户端...`)
		const clientPromises = []
		for (let i = 0; i < CONCURRENT_CLIENTS; i++) {
			clientPromises.push(runClientTest(i))
		}

		await Promise.all([backendPromise, ...clientPromises])

		console.log('\n[Geofront] 最终统计信息:')
		await geofront.updateMetrics()
		console.log(`  - 总连接数: ${geofront.metrics.total_conn}`)
		console.log(`  - 活跃连接数: ${geofront.metrics.active_conn}`)
		console.log(`  - 总发送字节: ${geofront.metrics.total_bytes_sent}`)
		console.log(`  - 总接收字节: ${geofront.metrics.total_bytes_recv}`)

		console.log('\n✅✅✅ Geofront 压力测试成功! ✅✅✅')
	} catch (error) {
		console.error('\n❌❌❌ Geofront 压力测试失败! ❌❌❌')
		console.error(error)
		process.exit(1)
	} finally {
		if (geofront) {
			await geofront.shutdown()
		}
		if (backendServer) {
			backendServer.close()
		}
	}
}

main()
