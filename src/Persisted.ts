import { Transform, VPromise, VArray, Variable, spawn, currentContext, NOT_MODIFIED, getNextVersion, ReplacedEvent, DeletedEvent, AddedEvent, UpdateEvent, Context } from 'alkali'
import { createEncoder, encode, decode, createDecoder } from 'dpack'
import * as lmdb from './storage/lmdb'
import when from './util/when'
import WeakValueMap from './util/WeakValueMap'
import ExpirationStrategy from './ExpirationStrategy'
import * as fs from 'fs'
import * as crypto from 'crypto'
import Index from './KeyIndex'
import { AccessError } from './util/errors'
import { toBufferKey, fromBufferKey } from 'ordered-binary'
import { Database, IterableOptions, OperationsArray } from './storage/Database'
//import { mergeProgress } from './UpdateProgress'
import { getProcessConnection, createProxyServer, processModules } from './util/process'
import { DEFAULT_CONTEXT } from './RequestContext'

const expirationStrategy = ExpirationStrategy.defaultInstance
const instanceIdsMap = new WeakValueMap()
const DB_VERSION_KEY = Buffer.from([1, 1]) // SOH, code 1
const LAST_VERSION_IN_DB_KEY = Buffer.from([1, 2]) // SOH, code 2
const INITIALIZATION_SOURCE = 'is-initializing'

global.cache = expirationStrategy // help with debugging

class InstanceIds extends Transform.as(VArray) {
	Class: any
	cachedValue: any
	cachedVersion: any
	transform() {
		return when(this.Class.resetProcess, () => this.Class.getInstanceIds())
	}
	getValue() {
		return when(super.getValue(true), ids => {
			expirationStrategy.useEntry(this, ids.length)
			return ids
		})
	}
	valueOf() {
		return super.valueOf(true) // always allow promises to be returned
	}
	clearCache() {
		this.cachedValue = undefined
		this.cachedVersion = -1
	}
}

