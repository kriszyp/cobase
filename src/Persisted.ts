import * as alkali from 'alkali';
const { Transform, VPromise, VArray, Variable, spawn, currentContext, NOT_MODIFIED, getNextVersion, ReplacedEvent, DeletedEvent, AddedEvent, UpdateEvent, Context } = alkali.Variable ? alkali : alkali.default
import { open, compareKey } from 'lmdb'
import when from './util/when.js'
import { WeakValueMap } from './util/WeakValueMap.js'
import ExpirationStrategy from './ExpirationStrategy.js'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { AccessError, ConcurrentModificationError, ShareChangeError } from './util/errors.js'
import { Database, IterableOptions, OperationsArray } from './storage/Database.js'
//import { mergeProgress } from './UpdateProgress'
import { registerClass, addProcess } from './util/process.js'
import { DEFAULT_CONTEXT, RequestContext } from './RequestContext.js'

let getCurrentContext = () => currentContext

const DEFAULT_INDEXING_DELAY = 20
const DEFAULT_INDEXING_CONCURRENCY = 20
const expirationStrategy = ExpirationStrategy.defaultInstance
const instanceIdsMap = new WeakValueMap()
const DB_VERSION_KEY = Buffer.from([1, 1]) // table metadata
const INITIALIZING_PROCESS_KEY = Buffer.from([1, 4])
// everything after 9 is cleared when a db is cleared
const SHARED_STRUCTURE_KEY = Buffer.from([1, 10])
const INITIALIZING_LAST_KEY = Buffer.from([1, 7])
const INITIALIZATION_SOURCE = 'is-initializing'
const DISCOVERED_SOURCE = 'is-discovered'
const SHARED_MEMORY_THRESHOLD = 1024
export const INVALIDATED_ENTRY = { state: 'invalidated'}
const INDEXING_MODE  = {}
const INVALIDATED_STATE = 1
const ONLY_COMMITTED = 1
const NO_CACHE = 2
const AS_SOURCE = {}
const EXTENSION = '.mdb'
const DB_FORMAT_VERSION = 0
const allStores = new Map()

export const ENTRY = Symbol('entry')

let globalDoesInitialization

global.cache = expirationStrategy // help with debugging

export interface IndexRequest {
	previousEntry?: any
	pendingProcesses?: number[]
	deleted?: boolean
	sources?: Set<any>
	version: number
	triggers?: Set<any>
	fromValues?: Map
	by?: any
	resolveOnCompletion?: Function[]
}
interface IndexEntryUpdate {
	sources: Set<any>
	triggers?: Set<any>
}

class InitializingIndexRequest implements IndexRequest {
	version: number
	constructor(version) {
		this.version = version
	}
	get triggers() {
		return INITIALIZATION_SOURCE_SET
	}
	get previousVersion() {
		return -1
	}
}

