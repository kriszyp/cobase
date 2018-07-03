import { fork } from 'child_process'
import when from './when'
import * as net from 'net'
import * as path from 'path'
import { encode, createDecodeStream, decode } from 'dpack'
import { UpdateEvent, currentContext } from 'alkali'
import { RequestContext } from '../RequestContext'
const SUBPROCESS = process.env.COBASE_SUBPROCESS
export const outstandingProcessRequests = new Map()

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
	let sendToChild = (data) => new Promise(resolve => startingQueue.push({
		data,
		resolve
	}))

	ensureProcessRunning(processName, module).then(({ sendRequest, addListener }) => {
		addListener(Class.name, (message) => {
			if (message.instanceId) {
				console.log('<<<', message.type, message.className, message.instanceId)
				if (!Class.instancesById) {
					console.log('Process proxy didnt have instancesById', ProcessProxy.name)
					Class.initialize()
				}
				const instance = Class.instancesById.get(message.instanceId)
				if (instance) { // don't create an instance just to notify it
					const event = new UpdateEvent()
					event.source = { id: message.instanceId, remote: true }
					Object.assign(event, message)
					instance.updated(event)
				}
			} else if (message.processing) {
				console.log('<<<', 'processing', message.started ? 'started' : 'finished')
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
		for (const request of startingQueue) {
			request.resolve(sendRequest(request.data))
		}

		startingQueue = null
		sendToChild = (data) => sendRequest(data)
	})
	return {
		sendMessage(data) {
			data.className = Class.name
			const context = currentContext
			data.context = context && {
				session: context.session
			}
			console.log('>>>', data.method || data.type, Class.name, data.instanceId, startingQueue ? '(queued)' : '')
			return sendToChild(data)
		}
	}
}

export function ensureProcessRunning(processName, moduleId): Promise<string> {
	let processReady = processMap.get(processName)
	if (!processReady) {
		console.log('starting process', processName, moduleId)
		if (SUBPROCESS) { // in sub-process
			console.log('requesting process start from parent')
			// we are in a child process, make a request to the parent process to ensure the child is running
			process.send({ startProcess: processName, id: processName, moduleId })
			processReady = new Promise((resolve, reject) =>
				ipcRequests.set(processName, { resolve, reject }))
		} else {
			let childProcess
			const startProcess = () => {
				childProcess = fork(moduleId, [], {
					env: Object.assign({}, process.env, {
						COBASE_SUBPROCESS: processName,
					}),
					execArgv:['--stack-trace-limit=100'],
					stdio: [0, 1, 2, 'ipc'],
				})

				childProcess.unref()
				process.stdout.unref()
				process.stdin.unref()
				process.stderr.unref()
				childProcess.channel.unref()
				process.on('exit', () => childProcess.kill())
				console.log('created child process', processName)

			    childProcess.on('exit', (exitCode) => {
			      clearInterval(monitorInterval)
			      //if (exitCode || waitingForPong) {
			        console.error(processName + ' exit code: ' + exitCode)
			      //}
			      startProcess()
			    })
			    let waitingForPong

			    childProcess.on('message', message => {
			      if (message.pong)
			        waitingForPong = false
			    })

			    const monitorInterval = setInterval(() => {
			      if (waitingForPong) {
			        console.error('No ping response received, restarting updating process')
			        childProcess.kill()
			      } else {
			        childProcess.send({ ping: true })
			        waitingForPong = true
			      }
			    }, 500000000).unref()
			}
			startProcess()

			processReady = new Promise((resolve, reject) => {
				childProcess.on('exit', (code, signal) => {
					console.log('Child process', processName, 'died', code, signal)
					setTimeout(startProcess, 1000)
				})
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
		const messageFulfillments = new Map<number, { resolve: (result) => void, reject: (error) => void }>()
		const classListeners = new Map<name, Function>()
		processMap.set(processName, processReady = processReady.then(() => {
			const socket = net.createConnection(path.join('\\\\?\\pipe', process.cwd(), processName))
			let decodedStream = socket.pipe(createDecodeStream()).on('error', (err) => {
			  // handle errors here
			  throw err;
			})
			socket.unref()
			decodedStream.on('data', (message) => {
				try {
					const id = message.id
					if (id) {
						let response = messageFulfillments.get(id)
						if (response) {
							if (message.error) {
								const error = new Error(message.error.message)
								error.status = message.error.status
								error.isExpected = message.error.isExpected
								response.reject(error)
							} else {
								response.resolve(message.result)
							}
						}
					} else {
						const className = message.className
						const listener = classListeners.get(className)
						if (listener) {
							listener(message)
						} else {
							console.warn('No listener found for ' + className)
						}
					}
				} catch(error) {
					console.error(error)
				}
			})
			const send = (data) => socket.write(data)
			return {
				sendRequest(data) {
					const id = requestId++
					outstandingProcessRequests.set(id, data)
					data.id = id
					const encoded = encode(data)
					send(encoded)
					return new Promise((resolve, reject) => messageFulfillments.set(id, {
						resolve(result) {
							outstandingProcessRequests.delete(id)
							console.log('<<<', data.method || data.type, data.className, data.instanceId, 'result', typeof result)
							resolve(result)
						},
						reject(error) {
							outstandingProcessRequests.delete(id)
							console.warn('<<<!!!', data.method || data.type, data.className, data.instanceId, error)
							reject(error)
						},
					}))
				},
				addListener: (className, listener) => classListeners.set(className, listener),
			}
		}))
	}
	return processReady
}

export let createProxyServer

if (SUBPROCESS) {
	const classListeners = new Map<string, any>()
	process.on('message', message => ipcRequests.get(message.id).resolve(message))
	let sockets = []
	const broadcastToOtherProcesses = (message, method) => {
		const buffer = encode(message)
		console.log(' * <<<', method, message.error ? message.error.message : ('result ' + typeof message.result))
		for (const socket of sockets)
			socket.write(buffer)
	}
	const sendToProcess = (message, socket, method?) => {
		const buffer = encode(message)
		console.log('   <<<', method, message.error ? message.error.message : ('result ' + typeof message.result))
		socket.write(buffer)
	}
	net.createServer((socket) => {
		socket.pipe(createDecodeStream()).on('data', (message) => {
			console.log('   >>>', message.method || message.type, message.className, message.instanceId)
			let listener = classListeners.get(message.className)
			if (!listener) {
				const errorMessage = 'No class ' + message.className + ' registered to receive messages, ensure ' + message.className + '.start() is called first'
				if (message.id) {
					console.warn(errorMessage)
					sendToProcess({
						id: message.id,
						error: errorMessage
					}, socket)
				} else {
					throw new Error(errorMessage)
				}
			}
			listener(message, socket)
		})
		sockets.push(socket)

	}).on('error', (err) => {
	  // handle errors here
	  throw err;
	}).listen(path.join('\\\\?\\pipe', process.cwd(), SUBPROCESS))
	process.send({ ready: true })
	console.log('finished setting up named pipe server')
	createProxyServer = (Class) => {
		const processMessage = (message, socket) => {
			if (!Class.initialized) {
				console.log('Class not initalized yet, waiting to initialize')
				return Class.ready.then(() => processMessage(message, socket))
			}
			const { id, instanceId, method, args, context } = message
			let target = Class
			if (instanceId) {
				console.log('using instanceId', instanceId)
				if (instanceId == 'instanceIds')
					target = target.instanceIds
				else
					target = target.for(instanceId)
			}
			try {
				console.log('executing', method)
				const localContext = context && new RequestContext(null, context.session)
				const func = target[method]
				if (!func) {
					throw new Error('No method ' + method + ' found on ' + Class.name + ' ' + instanceId)
				}
				when(localContext ? localContext.executeWithin(() => func.apply(target, args)) : func.apply(target, args),
					(result) => {
						if (result === undefined)
							sendToProcess({ id }, socket, method) // undefined gets converted to null with msgpack
						else
							sendToProcess({ id, result }, socket, method)
					},
					onError)
			} catch (error) {
				onError(error)
			}
			function onError(error) {
				var errorObject = {
					message: error.message,
					status: error.status,
					isExpected: error.isExpected
				}
				sendToProcess({ id, error: errorObject }, socket, method)
			}
		}
		classListeners.set(Class.name, processMessage)
		Class.notifies({
			updated(event, by) {
				// TODO: debounce
				console.log('sending update event')
				let id = by && by.id
				if (id) {
					broadcastToOtherProcesses({
						instanceId: id,
						method: 'updated',
						className: Class.name,
						type: event.type,
						triggers: event.triggers,
					}, event.type)
				}
			}
		})
		Class.onStateChange = state => {
			broadcastToOtherProcesses(state, 'state change')
		}
	}
}
