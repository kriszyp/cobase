import { fork } from 'child_process'
import when from './when.js'
import * as net from 'net'
import * as path from 'path'
import { PackrStream, UnpackrStream } from 'msgpackr'
import * as alkali from 'alkali'; const { spawn, UpdateEvent, currentContext } = alkali.Variable ? alkali : alkali.default

let pipeServerStarted
const classMap = new Map<string, any>()
const streamByPidClass = new Map<string, any>()
const streamsByClass = new Map<string, any[]>()
const waitingRequests = new Map<number, { resolve: Function, reject: Function}>()
const whenProcessConnected = new Map<number, Promise<any>>()

const getPipePath = (processId) => path.join(path.sep == '/' ? '/tmp' : '\\\\?\\pipe', 'cobase-' + processId)
let nextRequestId = 1

function startPipeClient(processId, Class) {
	let whenConnected
	if (whenProcessConnected.has(processId)) {
		whenConnected = whenProcessConnected.get(processId)
	} else {
		whenConnected = new Promise((resolve, reject) => {
			const tryToConnect = (retries) => {
				const socket = net.createConnection(getPipePath(processId))
				let parsedStream = socket.pipe(new UnpackrStream()).on('error', (error) => {
					console.error('Error in pipe client socket', error)
				})
				let serializingStream = new PackrStream()
				serializingStream.pipe(socket)
				serializingStream.pid = processId
				let connected
				socket.on('error', (error) => {
					if (connected)
						console.error(error) // shouldn't happen after a connection
					else {
						if (retries > 2)
							reject(error)
						else
							setTimeout(() => {
								tryToConnect(retries + 1)
							}, 1500)
					}
				}).on('connect', () => {
					connected = true
					console.debug('Connected to process', processId)
					resolve(serializingStream)
				})
				socket.on('close', (event) => {
					serializingStream.emit('close', event)
				})
				socket.unref()
				parsedStream.on('data', (message) => {
					onMessage(message, serializingStream)
				})
			}
			tryToConnect(0)
		})
		whenProcessConnected.set(processId, whenConnected)
	}
	return whenConnected.then(stream => {
		attachClass(stream, Class, processId)
		// declare this class listens on this stream, by sending out a process identification
		stream.write({
			className: Class.name,
			pid: process.pid
		})
	})
}


function startPipeServer() {
	if (pipeServerStarted)
		return
	pipeServerStarted = true
	net.createServer((socket) => {
		socket.pipe(new UnpackrStream()).on('data', (message) => {
			onMessage(message, serializingStream)
		})
		let serializingStream = new PackrStream()
		socket.on('close', (event) => {
			serializingStream.emit('close', event)
		})
		serializingStream.pipe(socket)
		serializingStream.isIncoming = true
	}).on('error', (err) => {
	  // handle errors here
	  throw err;
	}).listen(getPipePath(process.pid))
}