class InstanceIds extends Transform.as(VArray) {
	Class: any
	cachedValue: any
	cachedVersion: any
	transform() {
		return when(when(this.Class.resetProcess, () => this.Class.whenWritten), () => this.Class.getInstanceIds().asArray)
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
	static whenWritten: Promise<any>
	static dbFolder = 'cachedb'
	static db: Database
	db: Database
	repetitiveGets: boolean

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
		let sources = this.constructor.sources
		if (sources) {
			for (let i = 0; i < sources.length; i++) {
				this['source' + (i ? i : '')] = sources[i].for(id)
			}
		}
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
		let instance = instancesById.getValue(id)
		if (!instance) {
			instance = new this(id)
			instancesById.setValue(id, instance)
		}
		return instance
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

/*	static with(properties) {
		let DerivedClass = super.with(properties)
		DerivedClass.sources = [this]
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
					data[DerivedClass.sources[i].key] = propertySource
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
			let sourceIndex = Parent.sources.push(RelatedIndex) - 1
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
			let ParentSource = Parent.sources[0]
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
			this._ready = Promise.resolve(this.initialize())
			this._ready.then(() => {
				//console.log(this.name, 'is ready and initialized')
				this.initialized = true
			}, (error) => {
				console.error('Error initializing', this.name, error)
			})
		}
		return this._ready
	}

	static clearAllData() {
		let db = this.db
		let count = 0
		db.transactionSync(() => {
			db.clear()
		})
		console.debug('Cleared the database', this.name, ', rebuilding')
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
	static initializeRootDB() {
		const db = this.rootDB
		this.rootStore = this

		// TODO: Might be better use Buffer.allocUnsafeSlow(6)
		const processKey = this.processKey = Buffer.from([1, 3, (process.pid >> 24) & 0xff, (process.pid >> 16) & 0xff, (process.pid >> 8) & 0xff, process.pid & 0xff])
		let initializingProcess
		db.transactionSync(() => {
			initializingProcess = db.get(INITIALIZING_PROCESS_KEY)
			initializingProcess = initializingProcess && +initializingProcess.toString()
			this.otherProcesses = Array.from(db.getRange({
				start: Buffer.from([1, 3]),
				end: INITIALIZING_PROCESS_KEY,
			}).map(({key, value}) => (key[2] << 24) + (key[3] << 16) + (key[4] << 8) + key[5])).filter(pid => !isNaN(pid))
			db.putSync(processKey, '1') // register process, in ready state
			if ((!initializingProcess || !this.otherProcesses.includes(initializingProcess)) && this.doesInitialization !== false) {
				initializingProcess = null
				db.putSync(INITIALIZING_PROCESS_KEY, process.pid.toString())
			}
			if (this.otherProcesses.includes(process.pid)) {
				//console.warn('otherProcesses includes self')
				this.otherProcesses.splice(this.otherProcesses.indexOf(process.pid))
			}
		})
		this.initializingProcess = initializingProcess
		this.whenUpgraded = Promise.resolve()
		const waitForUpgraded = () => {
			let whenUpgraded = this.whenUpgraded
			whenUpgraded.then(() => setTimeout(() => {
				if (whenUpgraded == this.whenUpgraded)
					try {
						this.db.removeSync(INITIALIZING_PROCESS_KEY)
					} catch (error) {
						console.warn(error.toString())
					}
				else
					return waitForUpgraded()
			}), 10)
		}
		waitForUpgraded()
	}

	static getStructureVersion() {
		// default version handling is just to get the static version and hash with source versions, but this can be overriden with something
		// that gets this asynchronously or uses other logic
		let aggregateVersion = 0
		for (let Source of this.sources || []) {
			let version = Source.getStructureVersion && Source.getStructureVersion() || 0
			aggregateVersion = (aggregateVersion ^ version) * 1049011 + (aggregateVersion / 5555555 >>> 0)
		}
		return aggregateVersion ^ (this.version || 0)
	}
	static openDatabase() {
		const options = {
			compression: true,
			useFloat32: 3, // DECIMAL_ROUND
			sharedStructuresKey: SHARED_STRUCTURE_KEY,
			cache: true,
			noMemInit: true,
			useWritemap: false,
		}
		if (this.maxSharedStructures)
			options.maxSharedStructures = this.maxSharedStructures
		if (this.shouldShareStructure)
			options.shouldShareStructure = this.shouldShareStructure
		if (this.maxDbs)
			options.maxDbs = this.maxDbs
		if (this.useWritemap)
			options.useWritemap = this.useWritemap
		if (this.useFloat32)
			options.useFloat32 = this.useFloat32
		if (clearOnStart) {
			console.info('Completely clearing', this.name)
			options.clearOnStart = true
		}
		this.rootDB = open(this.dbFolder + '/' + this.name + EXTENSION, options)

		Object.assign(this, this.rootDB.get(DB_VERSION_KEY))
		this.prototype.db = this.db = this.openDB(this, { useVersions: true, cache: true })
		return true
	}

	static initialize() {
		this.instancesById = new (this.useWeakMap ? WeakValueMap : Map)()
		
		clearTimeout(this._registerTimeout)
		if (allStores.get(this.name)) {
			throw new Error(this.name + ' already registered')
		}
		if (!storesObject[this.name])
			storesObject[this.name] = this
		allStores.set(this.name, this)
		for (let Source of this.sources || []) {
			if (Source.start)
				Source.start()
			Source.notifies(this)
		}
		let isRoot = this.openDatabase()
		this.instancesById.name = this.name
		return when(this.getStructureVersion(), structureVersion => {
			this.expectedDBVersion = (structureVersion || 0) ^ (DB_FORMAT_VERSION << 12)
			if (isRoot)
				this.initializeRootDB()
			let initializingProcess = this.rootStore.initializingProcess
			const db = this.db
			registerClass(this)

			let whenEachProcess = []
			for (const pid of this.otherProcesses) {
				whenEachProcess.push(addProcess(pid, this).catch(() =>
					this.cleanupDeadProcessReference(pid, initializingProcess)))
			}
			// make sure these are inherited
			if (initializingProcess || this.doesInitialization === false) {
				// there is another process handling initialization
				return when(whenEachProcess.length > 0 && Promise.all(whenEachProcess), (results) => {
					console.debug('Connected to each process complete and finished reset initialization')
				})
			}
			return this.doDataInitialization()
		}, (error) => {
			console.error('Error getting database version', error)
		})
	}

	static doDataInitialization() {
		let whenThisUpgraded
		try {

			whenThisUpgraded = when(this.initializeData(), () => {
			}, (error) => {
				console.error('Error initializing database for', this.name, error)
			})
		} catch (error) {
			console.error(error)
			whenThisUpgraded = Promise.resolve()
		}
		this.rootStore.whenUpgraded = this.rootStore.whenUpgraded.then(() => whenThisUpgraded)
		return whenThisUpgraded
	}
	static cleanupDeadProcessReference(pid, initializingProcess) {
		// error connecting to another process, which means it is dead/old and we need to clean up
		// and possibly take over initialization
		let index = this.otherProcesses.indexOf(pid)
		const db = this.rootDB
		if (index > -1) {
			this.otherProcesses.splice(index, 1)
			let deadProcessKey = Buffer.from([1, 3, (pid >> 24) & 0xff, (pid >> 16) & 0xff, (pid >> 8) & 0xff, pid & 0xff])
			let invalidationState = db.get(deadProcessKey)
			if (this.doesInitialization !== false) {
				db.transactionSync(async () => {
					db.removeSync(deadProcessKey)
				})
			}
		}
		if (initializingProcess == pid && this.doesInitialization !== false) {
			let doInit
			db.transactionSync(() => {
				// make sure it is still the initializing process
				initializingProcess = db.get(Buffer.from([1, 4]))
				initializingProcess = initializingProcess && +initializingProcess.toString()
				if (initializingProcess == pid) {
					// take over the initialization process
//					console.log('Taking over initialization of', this.name, 'from process', initializingProcess)
					initializingProcess = process.pid
					db.putSync(INITIALIZING_PROCESS_KEY, initializingProcess.toString())
					doInit = true
					
				}
			})
			if (initializingProcess == process.pid) {
				return this.doDataInitialization()
			}
		}

	}

	static async reset() {
		if (this.sources && this.sources[0])
			this.sources[0].wasReset = false
		this.clearAllData()
		await this.resetAll()
		this.updateDBVersion()
		this.resumeQueue()
	}
	static async initializeData() {
		const db = this.db
		this.state = 'initializing data'
		//console.log('comparing db versions', this.name, this.dbVersion, this.expectedDBVersion)
		if (this.dbVersion == this.expectedDBVersion) {
			// up to date, all done
		} else {
			console.log('transform/database version mismatch, reseting db table', this.name, this.expectedDBVersion, this.dbVersion, this.version)
			this.wasReset = true
			this.startVersion = getNextVersion()
			const clearDb = !!this.dbVersion // if there was previous state, clear out all entries
			this.clearAllData()
			await this.resetAll()
			this.updateDBVersion()
		}
		let readyPromises = []
		for (let Source of this.sources || []) {
			readyPromises.push(Source.ready)
		}
		await Promise.all(readyPromises)
		this.resumePromise = this.resumeQueue() // don't wait for this, it has its own separate promise system
	}


	valueOf(mode) {
		return super.valueOf(mode || true)
	}

	getValue(mode) {
		return this.constructor.get(this.id, mode)
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
		let context = getCurrentContext()
		if (context && !event.triggers && context.connectionId) {
			event.triggers = [ context.connectionId ]
		}

		let Class = this.constructor as PersistedType
		super.updated(event, by)
		Class.updated(event, this) // main handling occurs here
		// notify class listeners too
		return event
	}

	static instanceSetUpdated(event) {
		let instanceIds = instanceIdsMap.getValue(this.name)
		if (instanceIds) {
			instanceIds.updated(event)
		}
	}

	static clearEntryCache(id) {
		let entryCache = this._entryCache
		if (entryCache) {
			let entry = entryCache.get(id)
			if (entry !== undefined) {
				expirationStrategy.deleteEntry(entry)
				entryCache.delete(id)
			}
		}
	}

	static invalidateEntry(id, event) {
		this.clearEntryCache(id)
	}

	static update(id, event) {
		// this an easier way to manually call the updated process
		return this.updated(new ReplacedEvent(), { id })
	}

	static updated(event = new ReplacedEvent(), by?) {
		if (!event.visited) {
			event.visited = new Set() // TODO: Would like to remove this at some point
		}
		if (event.visited.has(this)) {
			return event
		}
		event.visited.add(this)
		let context = getCurrentContext()
		if (context && !event.triggers && context.connectionId) {
			event.triggers = [ context.connectionId ]
		}

		if (event && !event.version) {
			event.version = getNextVersion()
		}
		let id = by && by.id
		let nextBy = {
			id,
			constructor: this
		}
		if (!event.source) {
			event.source = nextBy
		}
		if (event.type === 'discovered' || event.type === 'added' || event.type === 'deleted') {
			this.instanceSetUpdated(event)
		}
		if (event.type === 'reload-entry') {
			if (event.doUpdate && by.constructor == this)
				this.invalidateEntry(id, event, by)
		} else if (event.type === 'discovered') {
			// if we are being notified of ourself being created or directly set, ignore it
			// do nothing
		} else if (id) {
			this.invalidateEntry(id, event, by)
		}
		if (id) {
			let instance
			instance = this.instancesById.getValue(id)
			if (instance)
				instance.updated(event, nextBy)
		}
		for (let listener of this.listeners || []) {
			listener.updated(event, nextBy)
		}

		if (!context || !context.expectedVersions) {
			context = DEFAULT_CONTEXT
		}
		context.expectedVersions[this.name] = event.version
		const whenUpdateProcessed = event.whenUpdateProcessed
		if (whenUpdateProcessed) {
			this.whenUpdateProcessed = whenUpdateProcessed
		}

		return event
	}

	static saveDBVersions() {
		this.rootDB.putSync(DB_VERSION_KEY, {
			dbVersion: this.dbVersion,
			childStores: this.childStores && this.childStores.map && this.childStores.map(childStore => ({
				name: childStore.name,
				dbVersion: childStore.dbVersion,
			}))
		})
	}

	static updateDBVersion() {
		let version = this.startVersion
		this.dbVersion = this.expectedDBVersion
		console.debug('saving db version', this.name, this.dbVersion)
		this.rootStore.saveDBVersions()
		return version
	}

	notifies(target) {
		let context = getCurrentContext()
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
	static subscribedInstances: Map
	init() {
		if (!this.subscribedInstances) {
			this.subscribedInstances = new Map()
		}
		this.subscribedInstances.set(this.id, this)
		return super.init()
	}
	cleanup() {
		this.subscribedInstances.delete(this.id)
		return super.cleanup()		
	}

	static notifies(target) {
		let context = getCurrentContext()
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
	static whenUpdatedInContext(waitForIndexing) {
		// transitively wait on all sources that need to update to this version
		let promises = []
		for (let Source of this.sources || []) {
			let whenUpdated = Source.whenUpdatedInContext && Source.whenUpdatedInContext()
			if (whenUpdated && whenUpdated.then) {
				promises.push(whenUpdated)
			}
		}
		let whenReady
		if (promises.length > 1) {
			whenReady = Promise.all(promises)
		} else if (promises.length == 1) {
			whenReady = promises[0]
		}
		if (waitForIndexing) {
			let currentContext = getCurrentContext()
			let updateContext = (currentContext && currentContext.expectedVersions) ? currentContext : DEFAULT_CONTEXT
			return when(whenReady, () => this.whenIndexedAndCommitted)/*{
				if (updateContext.expectedVersions && updateContext.expectedVersions[this.name] > this.lastIndexedVersion && this.queue && this.queue.size > 0) {
					// if the expected version is behind, wait for processing to finish
					return this.requestProcessing(1) // up the priority
				}
			})*/
		}
		return whenReady
	}
	static get instanceIds() {
		let instanceIds = instanceIdsMap.getValue(this.name)
		if (!instanceIds) {
			instanceIdsMap.setValue(this.name, instanceIds = new InstanceIds())
			instanceIds.Class = this
		}
		return instanceIds
	}
	exclusiveLock(executeWithLock: () => any) {
		let promisedResult
		if (this.currentLock) {
			let context = getCurrentContext()
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

	static tryForQueueEntry(id, action) {
		this.lastIndexingId = id
		const onQueueError = async (error) => {
			let indexRequest = this.queue && this.queue.get(id) || {}
			let version = indexRequest.version
			if (error.isTemporary) {
				let retries = indexRequest.retries = (indexRequest.retries || 0) + 1
				this.state = 'retrying index in ' + retries * 1000 + 'ms'
				if (retries < (this.maxRetries || 1000)) {
					this.isRetrying = true
					await delay(retries * 1000)
					this.isRetrying = false
					//console.info('Retrying index entry', this.name, id, error)
					return this.tryForQueueEntry(id, action)
				} else {
					console.info('Too many retries', this.name, id, retries)
				}
			}
			if (indexRequest && indexRequest.version !== version) return // if at any point it is invalidated, break out, don't log errors from invalidated states
			console.warn('Error indexing', this.name, id, error)
			if (this.queue && this.queue.delete)
				this.queue.delete(id) // give up and delete it
		}
		try {
			let result = action(id)
			if (result && result.catch)
				return result.catch(error => onQueueError(error))
		} catch(error) {
			return onQueueError(error)
		}
	}

	static queue: Map<any, IndexRequest>
	static async processQueue(queue) {
		this.state = 'waiting to process queue'
		await this.ready
		this.state = 'processing'
		if (this.onStateChange) {
			this.onStateChange({ processing: true, started: true })
		}
		let cpuUsage = process.cpuUsage()
		let cpuTotalUsage = cpuUsage.user + cpuUsage.system
		let lastTime = Date.now()
		let concurrencyAdjustment = 1
		let niceAdjustment = 2
		try {
			queue = queue || this.queue
			let initialQueueSize = queue.size
			//currentlyProcessing.add(this)
			if (initialQueueSize > 100 || initialQueueSize == undefined) {
				console.log('Indexing', initialQueueSize || '', this.name, 'for', this.name)
			}
			let actionsInProgress = new Set()
			this.actionsInProgress = actionsInProgress
			let sinceLastStateUpdate = 0
			let lastTime = Date.now()
			let delayMs = 10
			let indexed = 0
			do {
				if (this.nice > 0)
					await delay(this.nice) // short delay for other processing to occur
				for (let [ id ] of queue) {
					if (queue.isReplaced)
						return
					sinceLastStateUpdate++
					this.state = 'indexing entry ' + id
					let now = Date.now()
					indexed++
					let desiredConcurrentRatio = actionsInProgress.size / Math.min(indexed, this.MAX_CONCURRENCY || DEFAULT_INDEXING_CONCURRENCY)
					delayMs = Math.min(Math.max(delayMs, 1) * (desiredConcurrentRatio + Math.sqrt(indexed)) / (Math.sqrt(indexed) + 1), (actionsInProgress.size + 4) * 100)
					if (this.isRetrying) {
						await delay(1000)
						delayMs = (delayMs + 10) * 2
					}
					this.delayMs = delayMs
					lastTime = now + delayMs
					let completion = this.forQueueEntry(id)
					if (completion && completion.then) {
						completion.id = id
						actionsInProgress.add(completion)
						completion.then(() => actionsInProgress.delete(completion))
					}

					if (sinceLastStateUpdate > (this.MAX_CONCURRENCY || DEFAULT_INDEXING_CONCURRENCY)) {
						// we have process enough, commit our changes so far
						this.averageConcurrencyLevel = ((this.averageConcurrencyLevel || 0) + actionsInProgress.size) / 2
						if (this.resumeFromKey) {// only update if we are actually resuming
							for (let last in actionsInProgress) {
								this.lastIndexingId = last.id
								break
							}
							this.resumeFromKey = this.lastIndexingId
						}
					}
					await delay(delayMs * desiredConcurrentRatio)
				}
				this.state = 'awaiting final indexing of ' + actionsInProgress.size
				await Promise.all(actionsInProgress) // then wait for all indexing to finish everything
			} while (queue.size > 0)
			await this.whenValueCommitted
			this.lastIndexedVersion = this.highestVersionToIndex
			if (initialQueueSize > 100 || initialQueueSize == undefined) {
				console.log('Finished indexing', initialQueueSize || '', 'for', this.name)
			}
		} catch (error) {
			console.warn('Error occurred in processing index queue for', this.name, error)
		}
		this.state = 'processed'
		if (this.onStateChange) {
			this.onStateChange({ processing: true, started: false })
		}
	}

	static forQueueEntry(id) {
		return this.tryForQueueEntry(id, () =>
			when(this.get(id, INDEXING_MODE), () => {
				let entry = this.db.cache.get(id)
				return when(entry && entry.whenIndexed, () => {
					if (this.queue)
						this.queue.delete(id)
				})
			}))
	}

	static requestProcessing(nice, queue) {
		// Indexing is performed one index at a time, until the indexing on that index is completed.
		// This is to prevent too much processing being consumed by the index processing,
		// and to allow dependent childStores to fully complete before downstream childStores start to
		// avoid thrashing from repeated changes in values
		if (this.whenProcessingThisComplete && !queue) {
			// TODO: priority increases need to be transitively applied
			this.nice = Math.min(this.nice, nice) // once started, niceness can only go down (and priority up)
		} else {
			this.nice = nice
			let whenUpdatesReadable
			this.state = 'pending'
			this.whenProcessingThisComplete = Promise.all((this.sources || []).map(Source =>
				Source.whenProcessingComplete)).then(() =>
				this.processQueue(queue)).then(() => {
					this.state = 'ready'
					this.whenProcessingThisComplete = null
					//for (const sourceName in processingSourceVersions) {
					//	sourceVersions[sourceName] = processingSourceVersions[sourceName]
					//}
					/*const event = new IndexingCompletionEvent()
					event.sourceVersions = sourceVersions
					event.sourceVersions[this.name] = lastIndexedVersion
					super.updated(event, this)*/
				})
			this.whenProcessingThisComplete.queue = queue
			//this.whenProcessingThisComplete.version = lastIndexedVersion
		}
		return this.whenProcessingThisComplete
	}

	static openDB(store, options?) {
		let db = store.db = this.rootDB.openDB(store.dbName || store.name, Object.assign({
			compression: true,
			useFloat32: 3, // DECIMAL_ROUND
			sharedStructuresKey: SHARED_STRUCTURE_KEY,
		}, options))
		store.rootDB = this.rootDB
		return db
	}
	static openChildDB(store, options?) {
		let db = this.openDB(store, options)
		let rootStore = store.rootStore = this.rootStore || this
		store.otherProcesses = rootStore.otherProcesses
		let index
		if (!rootStore.childStores) {
			rootStore.childStores = []
		}
		if (!this.indices) {
			this.indices = []
		}
		this.indices.push(store)
		rootStore.childStores.find((entry, i) => {
			if (entry.name == store.name) {
				index = i
				store.dbVersion = entry.dbVersion
				return true
			}
		})
		if (index > -1) {
			store.dbVersion = rootStore.childStores[index].dbVersion
			rootStore.childStores[index] = store
		} else {
			rootStore.childStores.push(store)
		}
		return store.db
	}

	static removeUnusedDBs() {
		let unusedDBs = new Set()
		for (let key of this.rootDB.getKeys({
			start: Buffer.from([2])
		})) {
			unusedDBs.add(key.toString())
		}
		for (let store of [this, ...(this.childStores || [])]) {
			unusedDBs.delete(store.dbName || store.name)
		}
		console.log('Removing unused dbs', Array.from(unusedDBs))
	}

	static async resumeQueue() {
		this.resumeFromKey = this.db.get(INITIALIZING_LAST_KEY)
		if (!this.resumeFromKey) {
			this.state = 'ready'
			this.resumePromise = undefined
			return
		}
		console.debug(this.name + ' Resuming from key ' + this.resumeFromKey)
		let idsToInitiallyIndex = this.getIdsFromKey(this.resumeFromKey)
		let db = this.db

		const beforeCommit = () => {
			if (this.resumeFromKey)
				db.put(INITIALIZING_LAST_KEY, this.resumeFromKey, 1)
		}
		db.on('beforecommit', beforeCommit)
		this.state = 'building'
		console.debug('Created queue for initial index build', this.name)
		this.initialIndexCount = 0
		await this.requestProcessing(30, idsToInitiallyIndex.map(id => {
			this.initialIndexCount++
			return [ id ]
		}))
		console.debug('Finished initial index build of', this.name)
		db.off('beforecommit', beforeCommit)
		this.resumeFromKey = null
		await db.remove(INITIALIZING_LAST_KEY)
		this.state = 'ready'
		this.resumePromise = undefined
	}

	static resetAll(): any {
	}
})

