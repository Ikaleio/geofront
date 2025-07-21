import { createServer, connect } from 'net'
import type { Socket, Server } from 'net'
import { randomBytes } from 'crypto'
import { strict as assert } from 'assert'
import { Geofront } from '../src/geofront'
import * as socks from 'socksv5'

// ===== 随机端口生成器 =====
export function getRandomPort(): number {
	return Math.floor(Math.random() * 1000) + 22000
}

// ===== 协议工具函数 =====

export function writeVarInt(value: number): Buffer {
	const buffers: Buffer[] = []
	do {
		let temp = value & 0x7f
		value >>>= 7
		if (value !== 0) temp |= 0x80
		buffers.push(Buffer.from([temp]))
	} while (value !== 0)
	return Buffer.concat(buffers)
}

export function writeString(str: string): Buffer {
	const strBuf = Buffer.from(str, 'utf8')
	return Buffer.concat([writeVarInt(strBuf.length), strBuf])
}

export function readVarInt(buffer: Buffer, offset: number): [number, number] {
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

export function readString(buffer: Buffer, offset: number): [string, number] {
	const [len, lenBytes] = readVarInt(buffer, offset)
	const start = offset + lenBytes
	const end = start + len
	if (end > buffer.length) {
		throw new Error('Buffer underflow while reading String')
	}
	const str = buffer.toString('utf8', start, end)
	return [str, lenBytes + len]
}

export function createHandshakePacket(
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

export function createLoginStartPacket(username: string): Buffer {
	const packetId = writeVarInt(0x00)
	const nameBuf = writeString(username)
	const data = Buffer.concat([packetId, nameBuf])
	return Buffer.concat([writeVarInt(data.length), data])
}

export function createLoginSuccessPacket(
	uuid: string,
	username: string
): Buffer {
	const packetId = writeVarInt(0x02)
	const uuidBuf = writeString(uuid)
	const nameBuf = writeString(username)
	const data = Buffer.concat([packetId, uuidBuf, nameBuf])
	return Buffer.concat([writeVarInt(data.length), data])
}

// ===== 测试常量 =====
export const TEST_CONSTANTS = {
	BACKEND_HOST: '127.0.0.1',
	TEST_HOST: 'mc.example.com',
	TEST_USERNAME: 'geofront_test',
	TEST_PROTOCOL_VERSION: 47, // 1.8.9
	DATA_SIZE: 1 * 1024 * 1024 // 1MB for faster tests
}

// ===== 模拟后端服务器 =====
export interface BackendOptions {
	port: number
	host?: string
	useProxyProtocol?: boolean
	onData?: (data: Buffer, socket: Socket) => void
}

export function startBackendServer(
	options: BackendOptions
): Promise<{ server: Server; closed: Promise<void> }> {
	const {
		port,
		host = TEST_CONSTANTS.BACKEND_HOST,
		useProxyProtocol = false
	} = options

	return new Promise((resolve, reject) => {
		let server: Server
		const closedPromise = new Promise<void>((resolveClosed, rejectClosed) => {
			server = createServer(socket => {
				let receivedData = Buffer.alloc(0)
				let state = useProxyProtocol ? 'PROXY_PROTOCOL' : 'HANDSHAKE'

				socket.on('data', data => {
					try {
						if (options.onData) {
							options.onData(data, socket)
							return
						}

						receivedData = Buffer.concat([receivedData, data])

						if (state === 'PROXY_PROTOCOL') {
							const crlfIndex = receivedData.indexOf('\r\n')
							if (crlfIndex === -1) return

							const header = receivedData.toString('ascii', 0, crlfIndex)
							const parts = header.split(' ')
							assert.equal(parts[0], 'PROXY')
							assert.equal(parts[1], 'TCP4')
							assert.equal(parts[2], '127.0.0.1')

							receivedData = receivedData.subarray(crlfIndex + 2)
							state = 'HANDSHAKE'
						}

						if (state === 'HANDSHAKE') {
							if (receivedData.length === 0) return
							const [packetLen, packetLenBytes] = readVarInt(receivedData, 0)
							if (receivedData.length < packetLen + packetLenBytes) return

							// NOTE: This is a simplified backend. It assumes handshake and login
							// packets arrive separately and completely for simplicity.
							// A more robust implementation would handle packet fragmentation.

							const loginSuccessPacket = createLoginSuccessPacket(
								'00000000-0000-0000-0000-000000000000',
								TEST_CONSTANTS.TEST_USERNAME
							)
							socket.write(loginSuccessPacket)
							socket.end() // End connection after login success
						}
					} catch (e) {
						rejectClosed(e)
						socket.destroy()
					}
				})

				socket.on('close', () => resolveClosed())
				socket.on('error', err => rejectClosed(err))
			})

			server.listen(port, host, () => {
				resolve({ server, closed: closedPromise })
			})

			server.on('error', err => reject(err))
		})
	})
}

// ===== 模拟客户端 =====
export interface ClientOptions {
	port: number
	host?: string
	onData?: (data: Buffer, client: Socket) => void
}

export function runClientTest(options: ClientOptions): Promise<void> {
	const { port, host = '127.0.0.1' } = options

	return new Promise((resolve, reject) => {
		const client = connect(port, host, () => {
			const handshake = createHandshakePacket(
				TEST_CONSTANTS.TEST_PROTOCOL_VERSION,
				TEST_CONSTANTS.TEST_HOST,
				port,
				2 // Login state
			)
			client.write(handshake)

			const loginStart = createLoginStartPacket(TEST_CONSTANTS.TEST_USERNAME)
			client.write(loginStart)
		})

		client.on('data', data => {
			if (options.onData) {
				options.onData(data, client)
			}
		})

		client.on('close', resolve)
		client.on('error', reject)
	})
}
