import { fork } from 'child_process'
import when from './when'
import * as net from 'net'
import * as path from 'path'
import { createSerializeStream, createParseStream } from 'dpack'
import { spawn, UpdateEvent, currentContext } from 'alkali'
import { CurrentRequestContext } from '../RequestContext'
const SUBPROCESS = process.env.COBASE_SUBPROCESS
export const outstandingProcessRequests = new Map()

const processMap = new Map<string, Promise<any>>()
export const processModules = new Map<string, string>()
let requestId = 1

export const configure = (updatedProcessMap) => {
	for (const key in updatedProcessMap) {
		processModules.set(key, updatedProcessMap[key])
	}
}
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
		let whenReadable
		addListener(Class.name, (message) => {
			if (message.instanceId) {
				//console.log('<<<', message.type, message.className, message.instanceId)
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
				//console.log('<<<', 'processing', message.started ? 'started' : 'finished')
				if (message.started) {
					Class.whenReadable = new Promise((resolve, reject) => {
						whenReadable = { resolve, reject }
					})
				} else {
					whenReadable.resolve(message.downstreamUpdates)
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
				childProcess = fork(processModules.get(processName) || moduleId, [], {
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
			let parsedStream = socket.pipe(createParseStream({
				//encoding: 'utf16le',
			})).on('error', (err) => {
			  // handle errors here
			  throw err;
			})
			let serializingStream = createSerializeStream({
				//encoding: 'utf16le'
			})
			serializingStream.pipe(socket)
			socket.unref()
			parsedStream.on('data', (message) => {
				try {
					const id = message.id
					if (id) {
						let response = messageFulfillments.get(id)
						if (response) {
							if (message.error) {
								const error = {
									message: message.error.message,
									status: message.error.status,
									isExpected: message.error.isExpected,
								}
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
			const send = (data) => serializingStream.write(data)
			return {
				sendRequest(data) {
					const id = requestId++
					outstandingProcessRequests.set(id, data)
					data.id = id
					send(data)
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
	return processReady.then((channel) => {
		if (moduleId) {
			console.log('requesting starting module id ', moduleId)
			channel.sendRequest({
				startModule: moduleId
			})
		}
		return channel
	})
}

export let createProxyServer

if (SUBPROCESS) {
	const classListeners = new Map<string, any>()
	process.on('message', message => {
		if (message.id) {
			ipcRequests.get(message.id).resolve(message)
		}
	})
	let streams = []
	const broadcastToOtherProcesses = (message, method) => {
		// TODO: Use a Block and find a way to serialize once, and send to all messages
		//console.log(' * <<<', method, message.error ? message.error.message : ('result ' + typeof message.result))
		for (const stream of streams)
			stream.write(message)
	}
	const sendToProcess = (message, stream, method?) => {
		//console.log('   <<<', method, message.error ? message.error.message : ('result ' + typeof message.result))
		stream.write(message)
	}
	net.createServer((socket) => {
		socket.pipe(createParseStream({
			//encoding: 'utf16le',
		})).on('data', (message) => {
			console.log('   >>>', message.method || message.type, message.className, message.instanceId)
			let listener = classListeners.get(message.className)
			if (!listener) {
				if (message.startModule) {
					console.log('starting module', message.startModule)
					return require(message.startModule)
				}
				const errorMessage = 'No class ' + message.className + ' registered to receive messages, ensure ' + message.className + '.start() is called first'
				if (message.id) {
					console.warn(errorMessage)
					return sendToProcess({
						id: message.id,
						error: errorMessage
					}, serializingStream)
				} else {
					throw new Error(errorMessage)
				}
			}
			listener(message, serializingStream)
		})
		let serializingStream = createSerializeStream({
			encoding: 'utf16le',
		})
		serializingStream.pipe(socket)
		streams.push(serializingStream)

	}).on('error', (err) => {
	  // handle errors here
	  throw err;
	}).listen(path.join('\\\\?\\pipe', process.cwd(), SUBPROCESS))
	process.send({ ready: true })
	console.log('finished setting up named pipe server')
	createProxyServer = (Class) => {
		const processMessage = (message, stream) => {
			if (!Class.initialized) {
				console.log('Class not initalized yet, waiting to initialize')
				return Class.ready.then(() => processMessage(message, stream))
			}
			const { id, instanceId, method, args, context, startModule } = message
			let target = Class
			if (instanceId) {
				//console.log('using instanceId', instanceId)
				if (instanceId == 'instanceIds')
					target = target.instanceIds
				else
					target = target.for(instanceId)
			}
			try {
				const localContext = context && new CurrentRequestContext(null, context.session)
				const func = target[method]
				if (!func) {
					throw new Error('No method ' + method + ' found on ' + Class.name + ' ' + instanceId)
				}
				const execute = () => {
					let result = func.apply(target, args)
					if (result && result.next) {
						let constructor = result.constructor.constructor
						if ((constructor.displayName || constructor.name) === 'GeneratorFunction') {
							result = spawn(result)
						}
					}
					return result
				}

				when(localContext ? localContext.executeWithin(execute) : execute(), (result) => {
						if (result === undefined)
							sendToProcess({ id }, stream, method) // undefined gets converted to null with msgpack
						else
							sendToProcess({ id, result }, stream, method)
					},
					onError)
			} catch (error) {
				onError(error)
			}
			function onError(error) {
				console.error(error)
				var errorObject = {
					message: error.message,
					status: error.status,
					isExpected: error.isExpected
				}
				sendToProcess({ id, error: errorObject }, stream, method)
			}
		}
		classListeners.set(Class.name, processMessage)
		Class.ready.then(() => {
//			console.log(Class.name, 'is ready, listening for updates')
			Class.notifies({
				updated(event, by) {
					// TODO: debounce
					//console.log('sending update event')
					let id = by && by.id
					if (id && by === event.source) {
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
				state.className = Class.name
				broadcastToOtherProcesses(state, 'state change')
			}
		})
	}
}
