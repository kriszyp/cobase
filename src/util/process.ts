import { fork } from 'child_process'
import when from './when'
import * as net from 'net'
import * as path from 'path'
import { encode, createDecodeStream, createCodec } from 'msgpack-lite'
const SUBPROCESS = process.env.COBASE_SUBPROCESS

const processMap = new Map<string, {
	processName: string
	moduleId: string
}>()
let requestId = 1

const ipcRequests = new Map<number, { resolve: (result) => void, reject: (error) => void }>()

export const getProcessConnection = (Class, { processName, module, onProcessStart }) => {
	const inProcess = SUBPROCESS == processName
	if (inProcess) {
		return
	}
	let startingQueue = []
	let sendToChild = (data) => startingQueue.push(encode(data))

	ensureProcessRunning(processName, module).then(({ send, addListener }) => {
		addListener((message) => {
			const id = message.id
			if (id) {
				let response = messageFulfillments.get(id)
				if (response) {
					if (message.error) {
						response.reject(message.error)
					} else {
						response.resolve(message.result)
					}
				}
			} else if (message.instanceId) {
				if (!Class.instancesById) {
					console.log('Process proxy didnt have instancesById', ProcessProxy.name)
					Class.initialize()
				}
				const instance = Class.instancesById.get(message.instanceId)
				if (instance) { // don't create an instance just to notify it
					instance.localUpdated()
				}
			} else if (message.processing) {
				if (message.started) {
					Class.whenReadable = new Promise((resolve, reject) => {
						messageFulfillments.set('__whenReadable__', { resolve, reject })
					})
				} else {
					messageFulfillments.get('__whenReadable__').resolve(message.downstreamUpdates)
				}
			} else {
				console.warn('Unknown child process message', message)
			}
		})
		for (const data of startingQueue) {
			send(data)
		}

		startingQueue = null
		sendToChild = (data) => send(encode(data))
	})
	const messageFulfillments = new Map<number, { resolve: (result) => void, reject: (error) => void }>()
	return {
		sendMessage(data) {
			const id = requestId++
			data.id = id
			data.className = Class.name
			sendToChild(data)
			return new Promise((resolve, reject) => messageFulfillments.set(id, { resolve, reject }))
		}
	}
}

export function ensureProcessRunning(processName, moduleId): Promise<string> {
	let processReady = processMap.get(processName)
	if (!processReady) {
		console.log('starting process', processName)
		if (process.send) { // in sub-process
			console.log('requesting process start from parent')
			// we are in a child process, make a request to the parent process to ensure the child is running
			process.send({ startProcess: processName, id: processName, moduleId })
			processReady = new Promise((resolve, reject) =>
				ipcRequests.set(processName, { resolve, reject }))
		} else {
			console.log('creating child process', processName)
			let childProcess = fork(moduleId, [], {
				env: {
					COBASE_SUBPROCESS: processName,
				},
				execArgv:['--stack-trace-limit=100'],
				stdio: [0, 1, 2, 'ipc'],
			})

			childProcess.unref()
			process.stdout.unref()
			process.stdin.unref()
			process.stderr.unref()
			childProcess.channel.unref()
			process.on('exit', () => childProcess.kill())

			processReady = new Promise((resolve, reject) => {
				childProcess.on('exit', (code, signal) => console.log('Child process', processName, 'died', code, signal))
				childProcess.on('error', (error) => console.log('Child process error', error.toString()))
				childProcess.on('message', message => {
					console.log('got IPC message from child', processName)
					if (message.ready)
						resolve(processName)
					else if (message.startProcess)
						ensureProcessRunning(message.startProcess, message.moduleId).then(() => {
							childProcess.send({ id: message.id })
						})
				})
			})
		}
		processMap.set(processName, processReady = processReady.then(() => {
			const socket = net.createConnection(path.join('\\\\?\\pipe', process.cwd(), processName))
			let decodedStream = socket.pipe(createDecodeStream()).on('error', (err) => {
			  // handle errors here
			  throw err;
			})
			socket.unref()
			return {
				send: (data) => socket.write(data),
				addListener: (listener) => decodedStream.on('data', listener),
			}
		}))
	}
	return processReady
}

export let createProxyServer

if (SUBPROCESS) {
	const classListeners = new Map<string, any>()
	process.on('message', message => ipcRequests.get(message.id).resolve(message))
	let sendToParentProcess
	net.createServer((socket) => {
		socket.pipe(createDecodeStream()).on('data', (message) => {
			console.log('child got message', message)
			let listener = classListeners.get(message.className)
			if (!listener) {
				throw new Error('No class ' + message.className + ' registered to receive messages, try accessing .ready property first')
			}
			listener(message)
		})
		sendToParentProcess = (message) => {
			const buffer = encode(message)
			console.log('sending (from child to parent)', process.env.COBASE_SUBPROCESS, buffer.length, 'bytes', message)
			socket.write(buffer)
		}
	}).on('error', (err) => {
	  // handle errors here
	  throw err;
	}).listen(path.join('\\\\?\\pipe', process.cwd(), SUBPROCESS))
	setTimeout(() => console.log('hi'), 5000)
	process.send({ ready: true })
	console.log('finished setting up named pipe server')
	createProxyServer = (Class) => {
		const processMessage = (message) => {
			if (!Class.initialized) {
				console.log('Class not initalized yet, waiting to initialize')
				return Class.ready.then(() => processMessage(message))
			}
			const { id, instanceId, method, args } = message
			let target = Class
			if (instanceId) {
				console.log('using instanceId', instanceId)
				if (instanceId == 'instanceIds')
					target = target.instanceIds
				else
					target = target.for(instanceId)
			}
			try {
				when(target[method].apply(target, args),
					(result) => {
						if (result === undefined)
							sendToParentProcess({ id }) // undefined gets converted to null with msgpack
						else
							sendToParentProcess({ id, result })
					},
					(error) => sendToParentProcess({ id, error }))
			} catch (error) {
				sendToParentProcess({ id, error })
			}
		}
		classListeners.set(Class.name, processMessage)
		Class.notifies({
			updated(event, by) {
				// TODO: debounce
				let id = by && by.id
				if (id) {
					sendToParentProcess({
						instanceId: id,
						type: event.type,
					})
				}
			}
		})
		Class.onStateChange = state => {
			sendToParentProcess(state)
		}
	}
}
