import { fork } from 'child_process'
import when from './when'
import * as net from 'net'
import * as path from 'path'
import { createSerializeStream, createParseStream } from 'dpack'
import { spawn, UpdateEvent, currentContext } from 'alkali'
import { CurrentRequestContext } from '../RequestContext'

let pipeServerStarted
const classMap = new Map<string, any>()

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

function startPipeClient(processId) {
	const socket = net.createConnection(path.join('\\\\?\\pipe', 'cobase-' + processId))
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
			const className = message.className
			const Class = classMap.get(className)
			if (Class && message.instanceId) {
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
			} else {
				if (message.type) {
					const event = new UpdateEvent()
					event.source = { id: message.instanceId, remote: true }
					Object.assign(event, message)
					Class.updated(event)
				} else {
					Class.update(message)
				}
				//console.warn('No listener found for ' + className)
			}
		} catch(error) {
			console.error(error)
		}
	})
	const send = (data) => serializingStream.write(data)
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
			//console.log('   >>>', message.method || message.type, message.className, message.instanceId)
			let Class = classMap.get(message.className)
			if (Class) {
				Class.updated(message)
			} else {
				const errorMessage = 'No class ' + message.className + ' registered to receive messages, ensure ' + message.className + '.start() is called first'
				throw new Error(errorMessage)
			}
		})
		let serializingStream = createSerializeStream({
			encoding: 'utf16le',
		})
		serializingStream.pipe(socket)
		streams.push(serializingStream)
		startClassNotification(serializingStream)

	}).on('error', (err) => {
	  // handle errors here
	  throw err;
	}).listen(path.join('\\\\?\\pipe', 'cobase-' + process.pid))
}
let streams = []

function startClassNotification(stream) {
	//console.log('startClassNotification', process.pid, Array.from(classMap.keys()))
	for (const [className, Class] of classMap) {
		Class.notifies({
			updated(event, by) {
				// TODO: debounce
				//console.log('sending update event', className, process.pid)
				let id = by && by.id
				if (id && by === event.source) {
					stream.write({
						instanceId: id,
						method: 'updated',
						className: className,
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
	}
}

const allProcesses = []
export function registerProcesses(processes, options) {
	// TODO: Options to allow self id, single child process id, no self, etc.
	// TODO: Return a promise for when the network is all connected and ready
	allProcesses.push(...processes)
	for (const childProcess of processes) {
		if (childProcess == process) {
			startPipeServer()
			continue
		}
		try {
			childProcess.send({
				enterNetwork: true
			})
		} catch(error) {
			console.error(error)
		}
		let responseListener = childProcess.on('message', (data) => {
			if (data.enteredNetwork) {
				// turn off responseListener and resolve promise
				for (const otherChildProcess of allProcesses) {
					if (otherChildProcess !== childProcess) {
						if (otherChildProcess.connected) {
							otherChildProcess.send({
								connectToProcess: childProcess.pid
							})
						} else {
							allProcesses.splice(allProcesses.indexOf(otherChildProcess), 1)
						}
					}
				}
				startPipeClient(childProcess.pid)
			}
		})
	}
}

export function registerClass(Class) {
	classMap.set(Class.name, Class)
}


export function createProcess(moduleId) {
	let childProcess
	const startProcess = () => {
		childProcess = fork(moduleId, [], {
			env: process.env,
			execArgv:['--stack-trace-limit=100'],
			stdio: [0, 1, 2, 'ipc'],
		})

		childProcess.unref()
		process.stdout.unref()
		process.stdin.unref()
		process.stderr.unref()
		childProcess.channel.unref()
		process.on('exit', () => childProcess.kill())
		console.log('created child process with module', moduleId)

	    childProcess.on('exit', (exitCode) => {
	      clearInterval(monitorInterval)
	      //if (exitCode || waitingForPong) {
	        console.error(process.pid + ' exit code: ' + exitCode)
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

	let processReady = new Promise((resolve, reject) => {
		childProcess.on('exit', (code, signal) => {
			console.log('Child process', process.pid, 'died', code, signal)
			setTimeout(startProcess, 1000)
		})
		childProcess.on('error', (error) => console.log('Child process error', error.toString()))
		childProcess.on('message', message => {
			console.log('got IPC message from child', process.pid)
		})
	})
	return childProcess
}
