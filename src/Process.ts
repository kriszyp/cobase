import { fork } from 'child_process'
import when from './util/when'
import { currentContext, Transform, Variable } from 'alkali'
import { mergeProgress, registerProcessing, whenClassIsReady, DEFAULT_CONTEXT } from './UpdateProgress'
import * as net from 'net'
import * as path from 'path'
import { encode, createDecodeStream, createCodec } from 'msgpack-lite'
import { Persistable } from './Persisted'

const SUBPROCESS = process.env.COBASE_SUBPROCESS

const processMap = new Map<string, {
	processName: string
	moduleId: string
}>()

const ipcRequests = new Map<number, { resolve: (result) => void, reject: (error) => void }>()
let requestId = 1

export const runInProcess = (Class, { processName, module, onProcessStart }) => {
	console.log('run in process', SUBPROCESS, processName)
	const derivedClasses = new Map()
	const inProcess = SUBPROCESS == processName
	if (inProcess) {
		createProxyServer(Class)
		Class.inProcess = true
		const baseIndex = Class.index
		Class.index = function(name) {
			return getDerivedClass(name, () => baseIndex.apply(Class, arguments))
		}
		if (onProcessStart)
			onProcessStart()
		return Class
	}
	// Create proxy client object. First start the child process
	let startingQueue = []
	let sendToChild = (data) => startingQueue.push(encode(data))
	ensureProcessRunning(processName, module.id).then(({ send, addListener }) => {
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
				if (!ProcessProxy.instancesById) {
					console.log('Process proxy didnt have instancesById', ProcessProxy.name)
					ProcessProxy.initialize()
				}
				const instance = ProcessProxy.instancesById.get(message.instanceId)
				if (instance) { // don't create an instance just to notify it
					instance.localUpdated()
				}
			} else if (message.processing) {
				if (message.started) {
					ProcessProxy.whenReadable = new Promise((resolve, reject) => {
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
	class InstanceIds extends Transform {
		transform() {
			const id = requestId++
			sendToChild({
				id,
				method: 'valueOf',
				instanceId: 'instanceIds',
//				context,
				className: Class.name,
				args: [true],
			})
			return new Promise((resolve, reject) => messageFulfillments.set(id, { resolve, reject }))
		}

	}
	class ProcessProxy extends Transform {
		id: number
		// TODO: use the expiration strategy
		static for(id) {
			if (id > 0 && typeof id === 'string' || id == null) {
				throw new Error('Id should be a number or non-numeric string: ' + id + 'for ' + this.name)
			}
			let instancesById = this.instancesById
			if (!instancesById) {
				this.initialize()
				instancesById = this.instancesById
			}
			let instance = instancesById.get(id)
			if (!instance) {
				instance = new this(id)
				instancesById.set(id, instance)
			}
			return instance
		}
		static updated(event, by) {
			let instance
			for (let Source of this.Sources || []) {
				if (by && by.constructor === Source) {
					instance = this.for(by.id)
					instance.updated(event, by)
					return event
				}
			}
			for (let listener of this.listeners || []) {
				listener.updated(event, by)
			}
			if (Class.hasProcessing) {
				let context = currentContext
				let updateContext = (context && context.updatesInProgress) ? context : DEFAULT_CONTEXT
				registerProcessing(updateContext, this, this.whenReadable)
				registerProcessing(event, this, this.whenReadable)
			}
			return event
		}
		static notifies(target) {
			let context = currentContext
			if (context) {
				(this.listenersWithContext || (this.listenersWithContext = new Map())).set(target, context)
			}
			// standard variable handling (don't use alkali's contextual notifies)
			return Variable.prototype.notifies.call(this, target)
		}
		static stopNotifies(target) {
			// standard variable handling
			if (this.listenersWithContext) {
				this.listenersWithContext.delete(target)
			}
			return Variable.prototype.stopNotifies.call(this, target)
		}

		static index(name) {
			return getDerivedClass(name, () => Class.index(...arguments))
		}
		constructor(id) {
			super()
			this.id = id
		}
		static initialize() {
			console.log('Calling initialize on', this.name, Class.Sources)
			this.instancesById = new Map()
			for (let Source of Class.Sources || []) {
				console.log(this.name, ' has source class ', Source.name);
				(Source.Proxy || Source).notifies(this)
			}
		}
		static get name() {
			return Class.name
		}
		static instanceIds = new InstanceIds()
		transform() {
			return this.sendRequestToChild('valueOf', [true])
		}
		put() {
			return this.sendRequestToChild('put', arguments)
		}
		delete() {
			return this.sendRequestToChild('delete', arguments)
		}

		updated() {
			return this.sendRequestToChild('updated')
		}
		localUpdated(args?) {
			return Persistable.prototype.updated.apply(this, args)
		}

		resetCache(event) {
			//this._cachedValue = undefined
			//this.asJSON = undefined
		}

		sendRequestToChild(method, args?) {
			console.log('send request to child', method)
			const context = currentContext
			const id = requestId++
			sendToChild({
				id,
				instanceId: this.id,
				method,
//				context,
				className: Class.name,
				args: args && Array.from(args)
			})
			return new Promise((resolve, reject) => messageFulfillments.set(id, { resolve, reject }))
		}
		static sendRequestToChild(method, args?) {
			console.log('send static request to child', method)
			const context = currentContext
			const id = requestId++
			sendToChild({
				id,
				method,
//				context,
				className: Class.name,
				args: args && Array.from(args)
			})
			return new Promise((resolve, reject) => messageFulfillments.set(id, { resolve, reject }))
		}
	}
	for (const key of Object.getOwnPropertyNames(Class.prototype)) {
		if (!unproxiedProperties.includes(key) && typeof Class.prototype[key] == 'function') {
			console.log('Proxying method', key)
			Object.defineProperty(ProcessProxy.prototype, key, {
				value: function() {
					return this.sendRequestToChild(key, arguments)
				}
			})
		}
	}
	for (const key of Object.getOwnPropertyNames(Class)) {
		if (!unproxiedProperties.includes(key) && typeof Class[key] == 'function') {
			console.log('Proxying static method', key)
			Object.defineProperty(ProcessProxy, key, {
				value: function() {
					return this.sendRequestToChild(key, arguments)
				}
			})
		}
	}
	ProcessProxy.allow = Class.allow
	Class.Proxy = ProcessProxy
	function getDerivedClass(name, getDerived) {
		let derivedClass = derivedClasses.get(name)
		if (!derivedClass) {
			derivedClasses.set(name, derivedClass = runInProcess(getDerived(), { processName, module }))
		}
		return derivedClass
	}
	return ProcessProxy
}
function ensureProcessRunning(processName, moduleId): Promise<string> {
	let processReady = processMap.get(processName)
	if (!processReady) {
		console.log('starting process', processName)
		if (SUBPROCESS) {
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
			const socket = net.createConnection(path.join('\\\\?\\pipe', process.cwd(), 'myctl'))
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

const unproxiedProperties = ['constructor', 'prototype']
let createProxyServer
if (SUBPROCESS) {
	const classListeners = new Map<string, any>()
	process.on('message', message => ipcRequests.get(message.id).resolve(message))
	let sendToParentProcess
	net.createServer((socket) => {
		socket.pipe(createDecodeStream()).on('data', (message) => {
			console.log('child got message', message)
			classListeners.get(message.className)(message)
		})
		sendToParentProcess = (message) => {
			const buffer = encode(message)
			console.log('sending (from child to parent)', process.env.COBASE_SUBPROCESS, buffer.length, 'bytes', message)
			socket.write(buffer)
		}
	}).on('error', (err) => {
	  // handle errors here
	  throw err;
	}).listen(path.join('\\\\?\\pipe', process.cwd(), 'myctl'))
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


