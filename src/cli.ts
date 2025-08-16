#!/usr/bin/env bun
/**
 * Geofront CLI
 * Goal: quickly declare listeners and routing rules (host match + glob) and start the proxy.
 *
 * Features:
 * 1. Multiple inbound listeners: --listen 0.0.0.0:25565[,proxyProtocol=optional]
 * 2. Route rules: --route 'mc.example.com->10.0.0.5:25565' (exact) or --route '*.pvp.example.com->10.0.0.6:25565'
 * 3. Optional fields: proxy=socks5://host:port,pp=1|2,rewrite=backend.host
 *    Example: --route 'mc.example.com->10.0.0.5:25565,proxy=socks5://127.0.0.1:1080,pp=1,rewrite=mc.example.com'
 * 4. Multiple --route / --listen allowed.
 * 5. Global rate limit: --rate-limit-up / --rate-limit-down (MB/s).
 * 6. Periodic metrics: --metrics-interval (seconds); --quiet disables periodic metrics.
 * 7. Load JSON config: --config geofront.config.json
 *
 * JSON config example:
 * {
 *   "listeners": [ { "host": "0.0.0.0", "port": 25565, "proxyProtocol": "optional" } ],
 *   "routes": [
 *     { "pattern": "mc.example.com", "target": { "host": "10.0.0.5", "port": 25565 }, "proxy": "socks5://127.0.0.1:1080", "proxyProtocol": 1, "rewriteHost": "mc.example.com" }
 *   ],
 *   "rateLimit": { "uploadMBps": 50, "downloadMBps": 50 }
 * }
 */

import yargs from 'yargs/yargs'
import { hideBin } from 'yargs/helpers'
import { Geofront, type RouteResult, type RouterFn } from './geofront'
import { Glob } from 'bun'
import { readFile } from 'fs/promises'