const KeyValued = (Base, { versionProperty, valueProperty }) => class extends Base {

	static childStores: {
		forValue: Function
		prepareCommit: Function
		lastUpdate: number
	}[]

	static get(id, mode?) {
		let context = getCurrentContext()
		let entry = this.db.getEntry(id, mode ? NO_CACHE : 0)
		if (entry) {
			if (context) {
				context.setVersion(entry.version)
				if (context.ifModifiedSince >= entry.version) {
					return NOT_MODIFIED
				}
			}
		} else {
			if (context) {
				let version = getNextVersion()
				context.setVersion(version)
			}
		}

		return entry && entry.value
	}

	static is(id, value, event) {
		let entry = this.db.getEntry(id, NO_CACHE)
		if (!event) {
			event = entry ? new ReplacedEvent() : new DiscoveredEvent()
		}
		event.triggers = [ DISCOVERED_SOURCE ]
		event.source = { constructor: this, id }
		event.version = getNextVersion()

		this.updated(event, { id, invalidate: false })
		if (entry) {
			entry.value = value
		} else {
			entry = {
				value,
			}
		}
		entry.version = event.version
		return this.saveValue(id, entry, event.version)
	}

	static saveValue(id, entry, version?) {
		this.highestVersionToIndex = Math.max(this.highestVersionToIndex || 0, version)
		let forValueResults = (this.indices && !entry.noIndex) ? this.indices.map(store => store.forValue(id, entry)) : []
		let promises = forValueResults.filter(promise => promise && promise.then)

		const readyToCommit = (forValueResults) => {
			if (entry.version !== version)
				return
			entry.abortables = null // indicate that this is no longer in process
			let conditionalVersion = entry.fromVersion
			let committed = this.whenValueCommitted = this.db.ifVersion(id, conditionalVersion, () => {
				// the whole set of writes for this entry and downstream indices are committed one transaction, conditional on the previous version
				for (let result of forValueResults) {
					if (result)
						result.commit()
				}
				let committed
				let value = entry.value
				//console.log('conditional header for writing transform ' + (value ? 'write' : 'delete'), id, this.name, conditionalVersion)
				if (value === undefined) {
					if (conditionalVersion === null) {
						// already an undefined entry, nothing to do (but clear out the transition)
						if (this.db.cache.getEntry(id) == entry && entry.version === version) {
							this.db.cache.delete(id)
							return
						}
					} else {
						this.whenWritten = committed = this.db.remove(id)
					}
				} else {
					this.whenWritten = committed = this.db.put(id, value, version)
				}
			})

			return committed.then((successfulWrite) => {
				//if (this.transitions.get(id) == transition && !transition.invalidating)
				//	this.transitions.delete(id)
				if (!successfulWrite) {
					this.db.cache.delete(id)
					let entry = this.db.getEntry(id)
					console.debug('unsuccessful write of transform, data changed, updating', id, this.name, version, conditionalVersion, entry && entry.version)
					let event = new ReloadEntryEvent()
					if (entry && entry.version >= version) {
						event.version = entry.version
					} else {
						event.doUpdate = true
						event.version = version
					}
					this.updated(event, { id, constructor: this })
				}
			})
		}
		let whenIndexedAndCommitted
		if (promises.length == 0)
			whenIndexedAndCommitted = readyToCommit(forValueResults)
		else
			whenIndexedAndCommitted = (entry.whenIndexed = Promise.all(forValueResults)).then(readyToCommit)
		entry.committed = whenIndexedAndCommitted
		return whenIndexedAndCommitted
	}

	static reads = 0
	static cachedReads = 0

	static getInstanceIds(range: IterableOptions) {
		let db = this.db
		range = range || {}
		range.start = range.start || true
		range.values = false
		if (range.waitForAllIds && this.ready) {
			delete range.waitForAllIds
			return when(this.ready, () => this.getInstanceIds(range))
		}
		let iterable = db.getRange(range)
		return iterable
	}

	static entries(range) {
		let db = this.db
		return when(this.ready, () => {
			let results = db.getRange(Object.assign({
				start: true,
				versions: true,
			}, range))
			return range && range.asIterable ? results : results.asArray
		})
	}

	/**
	* Iterate through all instances to find instances since the given version
	**/
	static getIdsFromKey(startKey): number[] {
		//console.log('getInstanceIdsAndVersionsSince', this.name, sinceVersion)
		return this.db.getRange({
			start: startKey,
			snapshot: false,
			values: false,
		})
	}

	static dataVersionBuffer: Buffer
	static processKey: Buffer
	static lastIndexedVersion: int

	static remove(id, event?) {
		if (id > 0 && typeof id === 'string' || !id) {
			throw new Error('Id should be a number or non-numeric string: ' + id)
		}
		
		return this.updated(event || (event = new DeletedEvent()), { id }).whenWritten
	}

	setValue(value) {
		this.constructor.is(this.id, value)
	}

}

