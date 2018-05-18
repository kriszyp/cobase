import { fork } from 'child_process'
import when from './util/when'
import { Transform } from 'alkali'

const processMap = new Map<string, any>()
export const Process = (Class, { processName }) => {
	const inProcess = process.env.COBASE_SUBPROCESS == processName
	if (inProcess) {
		createProxyServer(Class)
		return Class
	}
	let childProcess = processMap.get(processName)
	if (!childProcess) {
		processMap.set(processName,
			childProcess = fork(module.id, [], {
				env: {
					COBASE_SUBPROCESS: processName,
				}
			}))
	}
	childProcess.on('message', (message) => {
		const id = message.id
		if (message.error) {
			messageFulfillments.get(id).reject(message.error)
		} else {
			messageFulfillments.get(id).resolve(message.result)
		}
	})
	const messageFulfillments = new Map<number, { resolve: (result) => void, reject: (error) => void }>()
	let requestId = 0
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
		static initialize() {
			this.instancesById = new Map()
		}
		transform() {
			return this.sendRequestToChild('valueOf')
		}
		put() {
			this.sendRequestToChild('put', arguments)
		}
		updated() {
			this.sendRequestToChild('updated')
			super.updated()
		}
		sendRequestToChild(method, args?) {
			const id = requestId++
			childProcess.send({
				id,
				instanceId: this.id,
				method,
				args
			})
			return new Promise((resolve, reject) => messageFulfillments.set(id, { resolve, reject }))
		}
	}
	for (const key in Class.prototype) {
		ProcessProxy.prototype[key] = function() {
			return this.sendRequestToChild(key, arguments)
		}
	}
}

function createProxyServer(Class) {
	process.on('message', (message) => {
		const { id, instanceId, method, args } = message.id
		let target = Class
		if (instanceId) {
			target = target.for(instanceId)
		}
		try {
			when(target[method].apply(target, args),
				(result) => process.send({ id, result }),
				(error) => process.send({ id, error }))
		} catch (error) {
			process.send({ id, error })
		}
	})
}