const MakePersisted = (Base) => secureAccess(class extends Base {
	static DB: any
	static syncVersion: number
	static Cached: any
	_cachedValue: any
	_cachedVersion: number
	_versions: any
	version: number
	static useWeakMap = true
	static dbFolder = 'cachedb'
	static db: Database
	db: Database
	static updatingProcessConnection: {
		sendMessage(data: any): Promise<any>
	}

	constructor(id) {
		super()
		if (id == null) {
			throw new TypeError('No id provided')
		}
		if (this.constructor === Persisted) {
			throw new TypeError('Can not directly instantiate abstract Persisted class')
		}
		if (this.checkSourceVersions)
			this.readyState = 'invalidated' // start in this state for items that might not be updated so freshly loaded entities don't bypass version checks
		this.id = id
	}

	get checkSourceVersions() {
		// TODO: would like remove this once we have better invalidation of persisted entities
		return false
	}

	get staysUpdated() {
		return true
	}

	static get defaultInstance() {
		return this._defaultInstance || (this._defaultInstance = new Variable())
	}

	static for(id) {
		if (id > 0 && typeof id === 'string' || id == null) {
			throw new Error('Id should be a number or non-numeric string: ' + id + 'for ' + this.name)
		}
		let instancesById = this.instancesById
		if (!instancesById) {
			this.ready
			instancesById = this.instancesById
		}
		let instance = instancesById.get(id)
		if (!instance) {
			instance = new this(id)
			instancesById.set(id, instance)
		}
		return instance
	}

	// Defined as a convenience access to Class.for(id).valueOf()
	static get(id) {
		return this.for(id).valueOf()
	}

	// Defined as a convenience access to Class.for(id).put(value)
	static set(id, value) {
		return this.for(id).put(value)
	}

	static getByIds(ids) {
		// for optimized access to a set of ids
		if (!(ids instanceof Array))
			ids = Array.from(ids)
		let i = 0, l = ids.length
		let values = []
		let promised = []
		const getNext = () => {
			while (i < l) {
				let value = this.for(ids[i])
				if (value && value.then) {
					// a promise, put in the list of parallel promises
					let promisedI = i++
					promised.push(value.then(value => {
						values[promisedI] = value
					}))
					if (promised.length > (this.MAX_CONCURRENCY || 100)) {
						let promisedToFinish = promised
						promised = []
						return Promise.all(promisedToFinish).then(getNext)
					}
				} else {
					values[i++] = value
				}
			}
			if (promised.length > 0) {
				return Promise.all(promised)
			}
		}
		return when(getNext(), () => values)
	}

	assignPreviousValue(event) {
		let previousValues = event.previousValues
		if (!previousValues) {
			previousValues = event.previousValues = new Map()
		}
		if (this.readyState === 'up-to-date' && this._cachedValue) {
			return previousValues.set(this, this._cachedValue)
		}
		previousValues.set(this, when(this.loadLocalData(), ({ data }) => data))
	}

	static index(propertyName: string, indexBy?: (value, sourceKey) => any) {
		let index = this['index-' + propertyName]
		if (index) {
			return index
		}
		index = this['index-' + propertyName] = class extends Index({ Source : this }) {
			static indexBy(entity, sourceKey) {
				return indexBy ? indexBy(entity, sourceKey) : entity[propertyName]
			}
		}
		Object.defineProperty(index, 'name', { value: this.name + '-index-' + propertyName })
		return index
	}

	static reduce(name: string, reduceFunction: (accumulator, nextValue) => any) {
		let reduced = this['reduced-' + name]
		if (reduced) {
			return reduced
		}
		reduced = this['reduced-' + name] = class extends Reduced.from(this) {
			static reduceBy(a, b) {
				return reduceFunction.call(this, a, b)
			}
		}
		Object.defineProperty(reduced, 'name', { value: this.name + '-reduced-' + name })
		return reduced
	}

/*	static with(properties) {
		let DerivedClass = super.with(properties)
		DerivedClass.Sources = [this]
		let hasRelatedProperties
		for (let key of properties) {
			let property = properties[key]
			if (property.initialized) {
				property.initialized(this)
				hasRelatedProperties = true
			}

		}
		if (hasRelatedProperties) {
			DerivedClass.prototype.transform = function(data, ...propertySources) {
				for (let propertySource of propertySources) {
					data[DerivedClass.Sources[i].key] = propertySource
				}
				return data
			}
		}
		return DerivedClass
	}*/

	static relatesBy(foreignKey: string) {
		let TargetClass = this
		function relatesBy() {}
		relatesBy.defineAs = function(propertyName, Parent) {
			let RelatedIndex = TargetClass.index(foreignKey)
			let sourceIndex = Parent.Sources.push(RelatedIndex) - 1
			let existingTransform = Parent.prototype.transform
			Parent.prototype.transform = function(primaryData) {
				if (existingTransform) {
					primaryData = existingTransform.apply(this, arguments)
				}
				let source = arguments[sourceIndex]
				return Object.assign({ [propertyName]: source }, primaryData)
			}
			Parent.assign({
				[propertyName]: VArray.of(TargetClass)
			})
		}
		return relatesBy
	}

	static relatedBy(foreignKey: string) {
		let TargetClass = this
		function relatedBy() {}
		relatedBy.defineAs = function(propertyName, Parent) {
			let ParentSource = Parent.Sources[0]
			let RelatedIndex = ParentSource.index(foreignKey)
			let existingTransform = Parent.prototype.transform
			Parent.prototype.transform = function(primaryData) {
				if (existingTransform) {
					primaryData = existingTransform.apply(this, arguments)
				}
				return when(primaryData, primaryData => {
					let reference = foreignKey.call ? foreignKey(primaryData) : primaryData[foreignKey]
					return (reference instanceof Array ?
						Promise.all(reference.map(ref => TargetClass.for(ref))) :
						TargetClass.for(reference)).then(relatedValue =>
						Object.assign({ [propertyName]: relatedValue }, primaryData))
				})
			}
			TargetClass.notifies({
				updated(event, by) {
					RelatedIndex.for(by.id).getIndexedKeys().map(fromId => {
						Parent.for(fromId).updated(event)
					}).resolveData()
				}
			})
			Parent.assign({
				[propertyName]: TargetClass
			})
		}
		return relatedBy
	}

	static cacheWith(properties) {
		const CachedWith = Cached.from(this).assign(properties)
		Object.defineProperty(CachedWith, 'name', {
			value: this.name + '-with-' + Object.keys(properties).filter(key => properties[key] && properties[key].defineAs).join('-')
		})
		return CachedWith
	}

	transform(source) {
		return source
	}

	get allowDirectJSON() {
		return true
	}


	static updatesRecorded(event) {
		return (event && event.updatesInProgress) ? Promise.all(event.updatesInProgress) : Promise.resolve()
	}

	static get whenFullyReadable() {
		if (this.listeners)
			return Promise.all(this.listeners.map(listener => listener.whenFullyReadable))
		return Promise.resolve()
	}

	delete() {
		return this.constructor.remove(this.id)
	}

	reset(action) {
		this.updated()
	}

	static get ready() {
		return this.start()
	}
	static start() {
		if (!this.hasOwnProperty('_ready')) {
			let resolver
			this._ready = new Promise(resolve => resolver = resolve)
			resolver(this.initialize())
			this._ready.then(() => {
				this.initialized = true
			})
		}
		return this._ready
	}

	static register(sourceCode?: { id?: string, version?: number }) {
		// check the transform hash
		if (sourceCode) {
			let moduleFilename = sourceCode.id || sourceCode
			if (sourceCode.version) {
				// manually provide hash
				this.transformVersion = sourceCode.version
			} else if (typeof moduleFilename == 'string') {
				// create a hash from the module source
				this.transformVersion = fs.statSync(moduleFilename).mtime.getTime()
				let hmac = crypto.createHmac('sha256', 'cobase')
				hmac.update(fs.readFileSync(moduleFilename, { encoding: 'utf8' }))
			this.transformHash = hmac.digest('hex')
			}
		}
		return this.ready
	}

	static initialize() {
		this.instancesById = new (this.useWeakMap ? WeakValueMap : Map)()
		const db = this.prototype.db = this.db = Persisted.DB.open(this.dbFolder + '/' + this.name)
		clearTimeout(this._registerTimeout)
		if (global[this.name]) {
			throw new Error(this.name + ' already registered')
		}
		global[this.name] = this
		for (let Source of this.Sources || []) {
			Source.notifies(this)
		}
		this.instancesById.name = this.name
		if (processModules.get(this.updatingProcessName)) {
			this.updatingProcessConnection = getProcessConnection(this, { processName: this.updatingProcessName, module: this.module && this.module.id })
			if (this.updatingProcessConnection) {
				return
			} else {
				createProxyServer(this)
			}
		}
		// make sure these are inherited
		this.currentWriteBatch = null
		this.lastVersion = +db.getSync(LAST_VERSION_IN_DB_KEY) || 0
		let stateJSON = db.getSync(DB_VERSION_KEY)
		let didReset
		//console.log('DB starting state', this.name, stateJSON)
		let state = stateJSON && decode(stateJSON)
		if (state && (state.dbVersion || state.transformHash) == this.transformVersion) {
			this.startVersion = this.version = state.startVersion
		} else {
			console.log('transform/database version mismatch, reseting db table', this.name, state && state.dbVersion, this.transformVersion)
			this.startVersion = this.version = getNextVersion()
			const clearDb = !!state // if there was previous state, clear out all entries
			this.didReset = when(this.resetAll(clearDb), () => this.updateDBVersion())
		}
		return this.didReset
	}

	static findUntrackedInstances() {
		for (let instance of this.instancesById.values()) {
			if (instance._cachedValue && instance._cachedValue !== undefined) {
				if (!expirationStrategy.cache.indexOf(instance)) {
					console.log(instance.id, 'is untracked')
				}
			}
		}
	}

	static updatingProcessName = 'updating-process'

	set whenUpdateProcessed(promise) {
		this._whenUpdateProcessed = promise = promise.then((event) => {
			if (this._whenUpdateProcessed === promise) {
				this.version = event.version
				this._whenUpdateProcessed = null
			}
		}, (error) => {
			if (this._whenUpdateProcessed === promise) {
				this._whenUpdateProcessed = null
			}
		})
	}
	get whenUpdateProcessed() {
		return this._whenUpdateProcessed
	}
	centralUpdated({ type }) { // this should only be called in the updating process
		const event = new UpdateEvent()
		event.type = type
		this.updated(event, this)
		return {
			version: event.version
		}
	}
	updated(event = new ReplacedEvent(), by?) {
		const updatingProcessConnection = this.constructor.updatingProcessConnection
		const isUpdatingProcess = !updatingProcessConnection
		if (!event.source) {
			event.source = this
			// if we are the source, and there is a main updating process to notify, do that now, and use it as a mark not commit anything to the db (must be done in its updating process)
			if (updatingProcessConnection) {
				event.whenUpdateProcessed = updatingProcessConnection.sendMessage({
					instanceId: this.id,
					method: 'updated',
					args: [
						{ type: event.type }
					],
				})
			}
		}
		let context = currentContext
		if (context && !event.triggers && context.connectionId) {
			event.triggers = [ context.connectionId ]
		}

		let Class = this.constructor
		if (event.type === 'added') {
			// if we are being notified of ourself being created, ignore it
			this.constructor.instanceSetUpdated(event)
			if (this.readyState) {
				return event
			}
			if (this.cachedVersion > -1) {
				return event
			}
		}

		if (Class.updateWithPrevious && isUpdatingProcess) {
			this.assignPreviousValue(event)
		}
		if (by === this) // skip reset
			Variable.prototype.updated.apply(this, arguments)
		else
			super.updated(event, by)
		if (event.type == 'deleted') {
			this.readyState = 'no-local-data'
			this.constructor.instanceSetUpdated(event)
		} else if (by !== this && isUpdatingProcess) {
			this.resetCache()
		}
		// notify class listeners too
		for (let listener of this.constructor.listeners || []) {
			listener.updated(event, this)
		}
		if (!context || !context.expectedVersions) {
			context = DEFAULT_CONTEXT
		}
		context.expectedVersions[this.constructor.name] = event.version
		const whenUpdateProcessed = event.whenUpdateProcessed
		if (whenUpdateProcessed) {
			this.whenUpdateProcessed = whenUpdateProcessed
		}
		return event
	}

	static instanceSetUpdated(event) {
		let instanceIds = instanceIdsMap.get(this.name)
		if (instanceIds) {
			instanceIds.updated(event)
		}
	}

	resetCache() {
	}

	static updated(event, by?) {
		// this should be called by outside classes
		if (event && !event.version) {
			event.version = getNextVersion()
		}
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
		return event
	}

	static updateDBVersion() {
		let version = this.startVersion
		this.db.put(DB_VERSION_KEY, encode({
			startVersion: version,
			dbVersion: this.transformVersion
		}))
		return version
	}

	notifies(target) {
		let context = currentContext
		if (context) {
			(this.listenersWithContext || (this.listenersWithContext = new Map())).set(target, context)
		}
		return super.notifies(target)
	}
	stopNotifies(target) {
		// standard variable handling
		if (this.listenersWithContext) {
			this.listenersWithContext.delete(target)
		}
		return super.stopNotifies(target)
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
	static whenUpdatedInContext() {
		// transitively wait on all sources that need to update to this version
		let promises = []
		for (let Source of this.Sources || []) {
			let whenUpdated = Source.whenUpdatedInContext && Source.whenUpdatedInContext()
			if (whenUpdated && whenUpdated.then) {
				promises.push(whenUpdated)
			}
		}
		if (promises.length > 1) {
			return Promise.all(promises)
		} else if (promises.length == 1) {
			return promises[0]
		}
	}
	static get instanceIds() {
		let instanceIds = instanceIdsMap.get(this.name)
		if (!instanceIds) {
			instanceIdsMap.set(this.name, instanceIds = new InstanceIds())
			instanceIds.Class = this
		}
		return instanceIds
	}
	exclusiveLock(executeWithLock: () => any) {
		let promisedResult
		if (this.currentLock) {
			let context = currentContext
			const executeInContext = () => context.executeWithin(executeWithLock)
			promisedResult = this.currentLock.then(executeInContext, executeInContext)
		} else {
			let result = executeWithLock()
			if (result && result.then)
				promisedResult = result
			else
				return result
		}
		let thisLock, sync
		const afterExecution = () => {
			if (thisLock === this.currentLock) {
				this.currentLock = null
			}
			sync = true
		}
		thisLock = this.currentLock = promisedResult.then(afterExecution, (error) => {
			// Probably need to review if uncaught promise rejections are properly handled
			console.error(error)
			afterExecution()
		})
		if (sync) {
			this.currentLock = null
		}
		return promisedResult
	}
})

const KeyValued = (Base, { versionProperty, valueProperty }) => class extends Base {

	get dPackMultiplier() {
		return 1
	}

	get approximateSize() {
		return this.asDPack ? this.asDPack.length * this.dPackMultiplier : 100
	}

	loadLocalData(now, asBuffer) {
		let Class = this.constructor
		let db = Class.db
		return this.parseEntryValue(Class.db.get(toBufferKey(this.id)))
	}

	parseEntryValue(buffer) {
		if (buffer) {
			const decoder = createDecoder()
			decoder.setSource(buffer.toString(), 0)
			//decoder.setSource(buffer.slice(0,20).toString(), 0)  // the lazy version only reads the first fews bits to get the version
			const version = decoder.readOpen()
			if (decoder.hasMoreData) {
				return {
					version,
					data: decoder.readOpen(), // decodeLazy(buffer.slice(decoder.offset), decoder)
					buffer,
				}
			} else {
				// stored as an invalidated version
				return {
					version,
					buffer,
				}
			}
		} else {
			return {}
		}
	}

	loadLatestLocalData() {
		this.readyState = 'loading-local-data'
		let isSync
		let promise = when(this.loadLocalData(false, this.allowDirectJSON), (entry) => {
			const { version, data, buffer } = entry
			if (isSync === undefined)
				isSync = true
			else
				this.promise = null
			if (data) {
				this.readyState = 'up-to-date'
				this.version = Math.max(version, this.version || 0)
				this[versionProperty] = version
				this._cachedValue = data
				expirationStrategy.useEntry(this, this.dPackMultiplier * buffer.length)
			} else if (version) {
				this.version = Math.max(version, this.version || 0)
				this.readyState = 'invalidated'
			} else {
				this.updateVersion()
				this.readyState = 'no-local-data'
			}
			return entry
		})
		if (isSync)
			return promise
		isSync = false
		return this.promise = promise
	}

	static getInstanceIds(range: IterableOptions) {
		let db = this.db
		let options: IterableOptions = {
			gt: Buffer.from([4]),
			values: false
		}
		if (range) {
			if (range.gt != null)
				options.gt = toBufferKey(range.gt)
			if (range.lt != null)
				options.lt = toBufferKey(range.lt)
			if (range.gte != null)
				options.gte = toBufferKey(range.gte)
			if (range.lte != null)
				options.lte = toBufferKey(range.lte)
		}
		return db.iterable(options).map(({ key }) => fromBufferKey(key)).asArray
	}

	static entries(opts) {
		let db = this.db
		return db.iterable({
			gt: Buffer.from([2])
		}).map(({ key, value }) => ({key: fromBufferKey(key), value})).asArray
	}

	/**
	* Iterate through all instances to find instances since the given version
	**/
	static getInstanceIdsAndVersionsSince(sinceVersion: number): { id: number, version: number }[] {
		return this.ready.then(() => {
			let db = this.db
			this.lastVersion = this.lastVersion || +db.getSync(LAST_VERSION_IN_DB_KEY) || 0
			let isFullReset = this.startVersion > sinceVersion
			if (this.lastVersion && this.lastVersion <= sinceVersion && !isFullReset) {
				return []
			}
			console.log('Scanning for updates from', sinceVersion, this.lastVersion, isFullReset, this.name)
			return db.iterable({
				gt: Buffer.from([2])
			}).map(({ key, value }) => {
				const separatorIndex = value.indexOf(',')
				const version = separatorIndex > -1 ? +value.slice(0, separatorIndex) : +value
				return version > sinceVersion ? {
					id: fromBufferKey(key),
					version
				} : null
			}).filter(idAndVersion => {
				return idAndVersion
			}).asArray.then(idsAndVersions => {
				if (idsAndVersions.length > 10000) {
					console.info('Sorting', idsAndVersions.length, 'versions of', this.name, 'for resuming updates, this may take some time')
				}
				idsAndVersions.sort((a, b) => a.version > b.version ? 1 : a.version < b.version ? -1 : 0)
				if (idsAndVersions.length > 10000) {
					console.info('Finished sorting', this.name)
				}
				idsAndVersions.isFullReset = isFullReset
				return idsAndVersions
			})
		})
	}

	put(value, event?) {
		if (this.constructor.updatingProcessConnection) {
			event = event || new ReplacedEvent()
			this.whenUpdateProcessed = event.whenUpdateProcessed = this.constructor.updatingProcessConnection.sendMessage({
				instanceId: this.id,
				method: 'put',
				args: [value],
			})
			this.updated(event)
			return event.whenUpdateProcessed
		}
		return super.put(value, event)
	}

	static remove(id, event?) {
		if (id > 0 && typeof id === 'string' || !id) {
			throw new Error('Id should be a number or non-numeric string: ' + id)
		}
		if (this.updatingProcessConnection) {
			event = event || new DeletedEvent()
			this.whenUpdateProcessed = event.whenUpdateProcessed = this.updatingProcessConnection.sendMessage({
				method: 'delete',
				instanceId: id,
			})
			this.updated(event)
			return event.whenUpdateProcessed
		}

		event || (event = new DeletedEvent())
		let entity = this.for(id)
		entity.readyState = 'no-local-data'
		event.source = entity
		event.oldValue = when(entity.loadLocalData(), ({ data }) => data)
		this.instanceSetUpdated(event)
		if (this.updateWithPrevious) {
			entity.assignPreviousValue(event)
		}
		expirationStrategy.deleteEntry(entity)
		this.dbPut(id)
		this.instancesById.delete(id)
		this.updated(event, entity)
	}

	get [valueProperty]() {
		return this._cachedValue
	}

	set [valueProperty](value) {
		this._cachedValue = value
		let newToCache = this.readyState == 'no-local-data'
		if (newToCache) {
			this.readyState = 'loading-local-data'
		}
		if (this.constructor.updatingProcessConnection) {
			return // only the updating process should update the value in the db
		}
		if (this.constructor.returnsAsyncIterables) {
			value = when(value, value => {
				let resolutions = []
				function resolveData(data) {
					if (typeof data === 'object' && !(data instanceof Array)) {
						if (data[Symbol.asyncIterator]) {
							let asArray = data.asArray
							if (asArray.then)
								resolutions.push(data.asArray)
						} else {
							for (let key of data) {
								resolveData(data[key])
							}
						}
					}
				}
				resolveData(value)
				if (resolutions.length > 0) {
					return (resolutions.length > 1 ? Promise.all(resolutions) : resolutions[0]).then(() => value)
				}
				return value
			})
		}
		let result = when(value, value => {
			if (!value) {
				if (newToCache) {
					this.readyState = 'no-local-data'
					// object not found, this basically results in a 404, no reason to store or keep anything
					return
				}
				console.warn('Setting empty value', value, 'for', this.id, this.constructor.name)
				this.readyState = 'invalidated'
			}
			let data = ''
			let result

			let Class = this.constructor
			if (this.shouldPersist !== false) {
				let db = Class.db
				let version = this[versionProperty]
				data = this.serializeEntryValue(version, value)
				Class.dbPut(this.id, data, version) // no need to wait for it, should be synchronously available through the cache
				if (newToCache) {
					// fire an updated, if it is a new object
					let event = new AddedEvent()
					event.triggers = [ INITIALIZATION_SOURCE ]
					event.source = this
					event.version = version
					Class.instanceSetUpdated(event)
					Class.updated(event, this)
				}
			}
			expirationStrategy.useEntry(this, this.dPackMultiplier * (data || '').length)
		})
	}

	serializeEntryValue(version, object) {
		const encoder = createEncoder()
		encoder.encode(version)
		if (object)
			encoder.encode(object)
		return encoder.getEncoded()
	}

	static dbPut(key, value, version) {
		if (this.updatingProcessConnection) {
			throw new Error('No updates out of process')
		}

		if (typeof value != 'object') {
			value = Buffer.from(value.toString())
		}
		this.lastVersion = Math.max(this.lastVersion || 0, version || getNextVersion())
		if (value) {
			this.db.put(toBufferKey(key), value)
		} else {
			this.db.remove(toBufferKey(key))
		}
		let currentWriteBatch = this.currentWriteBatch
		if (!currentWriteBatch) {
			this.currentWriteBatch = setTimeout(() => {
				this.db.put(LAST_VERSION_IN_DB_KEY, Buffer.from(this.lastVersion.toString()))
				this.currentWriteBatch = null
			}, 20)
		}
	}

	valueOf() {
		let context = currentContext
		if (context && !this.allowDirectJSON && context.ifModifiedSince > -1) {
			context.ifModifiedSince = undefined
		}
		const whenUpdateProcessed = this._whenUpdateProcessed
		if (whenUpdateProcessed) {
			return whenUpdateProcessed.then(() => context ? context.executeWithin(() => super.valueOf(true)) : super.valueOf(true))
		}
		return when(this.constructor.whenUpdatedInContext(), () => context ? context.executeWithin(() => super.valueOf(true)) : super.valueOf(true))
	}

	/*gotValue(value) {
		let context = currentContext
		if (context && this.cachedVersion > -1) {
			context.expectedVersions[this.name] = this.cachedVersion
		}
	}*/

	clearCache() {
		this._cachedValue = undefined
		this.cachedVersion = -1
		if (this.readyState === 'up-to-date' || this.readyState === 'invalidated') {
			this.readyState = undefined
		}
	}
}

export class Persisted extends KeyValued(MakePersisted(Variable), {
	valueProperty: 'value',
	versionProperty: 'version'
}) {
	db: any
	static dbFolder = 'db'
	static resetAll(clearDb): any {
	}

	getValue() {
		if (!this.readyState)
			this.loadLatestLocalData()
		return super.getValue()
	}
	patch(properties) {
		return this.then((value) =>
			when(this.put(value = Object.assign(value || {}, properties)), () => value))
	}
	assignPreviousValue(event) {
		// for Persisted objects, we can use the event.oldValue
		let previousValues = event.previousValues
		if (!previousValues) {
			previousValues = event.previousValues = new Map()
		}
		previousValues.set(this, event.oldValue)
	}
	static DB = lmdb
	static syncVersion = 10
}

export default Persisted
export const Persistable = MakePersisted(Transform)

export class Cached extends KeyValued(MakePersisted(Transform), {
	valueProperty: 'cachedValue',
	versionProperty: 'cachedVersion'
}) {
	allowDirectJSON: boolean
	static Sources: any[]
	static fetchAllIds: () => {}[]

	computeValue() {
		return when(this.getValue(), () => null) // compute the value, but don't return anything, useful for the interprocess communication
	}

	getValue() {
		let context = currentContext
		if (!this.readyState)
			this.loadLatestLocalData()
		if (this.cachedVersion > -1 && this.readyState === 'up-to-date') {
			// it is live, so we can shortcut and just return the cached value
			if (context) {
				context.setVersion(this.cachedVersion)
				if (context.ifModifiedSince >= this.cachedVersion) {
					return NOT_MODIFIED
				}
			}
			return this.cachedValue
		}
		// if we don't have a cached version locally from the db, go to the updating process for transformation
		const updatingProcessConnection = this.constructor.updatingProcessConnection
		if (updatingProcessConnection) {
			return updatingProcessConnection.sendMessage({
				instanceId: this.id,
				method: 'computeValue',
			}).then(() => {
				// reset and try again to get it from the db
				this.readyState = null
				return context ? context.executeWithin(() => this.getValue()) : this.getValue()
			})
		}
		//else
		return super.getValue()
	}

	is(value, event) {
		// we skip loadLocalData and pretend it wasn't in the cache... not clear if
		// that is how we want is() to behave or not
		event = event || new ReplacedEvent()
		event.triggers = [ INITIALIZATION_SOURCE ]
		const updatingProcessConnection = this.constructor.updatingProcessConnection
		if (updatingProcessConnection) {
			this.whenUpdateProcessed = event.whenUpdateProcessed = updatingProcessConnection.sendMessage({
				instanceId: this.id,
				method: 'is',
				args: [value],
			})
		}
		event.source = this
		this.updated(event, this)
		this.cachedVersion = this.version
		if (!updatingProcessConnection) {
			this.cachedValue = value
		}
		this.readyState = 'up-to-date'
		return this
	}

	static resetAll(clearDb) {
		console.log('reset all for ', this.name)
		return Promise.resolve(spawn(function*() {
			let version = this.startVersion = getNextVersion()
			let allIds = yield this.fetchAllIds ? this.fetchAllIds() : []
			if (clearDb) {
				console.info('Closing the database to clear', this.name)
				let db = this.db
				yield db.clear()
				console.info('Cleared the database', this.name, 'rebuilding')
			}// else TODO: if not clearDb, verify that there are no entries; if there are, remove them
			for (let id of allIds) {
				if (this.instancesById.get(id)) {
					// instance already in memory
					this.for(id).updated()
					continue
				}
				const version = getNextVersion() // we give each entry its own version so that downstream indices have unique versions to go off of
				this.dbPut(id, this.prototype.serializeEntryValue(version), version)
			}
			console.info('Done reseting', this.name)
		}.bind(this)))
	}

	resetCache(event) {
		this._cachedValue = undefined
		this.cachedVersion = undefined
		let version = this.version
		if (this.shouldPersist !== false) {
//			if (!this.loaded || this.asDPack || oldJSON) { // maybe this might be a little faster if it is already invalidated
			// storing as a version alone to indicate invalidation
			this.constructor.dbPut(this.id, this.serializeEntryValue(version), version)
//			}
		}
	}

	getTransform() {
		return checkInputTransform
	}

	static get version() {
		if (this.Sources) {
			return Math.max(this._version || 1, ...(this.Sources.map(Source => Source.version)))
		} else {
			return this._version || 1
		}
	}
	static set version(version) {
		this._version = version
	}

	static from(...Sources: Array<Function | {notifies: () => any, for: (id: any) => any}>) {
		if (!Sources[0]) {
			throw new Error('No source provided')
		}
		class CachedFrom extends this {
			constructor(id) {
				super(id)
				for (let i = 0; i < Sources.length; i++) {
					this['source' + (i ? i : '')] = Sources[i].for(id)
				}
			}
			get checkSourceVersions() {
				return false
			}
		}
		for (let Source of Sources) {
			if (Source.returnsAsyncIterables) {
				this.returnsAsyncIterables
			}
		}
		CachedFrom.Sources = Sources
		return CachedFrom
	}

	static getInstanceIds(range) {
		if (!this.fetchAllIds && this.Sources && this.Sources[0] && this.Sources[0].getInstanceIds) {
			// if we don't know if we have all our ids, our source is a more reliable source of instance ids
			return this.Sources[0].getInstanceIds(range)
		}
		return super.getInstanceIds(range)
	}

	static initialize(sourceCode) {
		const registered = super.initialize(sourceCode)
		const updatingProcessConnection = this.updatingProcessConnection
		if (updatingProcessConnection) {
			// we don't reset from this process if there is an updating process
			return registered
		}
		return when(registered, () => {
			let receivedPendingVersion = []
			for (let Source of this.Sources || []) {
				let lastVersion = this.lastVersion
				receivedPendingVersion.push(Source.getInstanceIdsAndVersionsSince && Source.getInstanceIdsAndVersionsSince(lastVersion).then(ids => {
					if (ids.isFullReset) {
						return when(this.resetAll(lastVersion > 0), // clear the old db if there are any entries
							() => this.updateDBVersion())
					}
					//console.log('getInstanceIdsAndVersionsSince for', this.name, ids.length)
					let min = Infinity
					let max = 0
					for (let { id, version } of ids) {
						min = Math.min(version, min)
						max = Math.max(version, max)
						let event = new ReplacedEvent()
						event.triggers = [ INITIALIZATION_SOURCE ]
						this.for(id).updated(event)
					}
					//console.log('getInstanceIdsAndVersionsSince min/max for', this.name, min, max)
				}))
			}
			if (receivedPendingVersion.length > 0)
				return Promise.all(receivedPendingVersion)
		})
		return registered
	}

	static get whenProcessingComplete() {
		return this.Sources && Promise.all(this.Sources.map(Source => Source.whenProcessingComplete))
	}
}

type PermissionCheck = (source: any, session: any, action: string, args: Array<any>) => boolean | string

type Secured = {
	allow(...permissions: Array<PermissionCheck>): any
}

export function secureAccess<T>(Class: T): T & Secured {
	Class.allow = function(...permissions: Array<PermissionCheck>) {
		let Class = this
		let methodOverrides = {
			for(id) {
				let target = Class.for(id)
				return new Proxy(target, handler)
			},
			stopNotifies(target) {
				// skip permissions on this
				return this.stopNotifies(target)
			},
			isChecked() {
				return true
			}
		}
		let handler = {
			get(target, name) {
				let value = target[name]
				if (methodOverrides[name]) {
					return methodOverrides[name].bind(target)
				}
				if (typeof value === 'function') {
					return function() {
						let context = currentContext
						// create a new derivative context that includes the session, but won't
						// update the version/timestamp
						return context.newContext().executeWithin(() => {
							let awaitingListener, variable, isAsync = false
							const permitted = when(secureAccess.checkPermissions(permissions, target, name, Array.from(arguments)), (permitted) => {
								if (permitted !== true) {
									throw new AccessError('User does not have required permissions: ' + permitted + ' for ' + Class.name)
								}
							})
							const whenPermitted = () =>
								context.executeWithin(() => value.apply(target, arguments))
							if (permitted.then) {
								let result
								let whenFinished = permitted.then(() => {
									result = whenPermitted()
								})
								return {
									then: (onFulfilled, onRejected) =>
										whenFinished.then(() => {
											return onFulfilled(result)
										}, onRejected)
								}
							}
							return whenPermitted()
						})
					}
				} else {
					return value
				}
			}
		}
		return new Proxy(this, handler)
	}
	return Class
}

const checkInputTransform = {
	apply(instance, args) {
		// if the main input is undefined, treat as deleted object and pass on the undefined without running the transform
		if (args[0] === undefined && args.length > 0) {
			return
		}
		return instance.transform.apply(instance, args)
	}
}
secureAccess.checkPermissions = () => true
import { Reduced } from './Reduced'

export function setDBFolder(folderName) {
	if (typeof folderName === 'string') {
		Persisted.dbFolder = folderName
		Cached.dbFolder = folderName
		Persistable.dbFolder = folderName
	} else {
		Persisted.dbFolder = folderName.dbFolder
		Cached.dbFolder = folderName.cacheDbFolder
		Persistable.dbFolder = folderName.cacheDbFolder
	}
}