// ==== Color helpers (ANSI) ====
const colors = {
	gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`
}

interface FileConfigRoute {
	pattern: string
	target: { host: string; port: number }
	proxy?: string
	proxyProtocol?: 1 | 2
	rewriteHost?: string
}
interface FileConfigListener {
	host: string
	port: number
	proxyProtocol?: 'none' | 'optional' | 'strict'
}
interface FileConfig {
	listeners?: FileConfigListener[]
	routes?: FileConfigRoute[]
	rateLimit?: {
		uploadMBps?: number
		downloadMBps?: number
		burstMultiplier?: number
	}
}

interface ParsedRouteSpec extends FileConfigRoute {
	isGlob: boolean
	glob?: Glob
}

function parseRouteSpec(spec: string): ParsedRouteSpec {
	const arrowIdx = spec.indexOf('->')
	if (arrowIdx === -1) {
		if (spec.endsWith('-')) {
			throw new Error(
				`Invalid route (truncated at '>'): ${spec}\nHint: quote or use -F pattern host:port form.`
			)
		}
		throw new Error(`Invalid route (missing '->'): ${spec}`)
	}
	const rawPattern = spec.slice(0, arrowIdx).trim()
	const right = spec.slice(arrowIdx + 2).trim()
	if (!rawPattern || !right)
		throw new Error(`Invalid route (missing pattern or target): ${spec}`)

	// Split right side into targetPart and optional kv segments
	const firstComma = right.indexOf(',')
	const targetPart = (
		firstComma === -1 ? right : right.slice(0, firstComma)
	).trim()
	const kvSegment = firstComma === -1 ? '' : right.slice(firstComma + 1)

	const colonIdx = targetPart.indexOf(':')
	if (colonIdx === -1)
		throw new Error(`Target missing port (host:port expected): ${spec}`)
	const targetHost = targetPart.slice(0, colonIdx).trim()
	const portStr = targetPart.slice(colonIdx + 1).trim()
	if (!targetHost || !portStr)
		throw new Error(`Target missing host or port: ${spec}`)
	const targetPort = Number(portStr)
	if (!Number.isFinite(targetPort) || targetPort <= 0 || targetPort > 65535)
		throw new Error(`Invalid target port: ${portStr} in ${spec}`)

	let proxy: string | undefined
	let proxyProtocol: 1 | 2 | undefined
	let rewriteHost: string | undefined
	if (kvSegment) {
		const seen = new Set<string>()
		for (const raw of kvSegment.split(',')) {
			const kv = raw.trim()
			if (!kv) continue
			const eq = kv.indexOf('=')
			if (eq === -1)
				throw new Error(`Invalid key=value segment '${kv}' in ${spec}`)
			const k = kv.slice(0, eq)
			const v = kv.slice(eq + 1)
			if (seen.has(k)) throw new Error(`Duplicate key '${k}' in ${spec}`)
			seen.add(k)
			switch (k) {
				case 'proxy':
					proxy = v
					break
				case 'pp': {
					const num = Number(v)
					if (num === 1 || num === 2) proxyProtocol = num
					else throw new Error(`pp must be 1 or 2 in ${spec}`)
					break
				}
				case 'rewrite':
					rewriteHost = v
					break
				default:
					throw new Error(`Unknown key '${k}' in ${spec}`)
			}
		}
	}

	const pattern = rawPattern.toLowerCase()
	const isGlob = /[*?[]/.test(pattern)
	return {
		pattern,
		target: { host: targetHost, port: targetPort },
		proxy,
		proxyProtocol,
		rewriteHost,
		isGlob,
		glob: isGlob ? new Glob(pattern) : undefined
	}
}

async function loadFileConfig(path?: string): Promise<FileConfig | undefined> {
	if (!path) return
	const raw = await readFile(path, 'utf8')
	return JSON.parse(raw)
}

function buildRouter(
	routeSpecs: ParsedRouteSpec[],
	verbose: boolean
): RouterFn {
	return ctx => {
		const host = ctx.host.toLowerCase()

		let spec = routeSpecs.find(r => !r.isGlob && r.pattern === host)
		if (!spec) spec = routeSpecs.find(r => r.isGlob && r.glob!.match(host))
		if (!spec) {
			return Geofront.disconnect(`Unknown host: ${host}`)
		}
		if (verbose)
			console.log(
				colors.gray(
					`[route] ${host} -> ${spec.target.host}:${spec.target.port}`
				)
			)
		const result: RouteResult = {
			target: spec.target,
			proxy: spec.proxy ? { url: spec.proxy } : undefined,
			proxyProtocol: spec.proxyProtocol,
			rewrite: spec.rewriteHost ? { host: spec.rewriteHost } : undefined
		}
		return result
	}
}

async function main() {
	if (typeof Bun === 'undefined') {
		console.error(
			colors.red('This CLI must run under Bun (bun run geofront ...)')
		)
		process.exit(1)
	}

	const argv = await yargs(hideBin(process.argv))
		.scriptName('geofront')
		.usage('$0 [options]')
		.option('listen', {
			alias: 'l',
			type: 'array',
			desc: 'Listener: ip:port[,proxyProtocol=optional|strict|none]',
			string: true
		})
		.option('F', {
			alias: 'from',
			// Accept pairs: -F pattern host:port (repeatable)
			type: 'array',
			nargs: 2,
			string: true,
			desc: 'Repeatable pair: -F <pattern> <host:port>'
		})
		.option('config', {
			alias: 'c',
			type: 'string',
			desc: 'Load JSON config file'
		})
		.option('rate-limit-up', {
			alias: 'U',
			type: 'number',
			desc: 'Global upload limit MB/s'
		})
		.option('rate-limit-down', {
			alias: 'D',
			type: 'number',
			desc: 'Global download limit MB/s'
		})
		.option('burst', {
			alias: 'b',
			type: 'number',
			desc: 'Rate limit burst multiplier (default 2)'
		})
		.option('metrics-interval', {
			alias: 'm',
			type: 'number',
			default: 0,
			desc: 'Metrics print interval seconds (0=off, default 0)'
		})
		.option('quiet', {
			alias: 'q',
			type: 'boolean',
			desc: 'Quiet mode (no periodic metrics)'
		})
		.option('verbose', {
			alias: 'v',
			type: 'boolean',
			desc: 'Verbose (show debug / route matches)'
		})
		.help()
		.alias('h', 'help')
		.example(
			'$0 -l 0.0.0.0:25565 -r mc.example.com->10.0.0.5:25565',
			'Minimal entry proxy'
		)
		.parse()

	const verbose = Boolean(argv.verbose)

	if (verbose) console.log(colors.gray(`[argv] ${JSON.stringify(argv)}`))

	const fileCfg = await loadFileConfig(argv.config as string | undefined)
	if (fileCfg && verbose) console.log(colors.gray('[config] loaded from file'))

	const listeners: FileConfigListener[] = []
	if (fileCfg?.listeners) listeners.push(...fileCfg.listeners)
	for (const l of (argv.listen as string[] | undefined) || []) {
		const segments = l.split(',')
		const hp = segments[0]
		const maybePP = segments[1]
		if (!hp) throw new Error(`Invalid listener: ${l}`)
		const hpSplit = hp.split(':')
		const h = hpSplit[0]
		const pStr = hpSplit[1]
		if (!h || !pStr) throw new Error(`Invalid listener: ${l}`)
		const port = Number(pStr)
		if (Number.isNaN(port)) throw new Error(`Invalid listener port: ${l}`)
		let proxyProtocol: 'none' | 'optional' | 'strict' | undefined
		if (maybePP) {
			const [k, v] = maybePP.split('=')
			if (k === 'proxyProtocol') {
				if (v === 'none' || v === 'optional' || v === 'strict')
					proxyProtocol = v
				else throw new Error(`Invalid proxyProtocol value: ${l}`)
			}
		}
		listeners.push({ host: h, port, proxyProtocol })
	}
	if (listeners.length === 0) throw new Error('At least one --listen required')

	const routeSpecs: ParsedRouteSpec[] = []
	if (fileCfg?.routes) {
		for (const r of fileCfg.routes) {
			routeSpecs.push({
				...r,
				isGlob: /[*?[]/.test(r.pattern),
				glob: /[*?[]/.test(r.pattern) ? new Glob(r.pattern) : undefined
			})
		}
	}
	// legacy --route removed; use -F/--from pairs or file config routes

	// Support -F <pattern> <host:port> pairs (repeatable)
	const fRaw = argv.F as unknown as any
	if (fRaw) {
		// yargs may return a flattened array like ['p','t','p2','t2'] or nested arrays [[p,t],[p2,t2]]
		let pairs: string[][] = []
		if (Array.isArray(fRaw) && fRaw.length > 0) {
			if (typeof fRaw[0] === 'string') {
				// flattened
				if (fRaw.length % 2 !== 0)
					throw new Error(
						'Invalid -F pairs: expected an even number of arguments'
					)
				for (let i = 0; i < fRaw.length; i += 2)
					pairs.push([fRaw[i], fRaw[i + 1]])
			} else {
				// nested
				for (const el of fRaw) {
					if (Array.isArray(el) && el.length === 2)
						pairs.push([String(el[0]), String(el[1])])
				}
			}
		}
		for (const [pattern, target] of pairs) {
			// allow target to include optional kvs after comma, e.g. host:port,proxy=...,pp=1,rewrite=...
			const combined = `${pattern}->${target}`
			if (verbose) console.log(colors.gray(`[route-pair] ${combined}`))
			try {
				routeSpecs.push(parseRouteSpec(combined))
			} catch (err: any) {
				throw new Error(
					`Invalid -F pair '${pattern} ${target}': ${err.message}`
				)
			}
		}
	}
	if (routeSpecs.length === 0)
		throw new Error(
			'At least one route required: provide -F/--from pairs or routes in a config file'
		)

	const proxy = Geofront.createProxy()

	const up =
		(argv['rate-limit-up'] as number | undefined) ??
		fileCfg?.rateLimit?.uploadMBps
	const down =
		(argv['rate-limit-down'] as number | undefined) ??
		fileCfg?.rateLimit?.downloadMBps
	const burstMult =
		(argv.burst as number | undefined) ??
		fileCfg?.rateLimit?.burstMultiplier ??
		2
	if (up || down) {
		proxy.setGlobalRateLimit(Geofront.rateLimit(up, down, burstMult))
		console.log(
			colors.cyan(
				`Global rate limit set: up=${up ?? '—'}MB/s down=${
					down ?? '—'
				}MB/s burst*x${burstMult}`
			)
		)
	}

	proxy.setRouter(buildRouter(routeSpecs, verbose))

	for (const cfg of listeners) {
		await proxy.listen({
			host: cfg.host,
			port: cfg.port,
			proxyProtocol: cfg.proxyProtocol
		})
		const proto = cfg.proxyProtocol ?? 'none'
		const protoStr = proto === 'none' ? '' : ` (proxyProtocol=${proto})`
		console.log(colors.green(`✔ Listening ${cfg.host}:${cfg.port}${protoStr}`))
	}

	const shutdown = async () => {
		console.log(colors.yellow('\nShutting down...'))
		await proxy.shutdown()
		process.exit(0)
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)

	const intervalSec = argv['metrics-interval'] as number
	if (!argv.quiet && intervalSec > 0) {
		setInterval(() => {
			const m = proxy.getMetrics()
			console.log(
				colors.bold(
					colors.gray(
						`[metrics] active=${m.connections.active} totalBytesSent=${m.traffic.totalBytesSent} totalBytesReceived=${m.traffic.totalBytesReceived}`
					)
				)
			)
		}, intervalSec * 1000)
	}
}

main().catch(err => {
	console.error(colors.red(`Failed to start: ${err.message}`))
	process.exit(1)
})
