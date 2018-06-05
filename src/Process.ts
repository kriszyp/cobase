import { fork } from 'child_process'
import when from './util/when'
import { currentContext, Transform } from 'alkali'
import { mergeProgress, registerProcessing, whenClassIsReady } from './UpdateProgress'

const processMap = new Map<string, any>()
export const runInProcess = (Class, { processName, module }) => {
	console.log('run in process', process.env.COBASE_SUBPROCESS, processName)
	const inProcess = process.env.COBASE_SUBPROCESS == processName
	if (inProcess) {
		createProxyServer(Class)
		Class.inProcess = true
		const baseIndex = Class.index
		Class.index = function(name) {
			return getDerivedClass(name, () => baseIndex.apply(Class, arguments))
		}
		return Class
	}
	// Create proxy client object. First start the child process
	let childProcess = processMap.get(processName)
	if (!childProcess) {
		console.log('creating child process', processName)
		processMap.set(processName,
			childProcess = fork(module.id, [], {
				env: {
					COBASE_SUBPROCESS: processName,
				}
			}))
	}
	childProcess.on('message', (message) => {
		console.log('response from child', message)
		const id = message.id
		if (id) {
			if (message.error) {
				messageFulfillments.get(id).reject(message.error)
			} else {
				messageFulfillments.get(id).resolve(message.result)
			}
		} else if (message.instanceId) {
			Class.for(message.instanceId).updated()
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
	const messageFulfillments = new Map<number, { resolve: (result) => void, reject: (error) => void }>()
	let requestId = 1
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
			let context = currentContext
			let updateContext = (context && context.updatesInProgress) ? context : DEFAULT_CONTEXT
			registerProcessing(updateContext, this, this.whenReadable)
			registerProcessing(event, this, this.whenReadable)
		}
		static index(name) {
			return getDerivedClass(name, () => Class.index(...arguments))
		}
		constructor(id) {
			super()
			this.id = id
		}
		static initialize() {
			this.instancesById = new Map()
		}
		transform() {
			return this.sendRequestToChild('valueOf', [true])
		}
		put() {
			this.sendRequestToChild('put', arguments)
			super.updated()
		}
		delete() {
			this.sendRequestToChild('delete', arguments)
			super.updated()
		}

		updated() {
			this.sendRequestToChild('updated')
			super.updated()
		}
		sendRequestToChild(method, args?) {
			console.log('send request to child', method)
			const context = currentContext
			const id = requestId++
			childProcess.send({
				id,
				instanceId: this.id,
				method,
//				context,
				args: args && Array.from(args)
			})
			return new Promise((resolve, reject) => messageFulfillments.set(id, { resolve, reject }))
		}
		static sendRequestToChild(method, args?) {
			console.log('send static request to child', method)
			const context = currentContext
			const id = requestId++
			childProcess.send({
				id,
				method,
//				context,
				args: args && Array.from(args)
			})
			return new Promise((resolve, reject) => messageFulfillments.set(id, { resolve, reject }))
		}
	}
	for (const key of Object.getOwnPropertyNames(Class.prototype)) {
		if (!unproxiedProperties.includes(key)) {
			console.log('Proxying method', key)
			Object.defineProperty(ProcessProxy.prototype, key, {
				value: function() {
					return this.sendRequestToChild(key, arguments)
				}
			})
		}
	}
	for (const key of Object.getOwnPropertyNames(Class)) {
		if (!unproxiedProperties.includes(key)) {
			console.log('Proxying static method', key)
			Object.defineProperty(ProcessProxy, key, {
				value: function() {
					return this.sendRequestToChild(key, arguments)
				}
			})
		}
	}
	ProcessProxy.allow = Class.allow
	const derivedClasses = new Map()
	const getDerivedClass = (name, getDerived) => {
		let derivedClass = derivedClasses.get(name)
		if (!derivedClass) {
			derivedClasses.set(name, derivedClass = runInProcess(getDerived(), { processName, module }))
		}
		return derivedClass
	}
	return ProcessProxy
}

const unproxiedProperties = ['constructor', 'prototype']

function createProxyServer(Class) {
	process.on('message', (message) => {
		console.log('child got message', message)
		const { id, instanceId, method, args } = message
		let target = Class
		if (instanceId) {
			console.log('using instanceId', instanceId)
			target = target.for(instanceId)
		}
		try {
			when(target[method].apply(target, args),
				(result) => {
					console.log('finished', method, 'result', result)
					process.send({ id, result })
				},
				(error) => process.send({ id, error }))
		} catch (error) {
			process.send({ id, error })
		}
	})
	Class.notifies({
		updated(event, by) {
			// TODO: debounce
			let id = by && by.id
			if (id) {
				process.send({
					instanceId: id,
					type: event.type,
				})
			}
		}
	})
}
