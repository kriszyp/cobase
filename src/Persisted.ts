import { Transform, VPromise, VArray, Variable, spawn, currentContext, NOT_MODIFIED, getNextVersion, ReplacedEvent, DeletedEvent, AddedEvent, UpdateEvent, Context } from 'alkali'
import { createSerializer, serialize, parse, parseLazy, createParser, asBlock } from 'dpack'
import * as lmdb from './storage/lmdb'
import when from './util/when'
import WeakValueMap from './util/WeakValueMap'
import ExpirationStrategy from './ExpirationStrategy'
import * as fs from 'fs'
import * as crypto from 'crypto'
import Index from './KeyIndex'
import { AccessError, ConcurrentModificationError } from './util/errors'
import { toBufferKey, fromBufferKey } from 'ordered-binary'
import { Database, IterableOptions, OperationsArray } from './storage/Database'
//import { mergeProgress } from './UpdateProgress'
import { registerClass, addProcess } from './util/process'
import { DEFAULT_CONTEXT } from './RequestContext'

const expirationStrategy = ExpirationStrategy.defaultInstance
const instanceIdsMap = new WeakValueMap()
const DB_VERSION_KEY = Buffer.from([1, 1]) // table metadata 1
const LAST_VERSION_IN_DB_KEY = Buffer.from([1, 2]) // table metadata 2
const INITIALIZING_PROCESS_KEY = Buffer.from([1, 4])
const INITIALIZATION_SOURCE = 'is-initializing'
export const INVALIDATED_ENTRY = { state: 'invalidated'}
let globalDoesInitialization

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
		const isMultiProcess = true
		if (!isMultiProcess && this.readyState === 'up-to-date' && this._cachedValue) {
			return previousValues.set(this, this._cachedValue)
		}
		if (!previousValues.has(this))
			previousValues.set(this, this.loadLocalData())
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
		index.start()
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
		CachedWith.start()
		return CachedWith
	}

	transform(source) {
		return source
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

	static clearAllData() {
		let db = this.db
		db.transaction(() => {
			// we need to preserve the persistent metadata when we clear the db
			const allMeta = Array.from(db.iterable({
				start: Buffer.from([1, 0]),
				end: Buffer.from([1, 5]),
			}))
			db.clear()
			// restore the metadata
			for (const { key, value } of allMeta) {
				db.put(key, value)
			}
		})
		console.info('Cleared the database', this.name, 'rebuilding')
	}

	static register(sourceCode?: { id?: string, version?: number }) {
		// check the transform hash
		if (sourceCode) {
			let moduleFilename = sourceCode.id || sourceCode
			if (sourceCode.version) {
				// manually provide hash
				this.version = sourceCode.version
			} else if (typeof moduleFilename == 'string') {
				// create a hash from the module source
				this.version = fs.statSync(moduleFilename).mtime.getTime()
				let hmac = crypto.createHmac('sha256', 'cobase')
				hmac.update(fs.readFileSync(moduleFilename, { encoding: 'utf8' }))
			this.transformHash = hmac.digest('hex')
			}
		}
		return this.ready
	}

	static get doesInitialization() {
		return this._doesInitialization === undefined ? globalDoesInitialization : this._doesInitialization
	}
	static set doesInitialization(flag) {
		this._doesInitialization = flag
	}
	static initialize() {
		this.instancesById = new (this.useWeakMap ? WeakValueMap : Map)()
		const options = {}
		if (this.mapSize) {
			options.mapSize = this.mapSize
		}
		const db = this.prototype.db = this.db = Persisted.DB.open(this.dbFolder + '/' + this.name, options)
		clearTimeout(this._registerTimeout)
		if (global[this.name]) {
			throw new Error(this.name + ' already registered')
		}
		global[this.name] = this
		for (let Source of this.Sources || []) {
			Source.notifies(this)
		}
		this.instancesById.name = this.name
		let doesInitialization = true
		const processKey = Buffer.from([1, 3, process.pid >> 8, process.pid & 0xff])
		let initializingProcess
		db.transaction(() => {
			initializingProcess = db.get(INITIALIZING_PROCESS_KEY)
			initializingProcess = initializingProcess && +initializingProcess.toString()
			this.otherProcesses = Array.from(db.iterable({
				start: Buffer.from([1, 3]),
				end: INITIALIZING_PROCESS_KEY,
			}).map(({key, value}) => (key[2] << 8) + key[3])).filter(pid => !isNaN(pid))
			db.put(processKey, Buffer.from([])) // register process, in ready state
			if (!initializingProcess || !this.otherProcesses.includes(initializingProcess)) {
				initializingProcess = null
				db.put(INITIALIZING_PROCESS_KEY, Buffer.from(process.pid.toString()))
			}
		})
		this.lastVersion = +db.getSync(LAST_VERSION_IN_DB_KEY) || 0
		let stateDPack = db.getSync(DB_VERSION_KEY)
		let didReset
		let state = stateDPack && parse(stateDPack)
		if (this.name.match(/Scope/))
			console.log('DB starting state', this.name, state)
		if (state) {
			this.dbVersion = state.dbVersion
			this.startVersion = state.startVersion
		}
		registerClass(this)
		const doDataInitialization = () => {
			const whenFinished = () => {
				try {
					if (this.name.match(/Scope/))
						console.log('finished initialization for', this.name)
					delete global.openTransactions[this.name]
					db.remove(INITIALIZING_PROCESS_KEY)
				} catch (error) {
					console.warn(error.toString())
				}
			}
			try {
				return when(this.initializeData(), () => {
					this.updateDBVersion()
					whenFinished()
				}, (error) => {
					console.error(error)
					whenFinished()
				})
			} catch (error) {
				whenFinished()
				throw error
			}
		}
		for (const pid of this.otherProcesses) {
			addProcess(pid, this).catch(() => {
				let index = this.otherProcesses.indexOf(pid)
				if (index > -1) {
					this.otherProcesses.splice(index, 1)
					db.remove(Buffer.from([1, 3, pid >> 8, pid & 0xff]))
				}
				if (initializingProcess == pid) {
					let doInit
					db.transaction(() => {
						// make sure it is still the initializing process
						initializingProcess = db.get(Buffer.from([1, 4]))
						initializingProcess = initializingProcess && +initializingProcess.toString()
						if (initializingProcess == pid) {
							// take over the initialization process
							console.log('Taking over initialization of', this.name, 'from process', initializingProcess)
							db.put(INITIALIZING_PROCESS_KEY, Buffer.from(process.pid.toString()))
							doInit = true
						}
					})
					if (doInit) {
						doDataInitialization()
					}
				}
			})
		}
		// make sure these are inherited
		this.currentWriteBatch = null
		if (initializingProcess) {
			return
		}
		(global.openTransactions || (global.openTransactions = {}))[this.name] = true
		return doDataInitialization()
	}
	static initializeData() {
		const db = this.db
		if (this.dbVersion == this.version) {
			// update to date
		} else {
			console.log('transform/database version mismatch, reseting db table', this.name, this.dbVersion, this.version)
			this.startVersion = getNextVersion()
			const clearDb = !!this.dbVersion // if there was previous state, clear out all entries
			return when(this.resetAll(clearDb), () => clearDb)
		}
	}

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

	valueOf() {
		let context = currentContext
		if (context && !this.allowDirectJSON && context.ifModifiedSince > -1) {
			context.ifModifiedSince = undefined
		}
		const whenUpdateProcessed = this._whenUpdateProcessed
		if (whenUpdateProcessed) {
			return whenUpdateProcessed.then(() => context ? context.executeWithin(() => super.valueOf(true)) : super.valueOf(true))
		}
		return when(this.constructor.whenUpdatedInContext(context), () => context ? context.executeWithin(() => super.valueOf(true)) : super.valueOf(true))
	}

	gotValue(value) {
		// bypass any variable checks, since the data is coming from a DB
		return value
	}
	updated(event = new ReplacedEvent(), by?) {
		if (!event.visited) {
			event.visited = new Set() // TODO: Would like to remove this at some point
		}
		if (!event.source) {
			event.source = this
		}
		let context = currentContext
		if (context && !event.triggers && context.connectionId) {
			event.triggers = [ context.connectionId ]
		}

		let Class = this.constructor
		if (event.type === 'added') {
			// if we are being notified of ourself being created, ignore it
			this.constructor.instanceSetUpdated(event)
			if (this.readyState === 'loading-local-data') {
				return event
			}
			if (this.cachedVersion > -1) {
				return event
			}
		}
		this._initUpdate(event)

		if (Class.updateWithPrevious) {
			if (true/* isMultiProcess */) {
				this.constructor.db.transaction(() => {
					this.assignPreviousValue(event)
					this.resetCache(event)
				})
			}
		} else
			this.resetCache(event)
		if (event.type == 'deleted') {
			this.readyState = 'no-local-data'
			this._cachedValue = undefined
			this._cachedVersion = undefined
			this.constructor.instanceSetUpdated(event)
		}
		if (by === this) // skip reset
			Variable.prototype.updated.apply(this, arguments)
		else
			super.updated(event, by)
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

	resetCache(event) {
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
		this.db.put(DB_VERSION_KEY, serialize({
			startVersion: version,
			dbVersion: this.version
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

	loadLocalData() {
		let Class = this.constructor
		let db = Class.db
		return this.parseEntryValue(Class.db.get(toBufferKey(this.id)))
	}

	parseEntryValue(buffer) {
		if (buffer) {
			const parser = createParser()
			parser.setSource(buffer.slice(0,24).toString(), 0)  // the lazy version only reads the first fews bits to get the version
			const version = parser.read()
			if (parser.hasMoreData()) {
				const valueBuffer = buffer.slice(parser.getOffset())
				if (valueBuffer.length === 1) {
					// probably undefined, but either way, might as well do the parsing immediately
					return {
						version,
						data: parser.read(),
						buffer,
					}
				}
				return {
					version,
					data: parseLazy(valueBuffer, parser),
					buffer,
				}
			} else {
				// stored as an invalidated version
				return {
					version,
					data: INVALIDATED_ENTRY,
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
		let promise = when(this.loadLocalData(), (entry) => {
			const { version, data, buffer } = entry
			if (isSync === undefined)
				isSync = true
			else
				this.promise = null
			if (data && data !== INVALIDATED_ENTRY) {
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
			}			return entry
		})
		if (isSync)
			return promise
		isSync = false
		return this.promise = promise
	}

	static getInstanceIds(range: IterableOptions) {
		let db = this.db
		let options: IterableOptions = {
			start: Buffer.from([4]),
			values: false
		}
		if (range) {
			if (range.start != null)
				options.start = toBufferKey(range.start)
			if (range.end != null)
				options.end = toBufferKey(range.end)
		}
		return db.iterable(options).map(({ key }) => fromBufferKey(key)).asArray
	}

	static entries(opts) {
		let db = this.db
		return db.iterable({
			start: Buffer.from([2])
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
			if (this.name === 'Scope')
				console.log('Scanning for updates from', sinceVersion, this.startVersion, this.lastVersion, isFullReset, this.name)
			if (this.lastVersion && this.lastVersion <= sinceVersion && !isFullReset) {
				return []
			}
			const parser = createParser()
			return db.iterable({
				start: Buffer.from([10])
			}).map(({ key, value }) => {
				try {
					const { version } = this.prototype.parseEntryValue(value)
					return version > sinceVersion ? {
						id: fromBufferKey(key),
						version
					} : null
				} catch (error) {
					console.error('Error reading data from table scan', this.name, fromBufferKey(key), error)
				}
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

	static remove(id, event?) {
		if (id > 0 && typeof id === 'string' || !id) {
			throw new Error('Id should be a number or non-numeric string: ' + id)
		}

		event || (event = new DeletedEvent())
		let entity = this.for(id)
		entity.assignPreviousValue(event)
		// TODO: Don't need to delete for cached entries, as it will be done in the event handler
		this.dbPut(id) // do the db level delete
		expirationStrategy.deleteEntry(entity)
		this.instancesById.delete(id)
		entity.updated(event)
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
				this._cachedValue = value = asBlock(value)
				data = this.serializeEntryValue(version, value)
				Class.dbPut(this.id, data, version/*, (oldEntry) => {
					// the check version so it will only write if the version matches (in case another process modified it) or it is new entry
					const { data, version: oldVersion } = this.parseEntryValue(oldEntry)
					if (data !== INVALIDATED_ENTRY || version == oldVersion || newToCache) {
						return true // ok
					} else {
						/*
						let event = new ReplacedEvent() //IncomingEvent()
						event.triggers = [ INITIALIZATION_SOURCE ]
						event.source = this
						event.version = version
						Class.updated(event, this)
					}
				}*/)
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
		const serializer = createSerializer()
		serializer.serialize(version)
		if (object !== INVALIDATED_ENTRY)
			serializer.serialize(object)
		return serializer.getSerialized()
	}

	static dbPut(key, value, version, checkVersion) {
		if (typeof value != 'object' && value) {
			value = Buffer.from(value.toString())
		}
		const db = this.db
		this.lastVersion = Math.max(this.lastVersion || 0, version || getNextVersion())
		const processKey = Buffer.from([1, 3, process.pid >> 8, process.pid & 0xff])
		if (!this.isWriting) {
			db.put(processKey, Buffer.from(this.lastVersion.toString()))
			this.isWriting = true
		}
		db.transaction(() => {
			const keyAsBuffer = toBufferKey(key)
			if (checkVersion) {
				if (!checkVersion(db.get(keyAsBuffer)))
					return // don't write if the check version doesn't match.
			}
			if (value) {
				db.put(keyAsBuffer, value)
			} else {
				db.remove(keyAsBuffer)
			}
		})
		let currentWriteBatch = this.currentWriteBatch
		if (!currentWriteBatch) {
			this.currentWriteBatch = setTimeout(() => {
				db.put(processKey, Buffer.from([]))
				this.isWriting = false
				db.put(LAST_VERSION_IN_DB_KEY, Buffer.from(this.lastVersion.toString()))
				this.currentWriteBatch = null
			}, 20)
		}
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
		return when(super.getValue(), (value) => this._cachedValue || value) // we use the cached value, since it should be a dpack block
	}
	patch(properties) {
		return this.then((value) =>
			when(this.put(value = Object.assign(value || {}, properties)), () => value))
	}
	put(value, event) {
		let newToCache = !this.getValue()
		event = event || (newToCache ? new AddedEvent() : new ReplacedEvent())
		event.source = this
		this.assignPreviousValue(event)
		this.readyState = 'up-to-date'
		let result = super.put(value, event)
		if (newToCache) {
			this.constructor.instanceSetUpdated(event)
		}
		return result
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
		return when(super.getValue(), (value) => this._cachedValue || value) // we use the cached value, since it should be a dpack block
	}

	is(value, event) {
		// we skip loadLocalData and pretend it wasn't in the cache... not clear if
		// that is how we want is() to behave or not
		event = event || new ReplacedEvent()
		event.triggers = [ INITIALIZATION_SOURCE ]
		event.source = this
		this.updated(event, this)
		this.cachedVersion = this.version
		this.cachedValue = value
		this.readyState = 'up-to-date'
		return this
	}

	static resetAll(clearDb) {
		console.log('reseting', this.name)
		return Promise.resolve(spawn(function*() {
			let version = this.startVersion = getNextVersion()
			let allIds = yield this.fetchAllIds ? this.fetchAllIds() : []
			if (clearDb) {
				this.clearAllData()
			}// else TODO: if not clearDb, verify that there are no entries; if there are, remove them
			for (let id of allIds) {
				if (this.instancesById.get(id)) {
					// instance already in memory
					this.for(id).updated()
					continue
				}
				const version = getNextVersion() // we give each entry its own version so that downstream indices have unique versions to go off of
				this.dbPut(id, this.prototype.serializeEntryValue(version, INVALIDATED_ENTRY), version)
			}
			console.info('Cleared', this.name)
		}.bind(this)))
	}

	resetCache(event) {
		this._cachedValue = undefined
		this.cachedVersion = undefined
		let version = this.version
		const Class = this.constructor
		if (this.shouldPersist !== false &&
			!(event && event.sourceProcess && // if it came from another process we can count on it to have written the update, check to make sure it is running against this table
				(Class.otherProcesses.includes(event.sourceProcess) || // another process should be able to handle this
					Class.otherProcesses.some(otherProcessId => otherProcessId < process.pid) // otherwise, defer to the lowest number process to handle it
				))) {
			// storing as a version alone to indicate invalidation
			if (event && event.type === 'deleted') {
				// completely empty entry for deleted items
				Class.dbPut(this.id)
			} else {
				Class.dbPut(this.id, this.serializeEntryValue(version, INVALIDATED_ENTRY), version)
			}
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

	static initializeData() {
		const initialized = super.initializeData()
		return when(initialized, () => {
			let receivedPendingVersion = []
			let isFullReset
			let clearDb
			for (let Source of this.Sources || []) {
				let lastVersion = this.lastVersion

				receivedPendingVersion.push(Source.getInstanceIdsAndVersionsSince && Source.getInstanceIdsAndVersionsSince(lastVersion).then(ids => {
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
			if (receivedPendingVersion.length > 0) {
				return Promise.all(receivedPendingVersion)
			}
		})
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

export function configure(options) {
	Persisted.dbFolder = options.dbFolder
	Cached.dbFolder = options.cacheDbFolder || options.dbFolder
	Persistable.dbFolder = options.cacheDbFolder || options.dbFolder
	globalDoesInitialization = options.doesInitialization
}
