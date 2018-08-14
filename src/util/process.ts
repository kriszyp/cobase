import { fork } from 'child_process'
import when from './when'
import * as net from 'net'
import * as path from 'path'
import { createSerializeStream, createParseStream } from 'dpack'
import { spawn, UpdateEvent, currentContext } from 'alkali'
import { CurrentRequestContext } from '../RequestContext'

let pipeServerStarted
const classMap = new Map<string, any>()
const streamByPid = new Map<number, any>()
const waitingRequests = new Map<number, { resolve: Function, reject: Function}>()
const whenConnected = new Map<number, Promise<any>>()
let nextRequestId = 1

function startPipeClient(processId) {
	if (whenConnected.get(processId)) {
		return whenConnected.get(processId)
	}
	let promise = new Promise((resolve, reject) => {
		const socket = net.createConnection(path.join('\\\\?\\pipe', 'cobase-' + processId))
		socket.on('error', reject).on('connect', resolve)
		let parsedStream = socket.pipe(createParseStream({
			//encoding: 'utf16le',
		})).on('error', console.error)
		let serializingStream = createSerializeStream({
			//encoding: 'utf16le'
		})
		serializingStream.pipe(socket)
		serializingStream.write({ // first thing: identify ourselves
			type: 'process-identification',
			pid: process.pid,
		})
		streams.push(serializingStream)
		socket.unref()
		parsedStream.on('data', (message) => {
			onMessage(message, serializingStream)
		})
		attachClasses(serializingStream)
	})
	whenConnected.set(processId, promise)
	return promise
}


function startPipeServer() {
	if (pipeServerStarted)
		return
	pipeServerStarted = true
	console.log('starting pipe server on ', process.pid)
	net.createServer((socket) => {
		console.log('pipe server got client ', process.pid)
		socket.pipe(createParseStream({
			//encoding: 'utf16le',
		})).on('data', (message) => {
			onMessage(message, serializingStream)
		})
		let serializingStream = createSerializeStream({
			encoding: 'utf16le',
		})
		serializingStream.pipe(socket)
		streams.push(serializingStream)
		attachClasses(serializingStream)
	}).on('error', (err) => {
	  // handle errors here
	  throw err;
	}).listen(path.join('\\\\?\\pipe', 'cobase-' + process.pid))
}
startPipeServer() // Maybe start it in the next event turn so you can turn it off in single process environment?
let streams = []

function attachClasses(stream) {
	for (const [className, Class] of classMap) {
		attachClass(stream, Class, className)
	}
}
function attachClass(stream, Class, className) {
	Class.notifies({
		updated(event, by) {
			// TODO: debounce
			//console.log('sending update event', className, process.pid)
			let id = by && by.id
			if (id && by === event.source) {
				stream.write({
					instanceId: id,
					method: 'updated',
					className,
					type: event.type,
					triggers: event.triggers,
				})
			}
		}
	})
	Class.sendBroadcast = notification => {
		for (const stream of streams) {
			notification.className = className
			stream.write(notification)
		}
	}
	Class.sendRequestToProcess = (pid, message) => {
		const requestId = message.requestId = nextRequestId++
		streamByPid.get(pid).write(message)
		return new Promise((resolve, reject) => waitingRequests.set(requestId, { resolve, reject }))
	}
	// declare this class listens on this stream
	stream.write({
		className,
		type: 'process-identification',
		pid: process.pid
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
			if (instanceId) {
				//console.log('<<<', message.type, message.className, message.instanceId)
				if (!target.instancesById) {
					console.log('Process proxy didnt have instancesById', ProcessProxy.name)
					target.initialize()
				}
				target = target.instancesById.get(instanceId)
				if (!target) {
					return
				}
			}
			if (requestId) {
				when(target.receiveRequest(message), (result) => {
					result.responseId = requestId
					stream.write(result)
				})
			} else {
				if (message.type) {
					const event = new UpdateEvent()
					event.sourceProcess = stream.pid
					event.source = { id: instanceId, remote: true }
					Object.assign(event, message)
					target.updated(event)
				} else {
					target.update(message)
				}
			}
		} else if (message.type === 'process-identification') {
			streamByPid.set(stream.pid = message.pid, stream)
		} else {
			console.warn('Unknown message received', message)
		}
	} catch(error) {
		console.error(error)
	}
}


export function registerClass(Class) {
	classMap.set(Class.name, Class)
	for (const stream of streams)
		attachClass(stream, Class, Class.name)
}

export function addProcess(pid) {
	return startPipeClient(pid)
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