function attachClasses(stream) {
	for (const [className, Class] of classMap) {
		attachClass(stream, Class, className)
	}
}
function attachClass(stream, Class, processId) {
	stream.pid = processId
	const className = Class.name
	let streams = streamsByClass.get(className)
	if (!streams) {
		streamsByClass.set(className, streams = [])
	}
	streams.push(stream)
	streamByPidClass.set(processId + '-' + className, stream)
	const otherProcesses = Class.otherProcesses || (Class.otherProcesses = [])
	if (!otherProcesses.includes(processId) && processId !== process.pid) {
		otherProcesses.push(processId)
	}
	const updater = {
		updated(event, by) {
			// TODO: debounce
			//console.log('sending update event', className, process.pid)
			let id = by && by.id
			if (id && event.source && by.constructor === event.source.constructor && !event.sourceProcess) {
				try {
					const eventToSerialize = Object.assign({}, event, {
						instanceId: id,
						method: 'updated',
						className,
						type: event.type,
					})
					delete eventToSerialize.visited
					delete eventToSerialize.source
					if (eventToSerialize.sources) {
						eventToSerialize.sources = Array.from(eventToSerialize.sources).map(source => ({
							id: source.id,
							typeName: source.constructor.name,
						}))
					}
					delete eventToSerialize.previousValues
					delete eventToSerialize.target
					delete eventToSerialize.oldValue
					delete eventToSerialize.whenWritten
					when(event.whenWritten, () =>
						stream.write(eventToSerialize))
				} catch(error) {
					// TODO: Not sure how we get in this state
					console.warn(error)
					Class.stopNotifies(updater)
				}
			}
		},
		stream,
		Class
	}
	Class.notifies(updater)
	Class.sendBroadcast = notification => {
		for (const stream of streams) {
			notification.className = className
			stream.write(notification)
		}
	}
	Class.sendRequestToProcess = (pid, message) => {
		const requestId = message.requestId = nextRequestId++
		message.className = Class.name
		const stream = streamByPidClass.get(pid + '-' + className)
		if (!stream) {
			return // TODO: If it is undefined wait for a connection
		}
		stream.write(message)
		return new Promise((resolve, reject) => waitingRequests.set(requestId, { resolve, reject }))
	}
	Class.sendRequestToAllProcesses = (message) => {
		message.className = Class.name
		return Promise.all(streams.map(stream => {
			const requestId = message.requestId = nextRequestId++
			stream.write(message)
			return new Promise((resolve, reject) => waitingRequests.set(requestId, { resolve, reject }))
		}))
	}
	stream.setMaxListeners(1000) // we are going to be adding a lot here
	stream.on('close', () => {
		Class.stopNotifies(updater)
		streams.splice(streams.indexOf(stream), 1)
		let otherProcessIndex = otherProcesses.indexOf(processId)
		if (otherProcessIndex > -1)
			otherProcesses.splice(otherProcessIndex, 1)
		streamByPidClass.delete(processId + '-' + className)
	})
}

function onMessage(message, stream) {
	try {
		const { requestId, responseId, className, instanceId } = message

		if (responseId) {
			const resolver = waitingRequests.get(responseId)
			waitingRequests.delete(responseId)
			return resolver.resolve(message)
		}
		let target = classMap.get(className)
		if (target) {
			if (requestId) {
				try {
					when(target.receiveRequest(message), (result) => {
						result = result || {}
						result.responseId = requestId
						stream.write(result)
					}, (error) => {
						stream.write({
							error,
							responseId: requestId
						})
					})
				} catch (error) {
					stream.write({
						error,
						responseId: requestId
					})					
				}
			} else {
				if (message.type) {
					const event = new UpdateEvent()
					event.sourceProcess = stream.pid
					event.source = target
					Object.assign(event, message)
					if (message.sources) {
						event.sources = message.sources.map(source => ({
							id: source.id,
							constructor: classMap.get(source.typeName)
						}))
					}
					target.updated(event, instanceId && { id: instanceId })
				} else if (message.pid) {
					attachClass(stream, target, message.pid)
				} else {
					target.update(message)
				}
			}
		} else {
			console.warn('Unknown message received', message)
		}
	} catch(error) {
		console.error('Handling message error', error)
	}
}

export function registerClass(Class) {
	startPipeServer() // Maybe start it in the next event turn so you can turn it off in single process environment?
	classMap.set(Class.name, Class)
}

export function addProcess(pid, Class) {
	return startPipeClient(pid, Class)
}

/*function onCloseSocket(stream, processId) {
	const pid = stream.pid
	let index = streams.indexOf(stream)
	if (index > -1)
		streams.splice(index, 1)
	let removed = 0
	for (let updater of updaters) {
		if (updater.stream === stream) {
			//console.log('stop notifications for', process.pid, 'from', pid)
			removed++
			updater.Class.stopNotifies(updater)
			index = updaters.indexOf(updater)
			if (index > -1)
				updaters.splice(index, 1)
		}
	}
	console.log('socket close from', process.pid, 'to', processId, pid, 'removed updaters', removed)
	streamByPid.set(pid, null) // set it to null, so we now it once existed and is dead
}

/*
// every child process should be ready to join the network
process.on('message', (data) => {
	if (data.enterNetwork) {
		console.log('Received request to start pipe server')
		// create pipe server
		startPipeServer()
		// need to send confirmation that it is set up.
		process.send({
			enteredNetwork: true
		})
	} else if (data.connectToProcess) {
		startPipeClient(data.connectToProcess)
	}
})
*/