export const PersistedBase = KeyValued(MakePersisted(Variable), {
	valueProperty: 'value',
	versionProperty: 'version'
})

export class Persisted extends PersistedBase {
	db: any
	static dbFolder = 'db'

	static clearAllData() {
	}

	static set(id, value, event) {
		return this.is(id, value, event)
	}

	patch(properties) {
		return this.then((value) => {
			return when(this.put(value = Object.assign({}, value, properties)), () => value)
		})

	}
	put(value, event) {
		return this.constructor.is(this.id, value, event)
	}
	static syncVersion = 10
}

export default Persisted
export const Persistable = MakePersisted(Transform)
interface PersistedType extends Function {
	otherProcesses: any[]
	instanceSetUpdated(event): any
	updated(event, by): any
	db: any
	indices: []
	listeners: Function[]
}

export class Cached extends KeyValued(MakePersisted(Transform), {
	valueProperty: 'cachedValue',
	versionProperty: 'cachedVersion'
}) {
	allowDirectJSON: boolean
	static sources: any[]
	static fetchAllIds: () => {}[]

	static get(id, mode?) {
		let context = getCurrentContext()
		return when(this.whenUpdatedInContext(), () => {
			let entry = this.db.getEntry(id, mode ? NO_CACHE : 0)
			if (entry) {
				if (!entry.value) { // or only undefined?
					let abortables = entry.abortables
					//console.log('Running transform on invalidated', id, this.name, this.createHeader(entry[VERSION]), oldTransition)
					this.runTransform(id, entry, mode)
					/*if (abortables) {
						// if it is still in progress, we can abort it and replace the result
						//oldTransition.replaceWith = transition.value
						for (let abortable of abortables) {
							abortable()
						}
					}*/
					return entry.value
				}
				if (context) {
					context.setVersion(entry.version)
					if (context.ifModifiedSince >= entry.version) {
						return NOT_MODIFIED
					}
				}
				when(entry.value, (result) => deepFreeze)
				return entry.value
			}
			let version = getNextVersion()
			if (context)
				context.setVersion(version)
			entry = { version }
			entry = this.runTransform(id, entry, mode)
			when(entry.value, (result) => {
				if (result !== undefined && !entry.invalidating) {
					deepFreeze(result, 0)
					let event = new DiscoveredEvent()
					event.triggers = [ DISCOVERED_SOURCE ]
					event.source = { constructor: this, id }
					event.version = version
					this.instanceSetUpdated(event)
					this.updated(event, {
						id,
						constructor: this
					})
				}
			})
			return entry.value
		})
	}
	static whenValueCommitted: Promise<any>
	static runTransform(id, entry, mode) {
		let version = entry.version
		if (!entry.abortables)
			entry.abortables = []
		/*entry = {
			version,
			previousValue: entry.previousValue,
			abortables: []
		}*/
		let cache = this.db.cache
		cache.set(id, entry, -1) // enter in cache without LRFU tracking, keeping it in memory, this should be entered into LRFU once it is committed by the lmdb-store caching store logic
		const removeTransition = () => {
			if (cache.get(id) === entry && !entry.invalidating)
				cache.delete(id)
		}
		let hasPromises
		let inputData = this.sources ? this.sources.map(source => {
			let data = source.get(id, AS_SOURCE)
			if (data && data.then) {
				hasPromises = true
			}
			return data
		}) : []
		try {
			entry.value = when(when(hasPromises ? Promise.all(inputData) : inputData, inputData => {
				if (inputData.length > 0 && inputData[0] === undefined && !this.sourceOptional) // first input is undefined, we pass through
					return
				let context = getCurrentContext()
				let transformContext = context ? context.newContext() : new RequestContext(null, null)
				transformContext.abortables = entry.abortables
				inputData.push(id)
				return this.prototype.transform ? transformContext.executeWithin(() => this.prototype.transform.apply({ id }, inputData)) : inputData
			}), result => {
				if (entry.version != version) {
					if (entry.replaceWith) {
						return entry.replaceWith
					}
					return result
				} // else normal transform path
				entry.value = result
				this.saveValue(id, entry, version)
				return result
			}, (error) => {
				removeTransition()
				if (error.__CANCEL__) {
					return entry.replaceWith
				}
				throw error
			})
		} catch (error) {
			removeTransition()
			throw error
		}
		return entry
	}

	getValue() {
		return this.constructor.get(this.id)
	}
	is(value, event) {
		// we skip getEntryData and pretend it wasn't in the cache... not clear if
		// that is how we want is() to behave or not
		this.constructor.is(this.id, value, event)
		return this
	}

	static openChildDB(store, options) {
		if (!this.queue) {
			this.queue = new Map()
		}
		return super.openChildDB(store, options)
	}



	static updated(event, by?) {
		let id = by && (typeof by === 'object' ? by.id : by) // if we are getting an update from a source instance
		event = super.updated(event, by)
		if (this.queue) {
			if (by && by.constructor === this || // our own instances can notify us of events, ignore them
				this.otherProcesses && event.sourceProcess &&
				!(id && this.queue.has(id)) && // if it is in our queue, we need to update the version number in our queue
				(this.otherProcesses.includes(event.sourceProcess) || // another process should be able to handle this
					this.otherProcesses.some(otherProcessId => otherProcessId < process.pid))) { // otherwise, defer to the lowest number process to handle it
				// we can skip these (unless they are in are queue, then we need to update)
				return event
			}
			if (id && (event.type === 'discovered')) {
				this.enqueue(id, event)
			}
		}
		return event
	}

	static enqueue(id, event, previousEntry?) {
		if (this.resumeFromKey && compareKey(this.resumeFromKey, id) < 0) // during initialization, we ignore updates because we are going rebuild
			return
		const version = event.version
		// queue up processing the event
		let indexRequest = this.queue.get(id)

		if (indexRequest) {
			// put it at that end so version numbers are in order, but don't alter the previous state or version, that is still what we will be diffing from
			this.queue.delete(id)
			this.queue.set(id, indexRequest)
			indexRequest.version = version
			if (event.triggers)
				for (let trigger of event.triggers)
					indexRequest.triggers.add(trigger)
		} else {
			this.queue.set(id, indexRequest = {
				version: version,
				previousEntry,
				now: Date.now(),
				triggers: event.triggers instanceof Set ? event.triggers : new Set(event.triggers),
			})
			/*if (indexRequest.previousState == INVALIDATED_ENTRY) {
				indexRequest.fromValues = event.fromValues // need to have a shared map to update
				indexRequest.by = by
			}*/
			this.requestProcessing(DEFAULT_INDEXING_DELAY)
		}
		if (!version) {
			throw new Error('missing version')
		}
		indexRequest.deleted = event.type == 'deleted'
	}


	static async resetAll() {
		console.debug('reseting', this.name)
		let version = this.startVersion = 1
		let allIds = this.fetchAllIds ? await this.fetchAllIds() :
			(this.sources && this.sources[0] && this.sources[0].getInstanceIds) ?
				await this.sources[0].getInstanceIds({
					waitForAllIds: true,
				}) : []
		let committed
		let queued = 0
		console.log('loading ids for', this.name, 'with', allIds.length, 'ids')
		let idCount = 0
		for (let id of allIds) {
			idCount++
			if (this.instancesById.getValue(id)) {
				// instance already in memory
				this.for(id).updated()
				continue
			}
			this.lastVersion = version++ // we give each entry its own version so that downstream childStores have unique versions to go off of
			this.whenWritten = committed = this.db.put(id, 0, -version)
			if (queued++ > 2000) {
				console.log('writing block of ids')
				await this.whenWritten
				console.log('wrote block of ids')
				queued = 0
			}
		}
		console.log('loaded ids for', this.name, 'with', idCount, 'ids')
		return committed
	}

	static invalidateEntry(id, event, by) {
		let db = this.db
		let written
		if (event && event.sourceProcess) {
			// if it came from another process we can count on it to have written the update
			db.cache.delete(id) // clear from cache
			return
		}
		let version = event.version
		if (this.indices) {
			let entry = db.getEntry(id)
			if (entry) {
				db.cache.expirer.used(entry, -1) // key it pinned in memory
				if (!entry.abortables) { // if this entry is in a transform and not committed, don't update fromVersion
					entry.previousValue = entry.value
					entry.fromVersion = entry.version
					entry.abortables = []
				}
				entry.value = null // set as invalidated
				entry.version = version // new version
				// for deleted events, let the transform do the removal
			} else {
				entry = {
					version,
					abortables: [],
				}
				db.cache.set(id, entry, -1) // enter in cache without LRFU tracking, keeping it in memory
			}
			if (event.noIndex)
				entry.noIndex = true
			if (!by || by.invalidate !== false) {
				written = this.forQueueEntry(id).then(() => entry.committed)
				let lastCompletion = this.whenIndexedAndCommitted = (this.whenIndexedAndCommitted ?
					Promise.all([this.whenIndexedAndCommitted, written]) : written).then(() => {
						if (this.whenIndexedAndCommitted == lastCompletion)
							this.whenIndexedAndCommitted = null
					})
			}
		} else {
			if (event && event.type === 'deleted') {
				// completely empty entry for deleted items
				written = db.remove(id)
			} else if (!by || by.invalidate !== false) {
				written = db.put(id, null, version)
			}
		}
		this.whenWritten = written
		if (!event.whenWritten)
			event.whenWritten = written
	}

	static async receiveRequest({ id, waitFor }) {
		if (waitFor == 'get') {
			console.log('waiting for entity to commit', this.name, id)
			this.clearEntryCache(id)
			await this.get(id)
			let entry = this.db.getEntry(id)
			if (entry) {
				// wait for get to truly finish and be committed
				await entry.whenIndexed
				await entry.committed
			}
			// return nothing, so we don't create any overhead between processes
		}
	}

	static _version: number
	static get version() {
		if (this.sources) {
			return this.sources.reduce((sum, Source) => sum += (Source.version || 0), this._version)
		} else {
			return this._version || 1
		}
	}
	static set version(version) {
		this._version = version
	}
	static returnsAsyncIterables: boolean

	static from(...sources: Array<Function & {notifies: () => any, for: (id: any) => any, returnsAsyncIterables: boolean}>) {
		if (!sources[0]) {
			throw new Error('No source provided')
		}
		let Cached = class extends this {
			get checkSourceVersions() {
				return false
			}
		}
		for (let Source of sources) {
			if (Source.returnsAsyncIterables) {
				this.returnsAsyncIterables
			}
		}
		Cached.sources = sources
		return Cached
	}
	static derivedFrom(...sources: Array<Persisted | Function | {}>) {
		for (let source of sources) {
			if (source.notifies) {
				if (!this.sources)
					this.sources = []
				this.sources.push(source)
			} else if (typeof source === 'function') {
				this.prototype.transform = source
			} else {
				Object.assign(this, source)
			}
		}
		this.start()
	}

	static getInstanceIds(range) {
		if (!this.fetchAllIds && this.sources && this.sources[0] && this.sources[0].getInstanceIds) {
			// if we don't know if we have all our ids, our source is a more reliable source of instance ids
			return this.sources[0].getInstanceIds(range)
		}
		return super.getInstanceIds(range)
	}

	static updateDBVersion() {
		if (this.indices) {
			console.debug('Setting up indexing for', this.name)
			this.resumeFromKey = true
			this.db.putSync(INITIALIZING_LAST_KEY, true)
		}
		super.updateDBVersion()
	}

	static get whenProcessingComplete() {
		return this.sources && Promise.all(this.sources.map(Source => Source.whenProcessingComplete))
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
						let context = getCurrentContext()
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

class DiscoveredEvent extends AddedEvent {
	type
}
DiscoveredEvent.prototype.type = 'discovered'

class ReloadEntryEvent extends ReplacedEvent {
	type
}
ReloadEntryEvent.prototype.type = 'reload-entry'

export function getCurrentStatus() {
	function estimateSize(size, previousState) {
		return (previousState ? JSON.stringify(previousState).length : 1) + size
	}
	return Array.from(allStores.values()).map(store => ({
		name: store.name,
		indexed: store.initialIndexCount,
		queueSize: store.queue && store.queue.size,
		size: global.skipDBStats ? 0 : store.db.getStats().entryCount,
		state: store.state,
		concurrencyLevel: store.actionsInProgress ? store.actionsInProgress.size : 0,
		//pendingRequests: Array.from(Index.pendingRequests),
	}))
}

secureAccess.checkPermissions = () => true

let clearOnStart
let sharedStructureDirectory
let sharedInstrumenting
let verboseLogging
let storesObject = global
export function configure(options) {
	Persisted.dbFolder = options.dbFolder
	Cached.dbFolder = options.cacheDbFolder || options.dbFolder
	Persistable.dbFolder = options.cacheDbFolder || options.dbFolder
	globalDoesInitialization = options.doesInitialization
	verboseLogging = options.verboseLogging
	clearOnStart = options.clearOnStart
	if (options.storesObject) {
		storesObject = options.storesObject
	}
	if (options.getCurrentContext)
		getCurrentContext = options.getCurrentContext
	if (options.sharedStructureDirectory)
		sharedStructureDirectory = options.sharedStructureDirectory
	if (options.sharedInstrumenting) {
		sharedInstrumenting = true
		console.warn('sharedInstrumenting is turned on!!!!!!!')
	}
}
export function writeCommonStructures() {
	let wrote = []
	for (let [name, store] of allStores) {
		if (store.writeCommonStructure())
			wrote.push(name)
	}
	return wrote
}

export class Invalidated {
	constructor(version, processId?) {
		this.version = version
		this.value = processId
	}
	version: number
	value: number
}
const delay = ms => new Promise(resolve => ms >= 1 ? setTimeout(resolve, ms) : setImmediate(resolve))
const primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199]
let deepFreeze = process.env.NODE_ENV == 'development'  ? (object, depth) => {
	if (depth > 100)
		throw new Error('Max object depth exceeded or circular reference in data')
	if (object && typeof object == 'object') {
		if (object.constructor == Object) {
			for (let key in object) {
				let value = object[key]
				if (typeof value == 'object')
					deepFreeze(value, (depth || 0) + 1)
			}
		} else if (object.constructor == Array) {
			for (let i = 0, l = object.length; i < l; i++) {
				let value = object[i]
				if (typeof value == 'object')
					deepFreeze(value, (depth || 0) + 1)
			}
		}
	}
	return object
} : (object) => object
import Index from './KeyIndex.js'
